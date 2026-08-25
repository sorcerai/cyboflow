import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { CodexRawNotificationSink } from '../../services/panels/codex/appServer/rawNotificationSink';

function readMigration(name: string): string {
  return readFileSync(join(__dirname, '..', 'migrations', name), 'utf8');
}

/** 006 defines raw_events; 071 adds dedup_key + the partial unique index 111 relies on. */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(readMigration('006_cyboflow_schema.sql'));
  db.exec(readMigration('071_raw_events_dedup.sql'));
  return db;
}

function seed(db: Database.Database, runId: string, payload: object): void {
  db.prepare(
    `INSERT INTO raw_events (run_id, event_type, payload_json)
     VALUES (?, 'codex_app_server_notification', ?)`,
  ).run(runId, JSON.stringify(payload));
}

function turnDiff(turnId: string, diff: string): object {
  return { method: 'turn/diff/updated', params: { threadId: 'thread-1', turnId, diff } };
}

function rows(db: Database.Database): Array<{
  run_id: string;
  payload_json: string;
  dedup_key: string | null;
}> {
  return db
    .prepare('SELECT run_id, payload_json, dedup_key FROM raw_events ORDER BY id')
    .all() as Array<{ run_id: string; payload_json: string; dedup_key: string | null }>;
}

function methodsOf(db: Database.Database): string[] {
  return rows(db).map((r) => (JSON.parse(r.payload_json) as { method: string }).method);
}

describe('migration 112 codex snapshot dedup', () => {
  it('keeps only the newest snapshot per run+turn and drops the superseded ones', () => {
    const db = makeDb();
    seed(db, 'run-1', turnDiff('turn-a', 'diff v1'));
    seed(db, 'run-1', turnDiff('turn-a', 'diff v2'));
    seed(db, 'run-1', turnDiff('turn-a', 'diff v3 FINAL'));

    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));

    const remaining = rows(db);
    expect(remaining).toHaveLength(1);
    const params = (JSON.parse(remaining[0].payload_json) as { params: { diff: string } }).params;
    // The SURVIVOR must be the newest snapshot — a cumulative payload's last
    // value subsumes the ones removed, so keeping an earlier row would lose data.
    expect(params.diff).toBe('diff v3 FINAL');
  });

  it('keeps snapshots from different turns and different runs apart', () => {
    const db = makeDb();
    seed(db, 'run-1', turnDiff('turn-a', 'a1'));
    seed(db, 'run-1', turnDiff('turn-a', 'a2'));
    seed(db, 'run-1', turnDiff('turn-b', 'b1'));
    seed(db, 'run-1', turnDiff('turn-b', 'b2'));
    seed(db, 'run-2', turnDiff('turn-a', 'other-run'));

    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));

    const remaining = rows(db);
    expect(remaining).toHaveLength(3);
    expect(
      remaining.map(
        (r) => (JSON.parse(r.payload_json) as { params: { diff: string } }).params.diff,
      ),
    ).toEqual(['a2', 'b2', 'other-run']);
  });

  it('collapses the turn-less account/rateLimits gauge to one row per run', () => {
    const db = makeDb();
    const gauge = (pct: number): object => ({
      method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex', primary: { usedPercent: pct } } },
    });
    seed(db, 'run-1', gauge(8));
    seed(db, 'run-1', gauge(9));
    seed(db, 'run-2', gauge(11));

    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));

    const remaining = rows(db);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((r) => r.run_id)).toEqual(['run-1', 'run-2']);
    // No turn scope in the payload, so the key falls back to the 'run' sentinel.
    expect(remaining[0].dedup_key).toBe('codex:rate-limits:run-1:run');
  });

  it('leaves non-snapshot codex notifications append-only and unkeyed', () => {
    const db = makeDb();
    seed(db, 'run-1', { method: 'item/completed', params: { turnId: 'turn-a' } });
    seed(db, 'run-1', { method: 'item/completed', params: { turnId: 'turn-a' } });
    seed(db, 'run-1', { method: 'turn/completed', params: { turnId: 'turn-a' } });

    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));

    const remaining = rows(db);
    expect(remaining).toHaveLength(3);
    expect(remaining.every((r) => r.dedup_key === null)).toBe(true);
  });

  it('stamps every surviving snapshot with a dedup key, one per method slug', () => {
    const db = makeDb();
    seed(db, 'run-1', turnDiff('turn-a', 'd'));
    seed(db, 'run-1', {
      method: 'thread/tokenUsage/updated',
      params: { threadId: 't', turnId: 'turn-a', tokenUsage: { total: 10 } },
    });
    seed(db, 'run-1', {
      method: 'account/rateLimits/updated',
      params: { rateLimits: { limitId: 'codex' } },
    });

    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));

    expect(rows(db).map((r) => r.dedup_key)).toEqual([
      'codex:turn-diff:run-1:turn-a',
      'codex:token-usage:run-1:turn-a',
      'codex:rate-limits:run-1:run',
    ]);
  });

  it('does not disturb a pre-existing dedup_key from another writer', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO raw_events (run_id, event_type, payload_json, dedup_key)
       VALUES ('run-1', 'subagent_usage', '{}', 'subagent:run-1:agent-a')`,
    ).run();
    seed(db, 'run-1', turnDiff('turn-a', 'd'));

    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));

    expect(rows(db).map((r) => r.dedup_key)).toEqual([
      'subagent:run-1:agent-a',
      'codex:turn-diff:run-1:turn-a',
    ]);
  });

  it('is idempotent when applied twice', () => {
    const db = makeDb();
    seed(db, 'run-1', turnDiff('turn-a', 'v1'));
    seed(db, 'run-1', turnDiff('turn-a', 'v2'));

    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));
    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));

    expect(rows(db)).toHaveLength(1);
  });

  it('lets the live sink upsert onto a migrated historical row instead of adding a second one', () => {
    // The load-bearing lockstep check: the migration's key expression and
    // buildSnapshotDedupKey() must agree, or a resumed run silently starts a
    // parallel row and the dedup never converges.
    const db = makeDb();
    seed(db, 'run-1', turnDiff('turn-a', 'pre-migration'));
    db.exec(readMigration('112_raw_events_codex_snapshot_dedup.sql'));

    const sink = new CodexRawNotificationSink(db);
    sink.persist('run-1', {
      method: 'turn/diff/updated',
      params: { threadId: 'thread-1', turnId: 'turn-a', diff: 'post-migration' },
    });

    const remaining = rows(db);
    expect(remaining).toHaveLength(1);
    expect(
      (JSON.parse(remaining[0].payload_json) as { params: { diff: string } }).params.diff,
    ).toBe('post-migration');
    expect(methodsOf(db)).toEqual(['turn/diff/updated']);
  });
});
