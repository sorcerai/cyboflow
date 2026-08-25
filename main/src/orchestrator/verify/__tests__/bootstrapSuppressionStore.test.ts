/**
 * Unit tests for the bootstrap suppression record + migration 109
 * (docs/proposals/lane-runbook-bootstrap.md §10, §16 defect 8).
 *
 * v1's suppression was written under the DRAFT's runbook hash, into a capability
 * ledger bucket that unpinned no-runbook requests never read — so it would never
 * have fired even once. That is why this is a dedicated table with its own key,
 * and why the tests below are almost entirely about the KEY rather than about
 * storage.
 *
 * The key is the design: a suppression holds the project's input hash and the
 * host fingerprint AS THEY WERE when the attempt failed, and is honored only
 * while BOTH still match. A project that adds a `dev` script, or a host that
 * grows a chromium, reopens the question on the very next request. A TTL would
 * get both directions wrong — it keeps charging a dead project until the clock
 * runs down, and keeps refusing a fixed one for the same interval.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BootstrapSuppressionStore } from '../bootstrapSuppressionStore';
import type { DatabaseLike } from '../../types';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

function buildDb(withMigration = true): Database.Database {
  const db = new Database(':memory:');
  if (withMigration) {
    // 106 first: 107 ALTERs the table 106 creates.
    db.exec(readFileSync(join(MIG_DIR, '108_runbook_bootstrap_stamp.sql'), 'utf-8'));
    db.exec(readFileSync(join(MIG_DIR, '109_runbook_bootstrap_suppression.sql'), 'utf-8'));
  }
  return db;
}

function makeStore(db: Database.Database): BootstrapSuppressionStore {
  return new BootstrapSuppressionStore(db as unknown as DatabaseLike);
}

const KEY = { projectId: 1, modality: 'web' as const };
const HASHES = { inputHash: 'input-a', hostFingerprint: 'host-a' };

describe('migration 109', () => {
  it('creates the suppression table keyed (project_id, modality)', () => {
    const db = buildDb();
    const pk = (
      db.prepare('PRAGMA table_info(verify_runbook_bootstrap_suppression)').all() as Array<{
        name: string;
        pk: number;
      }>
    )
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(pk).toEqual(['project_id', 'modality']);
    db.close();
  });

  it('adds the rung-1 columns to the migration-106 stamp table', () => {
    // §8.1 commits the config edit separately from the runbook, so a bootstrap
    // can leave TWO commits behind. Both have to be excluded from every sibling
    // lane's commit probe, and the PATH is needed separately for the eval-diff
    // excision and the address-review denylist.
    const db = buildDb();
    const columns = (db.prepare('PRAGMA table_info(verify_runbook_bootstrap)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(columns).toContain('rung1_path');
    expect(columns).toContain('rung1_commit_sha');
    db.close();
  });

  it('re-running raises the duplicate-column signal the runner keys idempotency off', () => {
    // The CREATE is idempotent on its own; the ALTERs are not (SQLite has no ADD
    // COLUMN IF NOT EXISTS), and runFileBasedMigrations treats exactly this
    // message as "already applied".
    const db = buildDb();
    expect(() => db.exec(readFileSync(join(MIG_DIR, '109_runbook_bootstrap_suppression.sql'), 'utf-8'))).toThrow(
      /duplicate column name/,
    );
    db.close();
  });
});

describe('BootstrapSuppressionStore', () => {
  it('suppresses while BOTH hashes still match', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, ...HASHES, reason: 'no script serves the renderer' });
    expect(store.isSuppressed({ ...KEY, ...HASHES })).toBe(true);
    db.close();
  });

  it('a changed PROJECT reopens the question immediately — no TTL to wait out', () => {
    // The whole point of keying on the input hash: the thing that made the
    // bootstrap impossible is exactly the thing that just changed.
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, ...HASHES, reason: 'x' });
    expect(store.isSuppressed({ ...KEY, inputHash: 'input-b', hostFingerprint: 'host-a' })).toBe(false);
    db.close();
  });

  it('a changed HOST reopens it too', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, ...HASHES, reason: 'x' });
    expect(store.isSuppressed({ ...KEY, inputHash: 'input-a', hostFingerprint: 'host-b' })).toBe(false);
    db.close();
  });

  it('is per-modality — one dead surface does not silence another', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, ...HASHES, reason: 'x' });
    expect(store.isSuppressed({ projectId: 1, modality: 'cdp-app', ...HASHES })).toBe(false);
    db.close();
  });

  it('a NULL hash on either side never suppresses', () => {
    // "I could not observe the environment" is not evidence that it matches the
    // one a previous refusal described. Failing open costs one attempt; failing
    // closed would silence a project forever because a hash could not be read.
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, ...HASHES, reason: 'x' });
    expect(store.isSuppressed({ ...KEY, inputHash: null, hostFingerprint: 'host-a' })).toBe(false);
    expect(store.isSuppressed({ ...KEY, inputHash: 'input-a', hostFingerprint: null })).toBe(false);
    db.close();
  });

  it('a suppression stored with NULL hashes never suppresses either', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, inputHash: null, hostFingerprint: null, reason: 'x' });
    expect(store.isSuppressed({ ...KEY, ...HASHES })).toBe(false);
    db.close();
  });

  it('REPLACES rather than accumulates — only the latest observation describes the project', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, ...HASHES, reason: 'first' });
    store.suppress({ ...KEY, inputHash: 'input-b', hostFingerprint: 'host-b', reason: 'second' });
    expect(store.read(1, 'web')?.reason).toBe('second');
    expect(store.isSuppressed({ ...KEY, ...HASHES })).toBe(false);
    expect(store.isSuppressed({ ...KEY, inputHash: 'input-b', hostFingerprint: 'host-b' })).toBe(true);
    db.close();
  });

  it('keeps the reason, which is what the human reads instead of a verification', () => {
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, ...HASHES, reason: 'no script serves the renderer; `dev` starts only the API' });
    expect(store.read(1, 'web')?.reason).toContain('starts only the API');
    db.close();
  });

  it('clear() drops it — a successful bootstrap falsifies the record outright', () => {
    // Leaving it to expire by hash drift would leave a false statement in the
    // table, which the next run would act on.
    const db = buildDb();
    const store = makeStore(db);
    store.suppress({ ...KEY, ...HASHES, reason: 'x' });
    store.clear(1, 'web');
    expect(store.read(1, 'web')).toBeNull();
    expect(store.isSuppressed({ ...KEY, ...HASHES })).toBe(false);
    db.close();
  });

  it('degrades to NOT SUPPRESSED on a pre-107 DB, and never throws', () => {
    // Fail-open, in both directions: a store that cannot answer must not silence
    // a project, and a suppress that cannot land must not crash the bootstrap.
    const db = buildDb(false);
    const store = makeStore(db);
    expect(store.isSuppressed({ ...KEY, ...HASHES })).toBe(false);
    expect(store.read(1, 'web')).toBeNull();
    expect(store.suppress({ ...KEY, ...HASHES, reason: 'x' })).toBe(false);
    expect(() => store.clear(1, 'web')).not.toThrow();
    db.close();
  });
});
