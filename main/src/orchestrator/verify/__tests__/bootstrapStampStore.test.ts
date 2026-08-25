/**
 * Unit tests for RunbookBootstrapStampStore + migration 108
 * (docs/proposals/lane-runbook-bootstrap.md §9).
 *
 * The stamp is a LOCK and a RESUME CURSOR at the same time, and the two roles
 * have opposite failure modes:
 *
 *   - as a lock, the sin is letting two lanes both believe they own it. Five
 *     sprint lanes reach visual-verify at unpredictable moments in one worktree,
 *     and `registerDraft` UPSERTs a singleton record — two owners means two
 *     derivations over one row, each proving a revision the other replaced.
 *   - as a cursor, the sin is locking out the OWNER. The controller restarts
 *     lanes at inner step zero on resume, so the owner comes back; a lock that
 *     excluded it would strand its own run holding a claim nobody can advance.
 *
 * So `claim()` is tested for both directions, and `advance()` is tested for the
 * one property the ≤2-round retry depends on: patching a field must not clear
 * the ones it does not mention.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunbookBootstrapStampStore } from '../bootstrapStampStore';
import type { DatabaseLike } from '../../types';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

/**
 * `mig109` is a separate axis on purpose. Migration 109 adds the rung-1 columns
 * this store now reads and writes, and a 106-only DB is a REAL deployment state
 * — the one every binary is in between the two migrations landing. Both are
 * exercised below: the store must degrade to "no rung-1 edit" rather than losing
 * the whole stamp, because losing the stamp loses the resume cursor.
 */
function buildDb(withMigration = true, mig109 = true): Database.Database {
  const db = new Database(':memory:');
  if (withMigration) {
    db.exec(readFileSync(join(MIG_DIR, '108_runbook_bootstrap_stamp.sql'), 'utf-8'));
    if (mig109) db.exec(readFileSync(join(MIG_DIR, '109_runbook_bootstrap_suppression.sql'), 'utf-8'));
  }
  return db;
}

function makeStore(db: Database.Database): RunbookBootstrapStampStore {
  return new RunbookBootstrapStampStore(db as unknown as DatabaseLike);
}

const KEY = { runId: 'run-1', projectId: 1, modality: 'web' as const };

describe('migration 108', () => {
  it('creates the stamp table keyed (run_id, project_id, modality)', () => {
    const db = buildDb();
    const pk = (db.prepare('PRAGMA table_info(verify_runbook_bootstrap)').all() as Array<{
      name: string;
      pk: number;
    }>)
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['run_id', 'project_id', 'modality']);
    db.close();
  });

  it('is idempotent (CREATE TABLE IF NOT EXISTS), unlike the ALTER-based files', () => {
    const db = buildDb();
    expect(() => db.exec(readFileSync(join(MIG_DIR, '108_runbook_bootstrap_stamp.sql'), 'utf-8'))).not.toThrow();
    db.close();
  });

  it('refuses a state outside the five the resume cursor understands', () => {
    // A hand-edited sixth value would be read as an unknown cursor position,
    // and the recovery path would have no defined step to resume from.
    const db = buildDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO verify_runbook_bootstrap (run_id, project_id, modality, owner_task_ref, state)
           VALUES ('r', 1, 'web', 'TASK-1', 'halfway')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });
});

