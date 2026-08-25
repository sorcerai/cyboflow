/**
 * Unit tests for reopenIdeaResolver — the "which idea does this sourceRef-less
 * prototype belong to" resolution behind ArtifactTabRenderer's widened
 * "reopen in design mode" CTA (IDEA-013).
 *
 * Mirrors runEntityOwnership.test.ts's minimal hand-rolled DB style (no FK
 * enforcement, no real projects/boards/ideas rows needed) since this module
 * only reads workflow_runs / entity_events / epics / tasks / sprint_batch_tasks
 * through listRunOwnedOrBatchIdeaIds — never the ideas table itself.
 *
 * Covered:
 *  - zero ideas resolve for the run                      -> null
 *  - exactly one OWNED idea (seed_idea_id)                -> that idea id
 *  - more than one OWNED idea (seed_idea_ids, migration 061,
 *    a multi-idea planner run) is genuinely ambiguous      -> null (NOT a guess)
 *  - a standalone-sprint run with sprint_batch_tasks spanning exactly ONE
 *    idea (the owned set is empty, so the batch fallback applies)
 *                                                          -> that idea id
 *  - a standalone-sprint run whose batch spans MORE THAN ONE idea is
 *    likewise ambiguous                                   -> null
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { resolveReopenIdeaId } from '../reopenIdeaResolver';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id            TEXT PRIMARY KEY,
      seed_idea_id  TEXT,
      seed_idea_ids TEXT,
      task_id       TEXT,
      batch_id      TEXT
    );
    CREATE TABLE entity_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL CHECK (entity_type IN ('idea', 'epic', 'task', 'review_item')),
      entity_id    TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      actor        TEXT NOT NULL,
      run_id       TEXT,
      changes_json TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE epics (
      id                  TEXT PRIMARY KEY,
      originating_idea_id TEXT
    );
    CREATE TABLE tasks (
      id                  TEXT PRIMARY KEY,
      parent_epic_id      TEXT,
      originating_idea_id TEXT
    );
    CREATE TABLE sprint_batch_tasks (
      batch_id TEXT NOT NULL,
      task_id  TEXT NOT NULL
    );
  `);
  return db;
}

function insertRun(
  db: Database.Database,
  overrides: {
    id: string;
    seedIdeaId?: string | null;
    seedIdeaIds?: string | null;
    taskId?: string | null;
    batchId?: string | null;
  },
): void {
  db.prepare(
    'INSERT INTO workflow_runs (id, seed_idea_id, seed_idea_ids, task_id, batch_id) VALUES (?, ?, ?, ?, ?)',
  ).run(
    overrides.id,
    overrides.seedIdeaId ?? null,
    overrides.seedIdeaIds ?? null,
    overrides.taskId ?? null,
    overrides.batchId ?? null,
  );
}

function insertTask(db: Database.Database, id: string, originatingIdeaId: string | null): void {
  db.prepare('INSERT INTO tasks (id, parent_epic_id, originating_idea_id) VALUES (?, NULL, ?)').run(
    id,
    originatingIdeaId,
  );
}

function insertBatchTask(db: Database.Database, batchId: string, taskId: string): void {
  db.prepare('INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES (?, ?)').run(batchId, taskId);
}

describe('resolveReopenIdeaId', () => {
  it('returns null when the run owns/operates on zero ideas', () => {
    const db = buildDb();
    insertRun(db, { id: 'run-none' });

    expect(resolveReopenIdeaId(dbAdapter(db), 'run-none')).toBeNull();
  });

  it('returns the single idea id when the run owns exactly one (seed_idea_id)', () => {
    const db = buildDb();
    insertRun(db, { id: 'run-one', seedIdeaId: 'idea-1' });

    expect(resolveReopenIdeaId(dbAdapter(db), 'run-one')).toBe('idea-1');
  });

  it('returns null (ambiguous) when a multi-idea planner run owns MORE THAN ONE idea (seed_idea_ids)', () => {
    const db = buildDb();
    insertRun(db, { id: 'run-multi', seedIdeaIds: JSON.stringify(['idea-1', 'idea-2']) });

    // listRunOwnedIdeaIds unions seed_idea_id (null here) with the seed_idea_ids
    // array — two distinct ideas resolve, so the link is genuinely ambiguous.
    expect(resolveReopenIdeaId(dbAdapter(db), 'run-multi')).toBeNull();
  });

  it('falls back to the sprint batch and returns the single idea when the run owns none directly', () => {
    const db = buildDb();
    insertRun(db, { id: 'run-batch', batchId: 'batch-1' });
    insertTask(db, 'task-1', 'idea-9');
    insertTask(db, 'task-2', 'idea-9');
    insertBatchTask(db, 'batch-1', 'task-1');
    insertBatchTask(db, 'batch-1', 'task-2');

    expect(resolveReopenIdeaId(dbAdapter(db), 'run-batch')).toBe('idea-9');
  });

  it('returns null (ambiguous) when a sprint batch spans MORE THAN ONE idea', () => {
    const db = buildDb();
    insertRun(db, { id: 'run-batch-multi', batchId: 'batch-2' });
    insertTask(db, 'task-3', 'idea-7');
    insertTask(db, 'task-4', 'idea-8');
    insertBatchTask(db, 'batch-2', 'task-3');
    insertBatchTask(db, 'batch-2', 'task-4');

    // A single combined prototype covering several ideas — guessing which one
    // it reopens against would be worse than not offering the CTA at all.
    expect(resolveReopenIdeaId(dbAdapter(db), 'run-batch-multi')).toBeNull();
  });
});
