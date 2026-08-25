/**
 * Migrations 113/114/115 — sessions.home_idea_id, sessions.origin_idea_id, and
 * the partial unique index enforcing at most one live idea-home session per idea.
 *
 * Exercises the REAL migrations dir (mirrors migration110.test.ts's pattern):
 * a fresh boot proves the columns + index land, and a ledger-wiped replay
 * proves the duplicate-column tolerance each single-statement file relies on
 * (see 113's header for why the ALTERs and the index are split into three
 * files instead of one).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration113-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function openFresh(): DatabaseService {
  const svc = new DatabaseService(dbPath);
  svc.setMigrationsDirForTesting(MIGRATIONS_DIR);
  svc.initialize();
  return svc;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function indexExists(db: Database.Database, name: string): boolean {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = ?")
      .get(name) !== undefined
  );
}

function seedSession(db: Database.Database, id: string, homeIdeaId: string | null): void {
  db.prepare(
    `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, home_idea_id)
     VALUES (?, 'S', 'p', 'w', '/tmp/w', ?)`,
  ).run(id, homeIdeaId);
}

/** Wipe the file-migration ledger so the next initialize() re-applies EVERY file. */
function wipeLedger(path: string): void {
  const raw = new Database(path);
  raw.prepare("DELETE FROM user_preferences WHERE key LIKE 'file_migration_applied:%'").run();
  raw.close();
}

describe('Migrations 113/114/115: sessions home/origin idea columns', () => {
  it('a fresh apply adds both columns and the partial unique index', () => {
    const svc = openFresh();
    const db = svc.getDb();
    const cols = columnNames(db, 'sessions');
    expect(cols).toContain('home_idea_id');
    expect(cols).toContain('origin_idea_id');
    expect(indexExists(db, 'idx_sessions_home_idea')).toBe(true);
    svc.close();
  });

  it('the unique index blocks a second live session claiming the same idea, but allows an archived duplicate', () => {
    const svc = openFresh();
    const db = svc.getDb();

    seedSession(db, 'sess-1', 'idea-1');
    expect(() => seedSession(db, 'sess-2', 'idea-1')).toThrow(/UNIQUE constraint failed/);

    // Archiving the first session releases its claim.
    db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run('sess-1');
    expect(() => seedSession(db, 'sess-3', 'idea-1')).not.toThrow();

    // A NULL home_idea_id never collides, no matter how many rows.
    seedSession(db, 'sess-4', null);
    expect(() => seedSession(db, 'sess-5', null)).not.toThrow();

    svc.close();
  });

  it('a ledger-wiped replay re-applies all three files cleanly (idempotent)', () => {
    const svc1 = openFresh();
    seedSession(svc1.getDb(), 'sess-1', 'idea-1');
    svc1.close();

    wipeLedger(dbPath);

    const svc2 = new DatabaseService(dbPath);
    svc2.setMigrationsDirForTesting(MIGRATIONS_DIR);
    expect(() => svc2.initialize()).not.toThrow();

    const db = svc2.getDb();
    const cols = columnNames(db, 'sessions');
    expect(cols).toContain('home_idea_id');
    expect(cols).toContain('origin_idea_id');
    expect(indexExists(db, 'idx_sessions_home_idea')).toBe(true);
    // Pre-existing row survives the replay untouched.
    expect(
      (db.prepare('SELECT home_idea_id FROM sessions WHERE id = ?').get('sess-1') as {
        home_idea_id: string;
      }).home_idea_id,
    ).toBe('idea-1');

    for (const name of [
      '113_session_home_idea.sql',
      '114_session_origin_idea.sql',
      '115_session_home_idea_unique.sql',
    ]) {
      expect(
        db
          .prepare("SELECT value FROM user_preferences WHERE key = ?")
          .get(`file_migration_applied:${name}`),
      ).toEqual({ value: 'true' });
    }
    svc2.close();
  });
});
