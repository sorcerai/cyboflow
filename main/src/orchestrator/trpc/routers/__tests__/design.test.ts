/**
 * Integration tests for cyboflow.design.resolveReopenIdea — the tRPC query
 * behind ArtifactTabRenderer's widened "reopen in design mode" CTA
 * (IDEA-013). Wires the live router through appRouter.createCaller; the
 * ambiguity/ownership POLICY itself is unit-tested against
 * reopenIdeaResolver.ts directly (design/__tests__/reopenIdeaResolver.test.ts)
 * — this suite only proves the tRPC plumbing: input validation, DatabaseLike
 * wiring, the `{ ideaId } | null` output shape, and the unwired-db guard.
 *
 * Minimal hand-rolled DB (workflow_runs + entity_events), mirroring
 * runEntityOwnership.test.ts / reopenIdeaResolver.test.ts — resolveReopenIdea
 * never touches ideas/boards, so no FK-bearing setup is needed.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id            TEXT PRIMARY KEY,
      seed_idea_id  TEXT,
      seed_idea_ids TEXT
    );
  `);
  return db;
}

describe('cyboflow.design.resolveReopenIdea', () => {
  it('returns { ideaId } when exactly one idea resolves for the run', async () => {
    const db = buildDb();
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, ?)').run('run-1', 'idea-1');
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    const result = await caller.cyboflow.design.resolveReopenIdea({ runId: 'run-1' });

    expect(result).toEqual({ ideaId: 'idea-1' });
  });

  it('returns null when zero ideas resolve for the run', async () => {
    const db = buildDb();
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, ?)').run('run-2', null);
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    const result = await caller.cyboflow.design.resolveReopenIdea({ runId: 'run-2' });

    expect(result).toBeNull();
  });

  it('returns null (never a guess) when more than one idea resolves for the run', async () => {
    const db = buildDb();
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_ids) VALUES (?, ?)').run(
      'run-3',
      JSON.stringify(['idea-a', 'idea-b']),
    );
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    const result = await caller.cyboflow.design.resolveReopenIdea({ runId: 'run-3' });

    expect(result).toBeNull();
  });

  it('rejects an empty runId', async () => {
    const db = buildDb();
    const caller = appRouter.createCaller(createContext({ db: dbAdapter(db) }));

    await expect(caller.cyboflow.design.resolveReopenIdea({ runId: '' })).rejects.toThrow();
  });

  it('throws PRECONDITION_FAILED when ctx.db is unwired', async () => {
    const caller = appRouter.createCaller(createContext({}));

    await expect(caller.cyboflow.design.resolveReopenIdea({ runId: 'run-1' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    } satisfies Partial<TRPCError>);
  });
});
