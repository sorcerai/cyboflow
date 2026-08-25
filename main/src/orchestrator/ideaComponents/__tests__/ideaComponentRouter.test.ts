/**
 * Unit tests for IdeaComponentRouter — the `idea_components` write
 * chokepoint (migration 101, `../ideaComponentRouter.ts`).
 *
 * Covered:
 *  - setComponentState UPSERTs: first call inserts a row, a second call for
 *    the same (idea, component) updates it in place (row count stays 1).
 *  - setComponentState always clears a previously-set stale flag, even when
 *    re-affirming a non-complete state.
 *  - markStale only flips currently-'complete' rows to 'incomplete' +
 *    stale_at/stale_reason; a 'skipped' row stays skipped and untouched; an
 *    already-'incomplete' row is left completely untouched.
 *  - markStale covers the DERIVED half of the hybrid model too: a candidate
 *    with NO row that derives 'complete' is MATERIALIZED into a stale row
 *    (source 'flow'); one that derives 'incomplete' mints nothing; an existing
 *    row is never materialized over; the components filter bounds both halves.
 *  - clearStale drops stale_at/stale_reason AND restores 'complete' (the exact
 *    inverse of markStale); rejects (not_found) a component with no ledger row;
 *    is idempotent on an already-non-stale row.
 *  - deleteForIdea removes every row for the target idea and leaves a
 *    sibling idea's rows untouched.
 *  - ideaComponentChangeEvents emits on the project channel AFTER commit,
 *    carrying the full merged hybrid snapshot (resolveIdeaComponents' shape).
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IdeaComponentRouter,
  IdeaComponentError,
  ideaComponentChangeEvents,
  ideaComponentProjectChannel,
} from '../ideaComponentRouter';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { resolveIdeaComponents } from '../resolveIdeaComponents';
import type { DatabaseLike } from '../../types';
import type { IdeaComponentChangedEvent } from '../../../../../shared/types/ideaComponents';

// ---------------------------------------------------------------------------
// Test DB builder — the neighbouring resolveIdeaComponents.test.ts's ad-hoc
// schema idiom (hand-rolled CREATE TABLEs pared to exactly what this feature
// reads/writes) rather than the full migration chain, with `idea_components`
// itself read straight from migration 101 so a future column or
// CHECK-constraint change cannot silently miss this copy.
// ---------------------------------------------------------------------------

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  const migDir = join(__dirname, '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '101_idea_component_ledger.sql'), 'utf-8'));
  db.exec(`
    CREATE TABLE ideas (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE approved_designs (id TEXT PRIMARY KEY, idea_id TEXT NOT NULL, superseded_at TEXT);
    CREATE TABLE epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_epic_id TEXT, originating_idea_id TEXT);
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, seed_idea_id TEXT, seed_idea_ids TEXT);
    CREATE TABLE entity_events (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, run_id TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, atype TEXT NOT NULL);
  `);
  return db;
}

function insertIdea(db: Database.Database, id: string, body: string | null = null): void {
  db.prepare('INSERT INTO ideas (id, body) VALUES (?, ?)').run(id, body);
}

const ARCH_DESIGN_BODY = '## Architecture design\n\nSome arch content.\n';

function rowCount(db: Database.Database, ideaId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM idea_components WHERE idea_id = ?')
    .get(ideaId) as { n: number };
  return row.n;
}

function rawRow(
  db: Database.Database,
  ideaId: string,
  component: string,
): {
  state: string;
  source: string;
  source_run_id: string | null;
  built_against_version: number | null;
  stale_at: string | null;
  stale_reason: string | null;
} | undefined {
  return db
    .prepare(
      `SELECT state, source, source_run_id, built_against_version, stale_at, stale_reason
         FROM idea_components WHERE idea_id = ? AND component = ?`,
    )
    .get(ideaId, component) as
    | {
        state: string;
        source: string;
        source_run_id: string | null;
        built_against_version: number | null;
        stale_at: string | null;
        stale_reason: string | null;
      }
    | undefined;
}

describe('IdeaComponentRouter', () => {
  afterEach(() => {
    IdeaComponentRouter._resetForTesting();
    ideaComponentChangeEvents.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // setComponentState — UPSERT
  // -------------------------------------------------------------------------

  it('setComponentState inserts a row on first call, updates it in place on the second', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'incomplete',
      source: 'flow',
      sourceRunId: 'run-1',
    });
    expect(rowCount(db, 'idea-1')).toBe(1);
    expect(rawRow(db, 'idea-1', 'architecture')).toMatchObject({
      state: 'incomplete',
      source: 'flow',
      source_run_id: 'run-1',
    });

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'complete',
      source: 'flow',
      sourceRunId: 'run-2',
      builtAgainstVersion: 3,
    });
    // Still exactly one row for (idea-1, architecture) — UPSERT, not a second insert.
    expect(rowCount(db, 'idea-1')).toBe(1);
    expect(rawRow(db, 'idea-1', 'architecture')).toMatchObject({
      state: 'complete',
      source: 'flow',
      source_run_id: 'run-2',
      built_against_version: 3,
    });
  });

  it('setComponentState always clears a previously-set stale flag, even when re-affirming a non-complete state', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'stories',
      state: 'complete',
      source: 'flow',
    });
    await router.applyChange(1, { op: 'mark-stale', ideaId: 'idea-1', staleReason: 'body changed' });
    expect(rawRow(db, 'idea-1', 'stories')?.stale_at).not.toBeNull();

    // Re-affirming 'incomplete' (not 'complete') still clears the stale flag —
    // an explicit write is a reviewed judgment, not a stale carry-over.
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'stories',
      state: 'incomplete',
      source: 'manual',
    });
    const row = rawRow(db, 'idea-1', 'stories');
    expect(row?.state).toBe('incomplete');
    expect(row?.stale_at).toBeNull();
    expect(row?.stale_reason).toBeNull();
  });

  // -------------------------------------------------------------------------
  // markStale
  // -------------------------------------------------------------------------

  it('markStale flips only currently-complete rows; skipped and incomplete rows are untouched', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'complete',
      source: 'flow',
    });
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'epics',
      state: 'skipped',
      source: 'manual',
    });
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'stories',
      state: 'incomplete',
      source: 'flow',
    });

    await router.applyChange(1, { op: 'mark-stale', ideaId: 'idea-1', staleReason: 'body changed' });

    const architecture = rawRow(db, 'idea-1', 'architecture');
    expect(architecture?.state).toBe('incomplete');
    expect(architecture?.stale_at).not.toBeNull();
    expect(architecture?.stale_reason).toBe('body changed');

    const epics = rawRow(db, 'idea-1', 'epics');
    expect(epics?.state).toBe('skipped');
    expect(epics?.stale_at).toBeNull();

    const stories = rawRow(db, 'idea-1', 'stories');
    expect(stories?.state).toBe('incomplete');
    expect(stories?.stale_at).toBeNull();
  });

  it('markStale with a components filter only touches complete rows within that filter', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    // Every component starts 'complete' — mimics an idea that finished a full pass.
    for (const component of ['idea-spec', 'architecture', 'epics'] as const) {
      await router.applyChange(1, {
        op: 'set-component-state',
        ideaId: 'idea-1',
        component,
        state: 'complete',
        source: 'flow',
      });
    }

    // Filtered mark-stale (the idea-body-change hook's shape): only 'architecture'
    // and 'epics' are candidates — 'idea-spec' is excluded even though it is
    // 'complete', because it is not in the filter.
    await router.applyChange(1, {
      op: 'mark-stale',
      ideaId: 'idea-1',
      staleReason: 'body changed',
      components: ['architecture', 'epics'],
    });

    const ideaSpec = rawRow(db, 'idea-1', 'idea-spec');
    expect(ideaSpec?.state).toBe('complete');
    expect(ideaSpec?.stale_at).toBeNull();

    const architecture = rawRow(db, 'idea-1', 'architecture');
    expect(architecture?.state).toBe('incomplete');
    expect(architecture?.stale_at).not.toBeNull();

    const epics = rawRow(db, 'idea-1', 'epics');
    expect(epics?.state).toBe('incomplete');
    expect(epics?.stale_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // markStale — the DERIVED half of the hybrid model. A candidate with NO
  // ledger row that derives 'complete' must be materialized into a stale row;
  // otherwise derivation (a live read of the very thing that just changed)
  // keeps answering 'complete' forever. Every idea planned before migration
  // 101 has zero rows, so an existing-rows-only pass was a no-op on the whole
  // pre-existing backlog.
  // -------------------------------------------------------------------------

  it('markStale MATERIALIZES a stale row for a derived-complete component with no ledger row', async () => {
    const db = buildDb();
    // The body still carries '## Architecture design', so 'architecture'
    // derives complete — and it is derived FROM the body that just changed,
    // which is exactly the case worth flagging.
    insertIdea(db, 'idea-1', ARCH_DESIGN_BODY);
    const router = IdeaComponentRouter.initialize(dbAdapter(db));
    expect(rowCount(db, 'idea-1')).toBe(0);

    await router.applyChange(1, {
      op: 'mark-stale',
      ideaId: 'idea-1',
      staleReason: 'idea body changed',
      components: ['prototype', 'architecture', 'epics', 'stories'],
    });

    // Exactly one row minted — only 'architecture' derived complete.
    expect(rowCount(db, 'idea-1')).toBe(1);
    const architecture = rawRow(db, 'idea-1', 'architecture');
    expect(architecture?.state).toBe('incomplete');
    expect(architecture?.stale_at).not.toBeNull();
    expect(architecture?.stale_reason).toBe('idea body changed');
    // 'flow', not 'manual' — 'manual' is the card's human-override marker, and
    // stamping it here would claim a person reviewed this component.
    expect(architecture?.source).toBe('flow');

    // The read model now says "needs review" rather than "complete".
    const resolved = resolveIdeaComponents(dbAdapter(db), 'idea-1').find(
      (s) => s.component === 'architecture',
    )!;
    expect(resolved.state).toBe('incomplete');
    expect(resolved.staleAt).not.toBeNull();
  });

  it('markStale materializes nothing for a component that derives INCOMPLETE', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', 'a plain body with no headings');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'mark-stale',
      ideaId: 'idea-1',
      staleReason: 'idea body changed',
      components: ['prototype', 'architecture', 'epics', 'stories'],
    });

    // Nothing derived complete, so nothing was frozen — the ledger stays empty
    // and every component keeps re-deriving on read.
    expect(rowCount(db, 'idea-1')).toBe(0);
  });

  it('markStale never materializes over an EXISTING row (skipped and incomplete both survive)', async () => {
    const db = buildDb();
    // Body derives 'architecture' complete AND a child epic derives 'epics'
    // complete — but both already carry rows, which always win over derivation.
    insertIdea(db, 'idea-1', ARCH_DESIGN_BODY);
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-1', 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'skipped',
      source: 'manual',
    });
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'epics',
      state: 'incomplete',
      source: 'flow',
    });

    await router.applyChange(1, {
      op: 'mark-stale',
      ideaId: 'idea-1',
      staleReason: 'idea body changed',
      components: ['prototype', 'architecture', 'epics', 'stories'],
    });

    expect(rowCount(db, 'idea-1')).toBe(2);
    const architecture = rawRow(db, 'idea-1', 'architecture');
    expect(architecture?.state).toBe('skipped');
    expect(architecture?.stale_at).toBeNull();
    const epics = rawRow(db, 'idea-1', 'epics');
    expect(epics?.state).toBe('incomplete');
    expect(epics?.stale_at).toBeNull();
  });

  it('markStale materializes only within the components filter', async () => {
    const db = buildDb();
    // Both 'architecture' (body heading) and 'epics' (a child epic) derive
    // complete; the filter admits only 'epics'.
    insertIdea(db, 'idea-1', ARCH_DESIGN_BODY);
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc-1', 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'mark-stale',
      ideaId: 'idea-1',
      staleReason: 'arch section changed',
      components: ['epics', 'stories'],
    });

    expect(rowCount(db, 'idea-1')).toBe(1);
    expect(rawRow(db, 'idea-1', 'epics')?.stale_at).not.toBeNull();
    expect(rawRow(db, 'idea-1', 'architecture')).toBeUndefined();
  });

  it('a materialized stale row is restorable by clearStale, like any other stale row', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', ARCH_DESIGN_BODY);
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'mark-stale',
      ideaId: 'idea-1',
      staleReason: 'idea body changed',
      components: ['architecture'],
    });
    await router.applyChange(1, { op: 'clear-stale', ideaId: 'idea-1', component: 'architecture' });

    const row = rawRow(db, 'idea-1', 'architecture');
    expect(row?.state).toBe('complete');
    expect(row?.stale_at).toBeNull();
  });

  it('markStale is a no-op when the idea has no complete rows', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    const result = await router.applyChange(1, {
      op: 'mark-stale',
      ideaId: 'idea-1',
      staleReason: 'body changed',
    });
    expect(rowCount(db, 'idea-1')).toBe(0);
    expect(result.states).toHaveLength(5);
  });

  // -------------------------------------------------------------------------
  // clearStale
  // -------------------------------------------------------------------------

  it('clearStale drops stale_at/stale_reason and restores complete', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'idea-spec',
      state: 'complete',
      source: 'flow',
    });
    await router.applyChange(1, { op: 'mark-stale', ideaId: 'idea-1', staleReason: 'body changed' });
    expect(rawRow(db, 'idea-1', 'idea-spec')?.state).toBe('incomplete');
    expect(rawRow(db, 'idea-1', 'idea-spec')?.stale_at).not.toBeNull();

    await router.applyChange(1, { op: 'clear-stale', ideaId: 'idea-1', component: 'idea-spec' });
    const row = rawRow(db, 'idea-1', 'idea-spec');
    expect(row?.stale_at).toBeNull();
    expect(row?.stale_reason).toBeNull();
    // clearStale is the exact inverse of markStale: a non-NULL stale_at can
    // only have come from a row that was 'complete', so re-verifying it must
    // land back on 'complete'. Leaving it 'incomplete' would be
    // indistinguishable from "never started".
    expect(row?.state).toBe('complete');
  });

  it('clearStale rejects a component with no ledger row (not_found)', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await expect(
      router.applyChange(1, { op: 'clear-stale', ideaId: 'idea-1', component: 'prototype' }),
    ).rejects.toMatchObject({ code: 'not_found' } satisfies Partial<IdeaComponentError>);
  });

  it('clearStale is idempotent on a row that is already non-stale', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'epics',
      state: 'incomplete',
      source: 'flow',
    });
    await expect(
      router.applyChange(1, { op: 'clear-stale', ideaId: 'idea-1', component: 'epics' }),
    ).resolves.toBeDefined();
    expect(rawRow(db, 'idea-1', 'epics')?.state).toBe('incomplete');
  });

  // -------------------------------------------------------------------------
  // deleteForIdea
  // -------------------------------------------------------------------------

  it('deleteForIdea removes every row for the target idea and leaves a sibling idea untouched', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    insertIdea(db, 'idea-2');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'architecture',
      state: 'complete',
      source: 'flow',
    });
    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-2',
      component: 'architecture',
      state: 'complete',
      source: 'flow',
    });

    await router.applyChange(1, { op: 'delete-for-idea', ideaId: 'idea-1' });

    expect(rowCount(db, 'idea-1')).toBe(0);
    expect(rowCount(db, 'idea-2')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Change event
  // -------------------------------------------------------------------------

  it('emits on the project channel after commit, carrying the full merged snapshot', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1');
    const router = IdeaComponentRouter.initialize(dbAdapter(db));

    const received: IdeaComponentChangedEvent[] = [];
    ideaComponentChangeEvents.on(ideaComponentProjectChannel(1), (ev: IdeaComponentChangedEvent) => {
      received.push(ev);
    });

    await router.applyChange(1, {
      op: 'set-component-state',
      ideaId: 'idea-1',
      component: 'prototype',
      state: 'complete',
      source: 'flow',
    });

    expect(received).toHaveLength(1);
    expect(received[0].projectId).toBe(1);
    expect(received[0].ideaId).toBe('idea-1');
    expect(received[0].states).toHaveLength(5);
    expect(received[0].states).toEqual(resolveIdeaComponents(dbAdapter(db) as DatabaseLike, 'idea-1'));
  });
});
