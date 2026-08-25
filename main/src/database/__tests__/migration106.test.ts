/**
 * Migration 106_restore_delivered_session_findings.sql — reopen the findings the
 * archive sweeps destroyed on sessions whose work was delivered.
 *
 * Exercises the REAL upgrade path (the two-boot pattern of migration103/104's
 * tests): a DB is migrated by a DatabaseService whose migrations dir omits 106,
 * the damaged rows are seeded in exactly the shape the sweeps left behind
 * (status='dismissed' + resolution='session dismissed'), and a second
 * DatabaseService pointed at the full dir boots on the same file — what happens
 * when a user updates the app.
 *
 * Proves:
 *   1. A finding dismissed by either archive sweep on a DELIVERED session
 *      reopens to a clean pending row (no resolution, no resolved_by).
 *   2. Delivery is read from a SIBLING run in the same session, not just the
 *      finding's own run.
 *   3. A finding whose session was genuinely thrown away STAYS dismissed — its
 *      code never landed.
 *   4. Scope holds: gates are not reopened, and the 'entity deleted' sweep's
 *      rows are not reopened (a different sweep, whose subject is gone).
 *   5. Human triage state survives: a row that was staged/selected before the
 *      sweep comes back staged/selected.
 *   6. Idempotent — a second boot over the same DB changes nothing further.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_106 = '106_restore_delivered_session_findings.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration106-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 106 — i.e. the pre-106 app. */
function migrationsDirWithout106(): string {
  const dir = join(tmpDir, 'migrations-pre-106');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_106) continue;
    if (!/^\d{3}_.*\.sql$/.test(name)) continue;
    copyFileSync(join(MIGRATIONS_DIR, name), join(dir, name));
  }
  return dir;
}

function openAt(migrationsDir: string): DatabaseService {
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(migrationsDir);
  svc.initialize();
  return svc;
}

function seedRun(
  db: BetterSqlite3.Database,
  row: { id: string; sessionId: string | null; outcome: string | null },
): void {
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, worktree_path, branch_name, status, outcome, session_id, policy_json)
     VALUES (?, 'wf-106', 1, '/w', 'b', 'canceled', ?, ?, '{}')`,
  ).run(row.id, row.outcome, row.sessionId);
}

function seedSweptItem(
  db: BetterSqlite3.Database,
  row: {
    id: string;
    runId: string;
    kind: 'finding' | 'permission';
    resolution: string;
    stagedAt?: string | null;
    selected?: number;
  },
): void {
  db.prepare(
    `INSERT INTO review_items
       (id, project_id, run_id, kind, status, blocking, title, source, staged_at, selected, resolved_by, resolution)
     VALUES (?, 1, ?, ?, 'dismissed', 0, ?, 'agent:code-review', ?, ?, 'user', ?)`,
  ).run(row.id, row.runId, row.kind, `item ${row.id}`, row.stagedAt ?? null, row.selected ?? 0, row.resolution);
}

function readItem(db: BetterSqlite3.Database, id: string): Record<string, unknown> {
  return db.prepare(`SELECT * FROM review_items WHERE id = ?`).get(id) as Record<string, unknown>;
}

/** Seed the pre-106 world, then boot on the full migrations dir. */
function migrateWithSeed(seed: (db: BetterSqlite3.Database) => void): DatabaseService {
  const pre106 = migrationsDirWithout106();
  openAt(pre106).close();
  const pre = openAt(pre106);
  const db = pre.getDb();
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p106')`).run();
  db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-106', 1, 'sprint', '{}')`).run();
  seed(db);
  pre.close();
  return openAt(MIGRATIONS_DIR);
}

