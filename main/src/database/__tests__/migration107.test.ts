/**
 * Migration 107_bootstrap_proof.sql — schema tests.
 *
 * Applies the verification-queue chain 055 -> 078 -> 095 -> 096 -> 107 against an
 * in-memory SQLite instance. Proves:
 *   1. `verification_requests.bootstrap_proof` exists, is NOT NULL, and defaults
 *      to 0 — so every pre-existing row and every ordinary lane request reads
 *      back as "not a bootstrap proof" without a backfill.
 *   2. `verify_runbook_local.origin` exists and is NULL by default — the honest
 *      answer for a record registered before the distinction existed, which
 *      readers must not silently promote to 'setup-flow'.
 *   3. Re-running the file raises SQLite's `duplicate column name` — the
 *      idempotency signal runFileBasedMigrations() keys off to skip an
 *      already-applied file.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIG_DIR = join(__dirname, '..', 'migrations');

const CHAIN = [
  '055_visual_verification.sql',
  '078_verification_agent_requests.sql',
  '095_verify_failure_classes.sql',
  '096_verify_runbook_local.sql',
  '107_bootstrap_proof.sql',
];

function seed(db: Database.Database): void {
  // 055 ALTERs workflow_runs (the verify stamps) and CREATEs the request queue,
  // which references projects/runs only by plain integer/text handles — no FKs on
  // this queue by design — so minimal stand-ins for both are enough.
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running'
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  db.prepare('INSERT INTO workflow_runs (id, project_id) VALUES (?, 1)').run('run_1');
}

function applyChain(db: Database.Database, files: string[] = CHAIN): void {
  for (const f of files) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
}

function columns(db: Database.Database, table: string): Map<string, { notnull: number; dflt: unknown }> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  return new Map(rows.map((r) => [r.name, { notnull: r.notnull, dflt: r.dflt_value }]));
}

describe('migration 107 — bootstrap proof + runbook origin', () => {
  it('adds bootstrap_proof NOT NULL DEFAULT 0 to verification_requests', () => {
    const db = new Database(':memory:');
    seed(db);
    applyChain(db);

    const col = columns(db, 'verification_requests').get('bootstrap_proof');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(1);
    expect(String(col?.dflt)).toBe('0');
    db.close();
  });

  it('defaults an ordinary inserted request to bootstrap_proof = 0', () => {
    const db = new Database(':memory:');
    seed(db);
    applyChain(db);

    db.prepare(
      `INSERT INTO verification_requests
         (id, run_id, project_id, status, verify_type, deliverable_json, chain_json, attempt)
       VALUES ('vr_x', 'run_1', 1, 'queued', 'static-render-snapshot', '{}', '[]', 0)`,
    ).run();

    const row = db
      .prepare('SELECT bootstrap_proof AS b, setup_proof AS s FROM verification_requests WHERE id = ?')
      .get('vr_x') as { b: number; s: number };
    // Both proof flags default off: an unstamped row is ordinary lane traffic,
    // which is what makes the enqueue ladder's pre-107 fallback safe.
    expect(row.b).toBe(0);
    expect(row.s).toBe(0);
    db.close();
  });

  it('adds a nullable origin to verify_runbook_local, defaulting to NULL', () => {
    const db = new Database(':memory:');
    seed(db);
    applyChain(db);

    const col = columns(db, 'verify_runbook_local').get('origin');
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
    expect(col?.dflt ?? null).toBeNull();

    db.prepare(
      `INSERT INTO verify_runbook_local
         (project_id, modality, portable_hash, portable_json, version, status)
       VALUES (1, 'web', 'h1', '{}', 1, 'unproven-draft')`,
    ).run();
    const row = db
      .prepare('SELECT origin FROM verify_runbook_local WHERE project_id = 1 AND modality = ?')
      .get('web') as { origin: string | null };
    // NULL, not 'setup-flow': a record registered before the distinction existed
    // has genuinely unknown provenance and must not be dressed up as reviewed.
    expect(row.origin).toBeNull();
    db.close();
  });

  it('is idempotent via the duplicate-column signal the migration runner keys off', () => {
    const db = new Database(':memory:');
    seed(db);
    applyChain(db);

    expect(() => applyChain(db, ['107_bootstrap_proof.sql'])).toThrow(/duplicate column name/i);
    db.close();
  });
});
