/**
 * Migration 118_tracker_content_archive_modes.sql — content_sync_mode /
 * archive_sync_mode / priority_mapping_json / category_mapping_json on
 * tracker_connections, plus tracker_outbox.kind widened to accept
 * 'update_content' and 'archive_issue'.
 *
 * Mirrors migration117.test.ts / migration110.test.ts's two-boot real-upgrade
 * pattern: a DB is migrated by a DatabaseService whose migrations dir omits
 * 118, rows are seeded in the pre-118 shape, then a second DatabaseService
 * pointed at the full dir boots on the same file — exactly what happens when
 * a user updates the app.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../database';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');
const MIGRATION_118 = '118_tracker_content_archive_modes.sql';

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-migration118-'));
  dbPath = join(tmpDir, 'test.db');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A migrations dir holding every real migration except 118 — i.e. the pre-118 app. */
function migrationsDirWithout118(): string {
  const dir = join(tmpDir, 'migrations-pre-118');
  mkdirSync(dir);
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    if (name === MIGRATION_118) continue;
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

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
}

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all(table) as Array<{ name: string }>
  ).map((i) => i.name);
}

function seedProject(db: Database.Database, id: number, path: string): void {
  db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run(id, `Proj ${id}`, path);
}

/** Insert one bare connection row (every other column takes its schema default). */
function seedConnection(db: Database.Database, id: string, projectId = 1): void {
  db.prepare(
    `INSERT INTO tracker_connections (id, project_id, provider) VALUES (?, ?, 'linear')`,
  ).run(id, projectId);
}

/** The exact tracker_outbox column list this migration must reproduce verbatim. */
const TRACKER_OUTBOX_COLUMNS = [
  'id',
  'connection_id',
  'kind',
  'entity_type',
  'entity_id',
  'external_id',
  'client_key',
  'payload_json',
  'state',
  'attempts',
  'last_error',
  'next_attempt_at',
  'created_at',
  'updated_at',
];

/** Every tracker_outbox kind that must survive the recreate — old and new. */
const ALL_OUTBOX_KINDS = [
  'create_sub_issue',
  'create_issue',
  'update_state',
  'close_parent',
  'update_content',
  'archive_issue',
];

