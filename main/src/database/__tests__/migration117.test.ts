/**
 * Migration 117_widen_entity_priority.sql — widen ideas/epics/tasks.priority
 * from the 3-level P0-P2 CHECK (migration 015) to 7-level P0-P6.
 *
 * Mirrors migration110.test.ts's two-boot real-upgrade-path pattern: a DB is
 * migrated by a DatabaseService whose migrations dir omits 117, rows are
 * seeded in the pre-117 shape, then a second DatabaseService pointed at the
 * full dir boots on the same file — exactly what happens when a user updates
 * the app. Also mirrors migration034.test.ts's "(c)" CHECK-boundary pattern,
 * inverted for the new scale: P0-P6 all accepted, one past the top (P7) and a
 * non-scale string both rejected.
 *
 * Findings (review_items.priority, migration 034) are a DIFFERENT axis and
 * are NOT touched by 117 — not exercised here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_117 = '117_widen_entity_priority.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration117-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 117 — i.e. the pre-117 app. */
function migrationsDirWithout117(): string {
  const dir = join(tmpDir, 'migrations-pre-117');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_117) continue;
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

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

function columnInfo(db: Database.Database, table: string, column: string): TableInfoRow | undefined {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as TableInfoRow[]).find((c) => c.name === column);
}

function seedProjectAndBoard(db: Database.Database): void {
  db.prepare(`INSERT INTO projects (id, name, path) VALUES (1, 'Proj', '/tmp/p117')`).run();
  db.prepare(`INSERT INTO boards (id, project_id, name, kind, is_default) VALUES ('board-1', 1, 'Default', 'default', 1)`).run();
  db.prepare(
    `INSERT INTO board_stages (id, board_id, label, color_oklch, position, write_policy, is_terminal, hidden_by_default)
     VALUES ('stage-1', 'board-1', 'Idea', 'oklch(0.5 0 0)', 1, 'asserted', 0, 0)`,
  ).run();
}

/** Insert one row into `table` with the given priority; throws on CHECK failure. */
function insertWithPriority(db: Database.Database, table: 'ideas' | 'epics' | 'tasks', id: string, priority: string): void {
  db.prepare(
    `INSERT INTO ${table} (id, project_id, ref, title, board_id, stage_id, priority)
     VALUES (?, 1, ?, ?, 'board-1', 'stage-1', ?)`,
  ).run(id, `${table.toUpperCase()}-${id}`, id, priority);
}

describe('Migration 117: widen ideas/epics/tasks.priority to P0-P6', () => {
  it('(a) upgrades a pre-117 DB: CHECK widens, DEFAULT stays P2, existing rows preserved', () => {
    const pre117 = migrationsDirWithout117();
    const pre = openAt(pre117);
    seedProjectAndBoard(pre.getDb());
    // Pre-117: only P0-P2 accepted.
    insertWithPriority(pre.getDb(), 'ideas', 'idea-legacy', 'P1');
    expect(() => insertWithPriority(pre.getDb(), 'ideas', 'idea-bad', 'P3')).toThrow(/CHECK constraint failed/);
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    // Existing row preserved.
    const row = db.prepare('SELECT priority FROM ideas WHERE id = ?').get('idea-legacy') as { priority: string };
    expect(row.priority).toBe('P1');

    // Column shape: still NOT NULL, DEFAULT 'P2', same position/type.
    for (const table of ['ideas', 'epics', 'tasks'] as const) {
      const col = columnInfo(db, table, 'priority');
      expect(col).toBeDefined();
      expect(col?.type).toBe('TEXT');
      expect(col?.notnull).toBe(1);
      expect(String(col?.dflt_value)).toBe("'P2'");
    }
    svc.close();
  });

  it('(b) accepts P0-P6 and rejects P7 / a bogus string, on all three tables', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProjectAndBoard(db);

    const levels = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'] as const;
    for (const table of ['ideas', 'epics', 'tasks'] as const) {
      for (const p of levels) {
        expect(() => insertWithPriority(db, table, `${table}-${p}`, p), `${table} priority='${p}'`).not.toThrow();
      }
      expect(() => insertWithPriority(db, table, `${table}-p7`, 'P7'), `${table} priority='P7'`).toThrow(
        /CHECK constraint failed/i,
      );
      expect(() => insertWithPriority(db, table, `${table}-bogus`, 'bogus'), `${table} priority='bogus'`).toThrow(
        /CHECK constraint failed/i,
      );
    }
    svc.close();
  });

  it('(c) an insert omitting priority still defaults to P2, on all three tables', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProjectAndBoard(db);

    db.prepare(
      `INSERT INTO ideas (id, project_id, ref, title, board_id, stage_id) VALUES ('idea-def', 1, 'IDEA-DEF', 'x', 'board-1', 'stage-1')`,
    ).run();
    db.prepare(
      `INSERT INTO epics (id, project_id, ref, title, board_id, stage_id) VALUES ('epic-def', 1, 'EPIC-DEF', 'x', 'board-1', 'stage-1')`,
    ).run();
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id) VALUES ('task-def', 1, 'TASK-DEF', 'x', 'board-1', 'stage-1')`,
    ).run();

    expect((db.prepare('SELECT priority FROM ideas WHERE id = ?').get('idea-def') as { priority: string }).priority).toBe(
      'P2',
    );
    expect((db.prepare('SELECT priority FROM epics WHERE id = ?').get('epic-def') as { priority: string }).priority).toBe(
      'P2',
    );
    expect((db.prepare('SELECT priority FROM tasks WHERE id = ?').get('task-def') as { priority: string }).priority).toBe(
      'P2',
    );
    svc.close();
  });

  it('(d) a fresh-install DB (schema.sql + all migrations from scratch) also accepts P0-P6', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProjectAndBoard(db);
    for (const table of ['ideas', 'epics', 'tasks'] as const) {
      expect(() => insertWithPriority(db, table, `${table}-fresh`, 'P6')).not.toThrow();
    }
    svc.close();
  });
});