describe('RunbookBootstrapStampStore.claim', () => {
  it('the first lane wins and every other lane is HELD', () => {
    const db = buildDb();
    const store = makeStore(db);

    const first = store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    expect(first.kind).toBe('claimed');

    // Not 'claimed', not 'resumed' — a different lane must take today's skip
    // rather than start a second derivation over the same singleton record.
    const second = store.claim({ ...KEY, ownerTaskRef: 'TASK-2' });
    expect(second.kind).toBe('held');
    if (second.kind === 'held') expect(second.stamp.ownerTaskRef).toBe('TASK-1');
    db.close();
  });

  it('the OWNER re-entering after a restart RESUMES, and sees where it got to', () => {
    // The controller restarts lanes at inner step zero on resume. A lock that
    // excluded its own owner would strand the run holding a claim nobody can
    // advance — worse than having no lock at all.
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({ ...KEY, ownerTaskRef: 'TASK-1', state: 'drafted', commitSha: 'abc123' });

    const again = store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    expect(again.kind).toBe('resumed');
    if (again.kind === 'resumed') {
      expect(again.stamp.state).toBe('drafted');
      expect(again.stamp.commitSha).toBe('abc123');
    }
    db.close();
  });

  it.each(['proven', 'failed'] as const)('a %s stamp is SETTLED, even for its own owner', (state) => {
    // Terminal for this run: on 'proven' the ordinary enqueue now passes the
    // gate by itself, on 'failed' the run has already decided. Either way there
    // is nothing left to resume, and re-running the agent would be pure waste.
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({ ...KEY, ownerTaskRef: 'TASK-1', state });

    for (const ref of ['TASK-1', 'TASK-2']) {
      expect(store.claim({ ...KEY, ownerTaskRef: ref }).kind).toBe('settled');
    }
    db.close();
  });

  it('is scoped to the RUN — a later run may try again', () => {
    // A bootstrap that failed in run A must not permanently suppress the
    // question: the project may have changed in exactly the way that fixes it.
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({ ...KEY, ownerTaskRef: 'TASK-1', state: 'failed' });

    expect(store.claim({ ...KEY, runId: 'run-2', ownerTaskRef: 'TASK-1' }).kind).toBe('claimed');
    db.close();
  });

  it('separate modalities of one run are separate claims', () => {
    const db = buildDb();
    const store = makeStore(db);
    expect(store.claim({ ...KEY, ownerTaskRef: 'TASK-1' }).kind).toBe('claimed');
    expect(store.claim({ ...KEY, modality: 'cdp-app', ownerTaskRef: 'TASK-2' }).kind).toBe('claimed');
    db.close();
  });

  it('degrades to UNAVAILABLE on a pre-106 DB — never to "you own it"', () => {
    // The one failure mode that must not exist is a store error that hands a
    // lane a claim. 'unavailable' means the caller does nothing, which is
    // byte-identical to the feature being off.
    const db = buildDb(false);
    const store = makeStore(db);
    expect(store.claim({ ...KEY, ownerTaskRef: 'TASK-1' })).toEqual({ kind: 'unavailable' });
    expect(store.read(KEY.runId, KEY.projectId, KEY.modality)).toBeNull();
    db.close();
  });
});

describe('RunbookBootstrapStampStore.advance', () => {
  it('patches named fields and LEAVES the rest alone', () => {
    // The round-2 retry depends on this: the round-1 draft commit is still on
    // the branch and still has to be excluded from every sibling lane's commit
    // probe, whatever happens to the proof.
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({
      ...KEY,
      ownerTaskRef: 'TASK-1',
      state: 'drafted',
      commitSha: 'sha-1',
      runbookHash: 'hash-1',
      runbookVersion: 3,
    });
    store.advance({ ...KEY, ownerTaskRef: 'TASK-1', state: 'proving', requestId: 'req-9', round: 2 });

    const stamp = store.read(KEY.runId, KEY.projectId, KEY.modality);
    expect(stamp).toMatchObject({
      state: 'proving',
      round: 2,
      commitSha: 'sha-1',
      runbookHash: 'hash-1',
      runbookVersion: 3,
      requestId: 'req-9',
    });
    db.close();
  });

  it('a NON-owner writes nothing and is told so', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });

    expect(store.advance({ ...KEY, ownerTaskRef: 'TASK-2', state: 'failed' })).toBe(false);
    expect(store.read(KEY.runId, KEY.projectId, KEY.modality)?.state).toBe('claimed');
    db.close();
  });
});

describe('RunbookBootstrapStampStore.commitShasForRun', () => {
  it('returns every bootstrap commit of the run, across modalities', () => {
    // The commit-integrity probe asks "did HEAD move for a reason that is not
    // this lane?" — a bootstrap commit for ANY modality is such a reason.
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({ ...KEY, ownerTaskRef: 'TASK-1', state: 'drafted', commitSha: 'sha-web' });
    store.claim({ ...KEY, modality: 'cdp-app', ownerTaskRef: 'TASK-2' });
    store.advance({
      ...KEY,
      modality: 'cdp-app',
      ownerTaskRef: 'TASK-2',
      state: 'drafted',
      commitSha: 'sha-cdp',
    });
    // Another run's commit is NOT this run's business.
    store.claim({ ...KEY, runId: 'run-2', ownerTaskRef: 'TASK-1' });
    store.advance({ ...KEY, runId: 'run-2', ownerTaskRef: 'TASK-1', state: 'drafted', commitSha: 'sha-other' });

    expect(store.commitShasForRun('run-1').sort()).toEqual(['sha-cdp', 'sha-web']);
    db.close();
  });

  it('is empty (never throws) on a pre-106 DB — the probe as it shipped', () => {
    const db = buildDb(false);
    expect(makeStore(db).commitShasForRun('run-1')).toEqual([]);
    db.close();
  });

  it('includes the RUNG-1 commit as well as the runbook commit', () => {
    // §8.1 splits them so a human can revert the config change on its own. A
    // probe that excluded only the runbook commit would still see the second one
    // and reach exactly the wrong conclusion — that a lane which committed
    // nothing had committed something.
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({
      ...KEY,
      ownerTaskRef: 'TASK-1',
      state: 'drafted',
      commitSha: 'sha-runbook',
      rung1Path: 'package.json',
      rung1CommitSha: 'sha-config',
    });
    expect(store.commitShasForRun('run-1').sort()).toEqual(['sha-config', 'sha-runbook']);
    db.close();
  });
});