describe('Migration 106: restore delivered-session findings', () => {
  it('(1) reopens a finding either archive sweep dismissed on a merged session', () => {
    const svc = migrateWithSeed((db) => {
      seedRun(db, { id: 'run-merged', sessionId: 'sess-merged', outcome: 'merged' });
      seedSweptItem(db, { id: 'ri-live', runId: 'run-merged', kind: 'finding', resolution: 'session dismissed' });
      seedSweptItem(db, {
        id: 'ri-boot',
        runId: 'run-merged',
        kind: 'finding',
        resolution: 'archived session boot backfill',
      });
    });

    for (const id of ['ri-live', 'ri-boot']) {
      const row = readItem(svc.getDb(), id);
      expect(row.status).toBe('pending');
      expect(row.resolution).toBeNull();
      expect(row.resolved_by).toBeNull();
    }
    svc.close();
  });

  it('(2) reads delivery from a sibling run in the same session', () => {
    // The flow run merged; the quick run that filed the finding never got a stamp.
    const svc = migrateWithSeed((db) => {
      seedRun(db, { id: 'run-quick', sessionId: 'sess-x', outcome: null });
      seedRun(db, { id: 'run-flow', sessionId: 'sess-x', outcome: 'merged' });
      seedSweptItem(db, { id: 'ri-sibling', runId: 'run-quick', kind: 'finding', resolution: 'session dismissed' });
    });

    expect(readItem(svc.getDb(), 'ri-sibling').status).toBe('pending');
    svc.close();
  });

  it('(3) leaves a discarded session\'s findings dismissed', () => {
    const svc = migrateWithSeed((db) => {
      seedRun(db, { id: 'run-dismissed', sessionId: 'sess-d', outcome: 'dismissed' });
      seedRun(db, { id: 'run-undecided', sessionId: 'sess-u', outcome: null });
      seedSweptItem(db, { id: 'ri-thrown', runId: 'run-dismissed', kind: 'finding', resolution: 'session dismissed' });
      seedSweptItem(db, { id: 'ri-null', runId: 'run-undecided', kind: 'finding', resolution: 'session dismissed' });
    });

    expect(readItem(svc.getDb(), 'ri-thrown').status).toBe('dismissed');
    // NULL outcome must not slip through the COALESCE-guarded predicate.
    expect(readItem(svc.getDb(), 'ri-null').status).toBe('dismissed');
    svc.close();
  });

  it('(4) does not reopen gates, nor the entity-deleted sweep\'s rows', () => {
    const svc = migrateWithSeed((db) => {
      seedRun(db, { id: 'run-merged', sessionId: 'sess-merged', outcome: 'merged' });
      seedSweptItem(db, { id: 'ri-gate', runId: 'run-merged', kind: 'permission', resolution: 'session dismissed' });
      seedSweptItem(db, { id: 'ri-entity', runId: 'run-merged', kind: 'finding', resolution: 'entity deleted' });
    });

    expect(readItem(svc.getDb(), 'ri-gate').status).toBe('dismissed');
    expect(readItem(svc.getDb(), 'ri-entity').status).toBe('dismissed');
    svc.close();
  });

  it('(5) preserves the human triage state a restored finding carried', () => {
    const svc = migrateWithSeed((db) => {
      seedRun(db, { id: 'run-merged', sessionId: 'sess-merged', outcome: 'merged' });
      seedSweptItem(db, {
        id: 'ri-staged',
        runId: 'run-merged',
        kind: 'finding',
        resolution: 'session dismissed',
        stagedAt: '2026-08-15T10:00:00.000Z',
        selected: 1,
      });
    });

    const row = readItem(svc.getDb(), 'ri-staged');
    expect(row.status).toBe('pending');
    expect(row.staged_at).toBe('2026-08-15T10:00:00.000Z');
    expect(row.selected).toBe(1);
    svc.close();
  });

  it('(6) is idempotent across a second boot', () => {
    const svc = migrateWithSeed((db) => {
      seedRun(db, { id: 'run-merged', sessionId: 'sess-merged', outcome: 'merged' });
      seedSweptItem(db, { id: 'ri-once', runId: 'run-merged', kind: 'finding', resolution: 'session dismissed' });
    });
    const after = readItem(svc.getDb(), 'ri-once');
    svc.close();

    const again = openAt(MIGRATIONS_DIR);
    expect(readItem(again.getDb(), 'ri-once')).toEqual(after);
    again.close();
  });
});