describe('Migration 118: tracker content/archive modes + outbox kind widening', () => {
  it('(a) upgrades a pre-118 DB: the four new tracker_connections columns land at their defaults', () => {
    const pre118 = migrationsDirWithout118();
    const pre = openAt(pre118);
    seedProject(pre.getDb(), 1, '/tmp/p118');
    seedConnection(pre.getDb(), 'conn-legacy');
    expect(columnNames(pre.getDb(), 'tracker_connections')).not.toContain('content_sync_mode');
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();

    const columns = columnNames(db, 'tracker_connections');
    expect(columns).toContain('content_sync_mode');
    expect(columns).toContain('archive_sync_mode');
    expect(columns).toContain('priority_mapping_json');
    expect(columns).toContain('category_mapping_json');

    const row = db
      .prepare(
        `SELECT content_sync_mode, archive_sync_mode, priority_mapping_json, category_mapping_json
           FROM tracker_connections WHERE id = ?`,
      )
      .get('conn-legacy') as {
      content_sync_mode: string;
      archive_sync_mode: string;
      priority_mapping_json: string;
      category_mapping_json: string;
    };
    // An existing connection never consented to write-back — both modes
    // backfill to 'off', not the DEFAULT-implies-consent 'auto'.
    expect(row).toEqual({
      content_sync_mode: 'off',
      archive_sync_mode: 'off',
      priority_mapping_json: '{}',
      category_mapping_json: '{}',
    });
    svc.close();
  });

  it('(b) content_sync_mode / archive_sync_mode accept auto/manual/off and reject anything else', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProject(db, 1, '/tmp/p118');

    for (const mode of ['auto', 'manual', 'off'] as const) {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tracker_connections (id, project_id, provider, content_sync_mode)
             VALUES (?, 1, 'linear', ?)`,
          )
          .run(`conn-content-${mode}`, mode),
      ).not.toThrow();
      expect(() =>
        db
          .prepare(
            `INSERT INTO tracker_connections (id, project_id, provider, archive_sync_mode)
             VALUES (?, 1, 'linear', ?)`,
          )
          .run(`conn-archive-${mode}`, mode),
      ).not.toThrow();
    }

    expect(() =>
      db
        .prepare(
          `INSERT INTO tracker_connections (id, project_id, provider, content_sync_mode)
           VALUES ('conn-bad-content', 1, 'linear', 'sometimes')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tracker_connections (id, project_id, provider, archive_sync_mode)
           VALUES ('conn-bad-archive', 1, 'linear', 'sometimes')`,
        )
        .run(),
    ).toThrow(/CHECK/i);

    svc.close();
  });

  it('(c) a fresh insert omitting the two mapping columns defaults to an empty JSON object', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProject(db, 1, '/tmp/p118');
    seedConnection(db, 'conn-fresh');

    const row = db
      .prepare(
        'SELECT priority_mapping_json, category_mapping_json FROM tracker_connections WHERE id = ?',
      )
      .get('conn-fresh') as { priority_mapping_json: string; category_mapping_json: string };
    expect(row).toEqual({ priority_mapping_json: '{}', category_mapping_json: '{}' });
    svc.close();
  });

  it('(d) tracker_outbox accepts one row of every kind — old and new — and rejects a bogus kind', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProject(db, 1, '/tmp/p118');
    seedConnection(db, 'conn-1');

    for (const kind of ALL_OUTBOX_KINDS) {
      expect(
        () => db.prepare(`INSERT INTO tracker_outbox (connection_id, kind) VALUES ('conn-1', ?)`).run(kind),
        `kind='${kind}'`,
      ).not.toThrow();
    }
    expect(() =>
      db.prepare(`INSERT INTO tracker_outbox (connection_id, kind) VALUES ('conn-1', 'delete_issue')`).run(),
    ).toThrow(/CHECK/i);

    svc.close();
  });

  it('(e) the tracker_outbox column list is pinned — a dropped column fails loud', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    expect(columnNames(db, 'tracker_outbox')).toEqual(TRACKER_OUTBOX_COLUMNS);
    expect(indexNames(db, 'tracker_outbox')).toContain('idx_tracker_outbox_conn_state');
    svc.close();
  });

  it('(f) existing outbox rows survive the recreate verbatim', () => {
    const pre118 = migrationsDirWithout118();
    const pre = openAt(pre118);
    seedProject(pre.getDb(), 1, '/tmp/p118');
    seedConnection(pre.getDb(), 'conn-1');
    pre
      .getDb()
      .prepare(
        `INSERT INTO tracker_outbox (connection_id, kind, entity_type, entity_id, external_id, client_key, payload_json)
         VALUES ('conn-1', 'create_sub_issue', 'idea', 'idea-1', 'LIN-9', 'ck-1', '{"a":1}')`,
      )
      .run();
    pre.close();

    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    const row = db
      .prepare(
        `SELECT connection_id, kind, entity_type, entity_id, external_id, client_key, payload_json
           FROM tracker_outbox WHERE connection_id = 'conn-1'`,
      )
      .get();
    expect(row).toEqual({
      connection_id: 'conn-1',
      kind: 'create_sub_issue',
      entity_type: 'idea',
      entity_id: 'idea-1',
      external_id: 'LIN-9',
      client_key: 'ck-1',
      payload_json: '{"a":1}',
    });
    svc.close();
  });

  it('(g) a fresh-install DB (schema.sql + all migrations from scratch) also gets both features', () => {
    const svc = openAt(MIGRATIONS_DIR);
    const db = svc.getDb();
    seedProject(db, 1, '/tmp/p118');
    seedConnection(db, 'conn-fresh');

    expect(
      db.prepare('SELECT content_sync_mode, archive_sync_mode FROM tracker_connections WHERE id = ?').get(
        'conn-fresh',
      ),
    ).toEqual({ content_sync_mode: 'off', archive_sync_mode: 'off' });

    for (const kind of ALL_OUTBOX_KINDS) {
      expect(() =>
        db.prepare(`INSERT INTO tracker_outbox (connection_id, kind) VALUES ('conn-fresh', ?)`).run(kind),
      ).not.toThrow();
    }
    svc.close();
  });
});
