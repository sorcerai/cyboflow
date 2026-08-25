/**
 * Migration 110_tracker_push_target.sql — tracker_connections.push_target.
 *
 * Exercises the REAL upgrade path (mirrors migration104.test.ts's two-boot
 * pattern): a DB is migrated by a DatabaseService whose migrations dir omits
 * 110, a connection row is seeded in the pre-110 shape, and a second
 * DatabaseService pointed at the full dir boots on the same file — exactly what
 * happens when a user updates the app.
 *
 * Proves:
 *   1. The column lands, and every pre-existing connection defaults to 1 — the
 *      no-op that lets rev 4 ship without a data migration (an existing single
 *      connection per provider IS the sole push target).
 *   2. A fresh insert that omits the column takes the same default, and a 0 is
 *      writable — the sibling mappings the wizard mints.
 *   3. Replay: a ledger-wiped re-run of the whole migrations dir neither throws
 *      nor duplicates the column — and the values do NOT survive it, because
 *      105 recreates tracker_connections from a hardcoded column list and runs
 *      first. That is pinned deliberately rather than left as a surprise: it is
 *      the one thing a later recreate of this table has to fix (carry
 *      push_target forward, as 105 carried 094's mode columns forward).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_110 = '110_tracker_push_target.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration110-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 110 — i.e. the pre-110 app. */
function migrationsDirWithout110(): string {
  const dir = join(tmpDir, 'migrations-pre-110');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_110) continue;
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

function seedProjectAndConnection(db: Database.Database, id: string): void {
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p110')`).run();
  db.prepare(
    `INSERT INTO tracker_connections (id, project_id, provider) VALUES (?, 1, 'linear')`,
  ).run(id);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function pushTargetOf(db: Database.Database, id: string): number {
  return (
    db.prepare('SELECT push_target FROM tracker_connections WHERE id = ?').get(id) as {
      push_target: number;
    }
  ).push_target;
}

/** Wipe the file-migration ledger so the next initialize() re-applies EVERY file. */
function wipeLedger(path: string): void {
  const raw = new Database(path);
  raw.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
  raw.close();
}

describe('Migration 110: tracker_connections.push_target', () => {
  it('(a) adds the column and defaults every pre-110 connection to 1', () => {
    const pre110 = migrationsDirWithout110();
    const pre = openAt(pre110);
    expect(columnNames(pre.getDb(), 'tracker_connections')).not.toContain('push_target');
    seedProjectAndConnection(pre.getDb(), 'conn-legacy');
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    expect(columnNames(svc.getDb(), 'tracker_connections')).toContain('push_target');
    expect(pushTargetOf(svc.getDb(), 'conn-legacy')).toBe(1);
    svc.close();
  });

  it('(b) a fresh insert defaults to 1, and a sibling mapping can store 0', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProjectAndConnection(db, 'conn-push');
    expect(pushTargetOf(db, 'conn-push')).toBe(1);

    db.prepare(
      `INSERT INTO tracker_connections (id, project_id, provider, push_target)
       VALUES ('conn-sibling', 1, 'linear', 0)`,
    ).run();
    expect(pushTargetOf(db, 'conn-sibling')).toBe(0);
    svc.close();
  });

  it('(c) a ledger-wiped replay re-applies cleanly, but 105 drops the values first', () => {
    const svc1 = openAt(MIGRATIONS_DIR);
    seedProjectAndConnection(svc1.getDb(), 'conn-push');
    svc1
      .getDb()
      .prepare(
        `INSERT INTO tracker_connections (id, project_id, provider, push_target)
         VALUES ('conn-sibling', 1, 'linear', 0)`,
      )
      .run();
    const columnsBefore = columnNames(svc1.getDb(), 'tracker_connections');
    svc1.close();

    wipeLedger(dbPath);

    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(MIGRATIONS_DIR);
    expect(() => svc2.initialize()).not.toThrow();
    const db = svc2.getDb();

    // The column is there exactly once, in the same position, and both rows
    // survive — the ALTER's own replay behaviour is sound.
    expect(columnNames(db, 'tracker_connections')).toEqual(columnsBefore);
    expect(pushTargetOf(db, 'conn-push')).toBe(1);
    // ...but 105's recreate ran first and dropped the column, so the sibling's
    // explicit 0 comes back as the ALTER's DEFAULT. Asserted, not wished away:
    // a replay that silently re-arms push on every sibling mapping is what a
    // later recreate of this table has to prevent.
    expect(pushTargetOf(db, 'conn-sibling')).toBe(1);
    // The marker is recorded again via the runner's idempotent-ALTER tolerance.
    expect(
      db
        .prepare(
          "SELECT value FROM user_preferences WHERE key = 'file_migration_applied:110_tracker_push_target.sql'",
        )
        .get(),
    ).toEqual({ value: 'true' });
    svc2.close();
  });
});