describe('RunbookBootstrapStampStore — the migration-107 rung-1 columns', () => {
  it('round-trips the rung-1 path and its own commit', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({
      ...KEY,
      ownerTaskRef: 'TASK-1',
      state: 'drafted',
      rung1Path: 'vite.config.ts',
      rung1CommitSha: 'sha-config',
    });
    const stamp = store.read(KEY.runId, KEY.projectId, KEY.modality);
    expect(stamp).toMatchObject({ rung1Path: 'vite.config.ts', rung1CommitSha: 'sha-config' });
    db.close();
  });

  it('reads null for a bootstrap that applied no config change', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    expect(store.read(KEY.runId, KEY.projectId, KEY.modality)).toMatchObject({
      rung1Path: null,
      rung1CommitSha: null,
    });
    db.close();
  });

  it('on a 106-only DB the STATE still advances; only the provenance is lost', () => {
    // The asymmetry that matters. A read that lost the whole row would lose the
    // resume cursor and strand a bootstrap mid-sequence; a write that refused to
    // advance would do the same. What a 106-only DB gives up is the record of an
    // edit this build could not have applied through it anyway.
    const db = buildDb(true, false);
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    expect(
      store.advance({
        ...KEY,
        ownerTaskRef: 'TASK-1',
        state: 'drafted',
        commitSha: 'sha-runbook',
        rung1Path: 'vite.config.ts',
        rung1CommitSha: 'sha-config',
      }),
    ).toBe(true);

    const stamp = store.read(KEY.runId, KEY.projectId, KEY.modality);
    expect(stamp).toMatchObject({ state: 'drafted', commitSha: 'sha-runbook', rung1Path: null });
    expect(store.commitShasForRun('run-1')).toEqual(['sha-runbook']);
    db.close();
  });
});

describe('RunbookBootstrapStampStore.writtenPathsForRun', () => {
  it('lists the runbook path once a bootstrap has actually COMMITTED', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({ ...KEY, ownerTaskRef: 'TASK-1', state: 'drafted', commitSha: 'sha-1' });
    expect(store.writtenPathsForRun('run-1')).toEqual(['.cyboflow/verify-runbook.json']);
    db.close();
  });

  it('is EMPTY for a claimed-but-never-written bootstrap', () => {
    // The one way a path-scoped exclusion can remove work that is not the
    // bootstrap's: listing the runbook path for a run that never wrote it would
    // excise a file some OTHER actor put there.
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    expect(store.writtenPathsForRun('run-1')).toEqual([]);
    db.close();
  });

  it('includes the rung-1 file, which is the path-scoped consumers\' real target', () => {
    // Both consumers work in paths, not commits: the eval diff drops these
    // files\' hunks, and address-review is told not to touch them.
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, ownerTaskRef: 'TASK-1' });
    store.advance({
      ...KEY,
      ownerTaskRef: 'TASK-1',
      state: 'drafted',
      commitSha: 'sha-1',
      rung1Path: 'vite.config.ts',
    });
    expect(store.writtenPathsForRun('run-1').sort()).toEqual(['.cyboflow/verify-runbook.json', 'vite.config.ts']);
    db.close();
  });

  it('does not duplicate the runbook path across modalities', () => {
    const db = buildDb();
    const store = makeStore(db);
    for (const modality of ['web', 'cdp-app'] as const) {
      store.claim({ ...KEY, modality, ownerTaskRef: 'TASK-1' });
      store.advance({ ...KEY, modality, ownerTaskRef: 'TASK-1', state: 'drafted', commitSha: `sha-${modality}` });
    }
    expect(store.writtenPathsForRun('run-1')).toEqual(['.cyboflow/verify-runbook.json']);
    db.close();
  });

  it('is scoped to the run, and empty (never throws) on a pre-106 DB', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.claim({ ...KEY, runId: 'run-2', ownerTaskRef: 'TASK-1' });
    store.advance({ ...KEY, runId: 'run-2', ownerTaskRef: 'TASK-1', state: 'drafted', commitSha: 'sha-other' });
    expect(store.writtenPathsForRun('run-1')).toEqual([]);
    db.close();

    const bare = buildDb(false);
    expect(makeStore(bare).writtenPathsForRun('run-1')).toEqual([]);
    bare.close();
  });
});
