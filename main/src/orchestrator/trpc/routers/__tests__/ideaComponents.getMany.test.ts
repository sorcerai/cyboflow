/**
 * Integration tests for `cyboflow.ideaComponents.getMany` — the batched ledger
 * read behind the COMBINED multi-idea idea-summary tab.
 *
 * The combined tab zips this result POSITIONALLY against its own idea list
 * (`tasks.runDecomposition`), so the contract that actually matters is not
 * "resolves the right states" (`resolveIdeaComponents` already owns that, and
 * has its own suite) but the SHAPE: one entry per REQUESTED id, in the requested
 * order, with unknown and duplicated ids still producing an entry. A dropped or
 * reordered row would silently shift every idea's status cells one place to the
 * left in the matrix — the exact silent-drop failure the pairing exists to
 * prevent — so those are what this pins, against the live router.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { IDEA_COMPONENT_KEYS } from '../../../../../../shared/types/ideaComponents';

/**
 * Minimal schema — the `resolveIdeaComponents.test.ts` idiom: hand-rolled
 * CREATE TABLEs pared to what the resolver reads, with `idea_components` itself
 * taken straight from migration 101 so a column/CHECK change cannot silently
 * miss this copy.
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  const migDir = join(__dirname, '..', '..', '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '101_idea_component_ledger.sql'), 'utf-8'));
  db.exec(`
    CREATE TABLE ideas (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE approved_designs (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL,
      superseded_at TEXT
    );
    CREATE TABLE epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, parent_epic_id TEXT, originating_idea_id TEXT);
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, seed_idea_id TEXT, seed_idea_ids TEXT);
    CREATE TABLE entity_events (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, run_id TEXT);
    CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, atype TEXT NOT NULL);
  `);
  return db;
}

function buildCaller(): {
  caller: ReturnType<typeof appRouter.createCaller>;
  db: Database.Database;
} {
  const db = buildDb();
  return { caller: appRouter.createCaller(createContext({ db: dbAdapter(db) })), db };
}

function insertIdea(db: Database.Database, id: string, body: string | null): void {
  db.prepare('INSERT INTO ideas (id, body) VALUES (?, ?)').run(id, body);
}

describe('cyboflow.ideaComponents.getMany', () => {
  it('returns one entry per requested id, IN the requested order', async () => {
    const { caller, db } = buildCaller();
    insertIdea(db, 'idea-a', '## Idea spec\n\nspec A');
    insertIdea(db, 'idea-b', null);
    insertIdea(db, 'idea-c', '## Idea spec\n\nspec C');

    // Deliberately NOT insertion order — the caller's order is what must survive.
    const rows = await caller.cyboflow.ideaComponents.getMany({
      ideaIds: ['idea-c', 'idea-a', 'idea-b'],
    });

    expect(rows.map((r) => r.ideaId)).toEqual(['idea-c', 'idea-a', 'idea-b']);
  });

  it('always returns all five components per entry, in IDEA_COMPONENT_KEYS order', async () => {
    const { caller, db } = buildCaller();
    insertIdea(db, 'idea-a', '## Idea spec\n\nspec A');
    insertIdea(db, 'idea-b', null);

    const rows = await caller.cyboflow.ideaComponents.getMany({ ideaIds: ['idea-a', 'idea-b'] });

    for (const row of rows) {
      expect(row.states.map((s) => s.component)).toEqual([...IDEA_COMPONENT_KEYS]);
    }
  });

  it('agrees with the single-idea `get` for the same idea', async () => {
    const { caller, db } = buildCaller();
    insertIdea(db, 'idea-a', '## Idea spec\n\nspec A');
    db.prepare(
      `INSERT INTO idea_components
         (idea_id, project_id, component, state, source, stale_at, created_at, updated_at)
       VALUES ('idea-a', 1, 'prototype', 'skipped', 'manual', NULL, '2026-01-01', '2026-01-01')`,
    ).run();

    const one = await caller.cyboflow.ideaComponents.get({ ideaId: 'idea-a' });
    const many = await caller.cyboflow.ideaComponents.getMany({ ideaIds: ['idea-a'] });

    expect(many).toHaveLength(1);
    expect(many[0].states).toEqual(one);
  });

  it('does NOT drop an UNKNOWN id — it resolves like a blank idea', async () => {
    const { caller, db } = buildCaller();
    insertIdea(db, 'idea-a', '## Idea spec\n\nspec A');

    const rows = await caller.cyboflow.ideaComponents.getMany({
      ideaIds: ['idea-a', 'idea-gone', 'idea-a'],
    });

    // Three requested, three back: a dropped middle row would shift 'idea-a's
    // states onto the wrong idea in the caller's positional zip.
    expect(rows.map((r) => r.ideaId)).toEqual(['idea-a', 'idea-gone', 'idea-a']);
    expect(rows[1].states.map((s) => s.component)).toEqual([...IDEA_COMPONENT_KEYS]);
    expect(rows[1].states.every((s) => s.state === 'incomplete' && s.source === 'derived')).toBe(true);
    // A duplicate id is resolved once and ECHOED, not collapsed.
    expect(rows[2].states).toEqual(rows[0].states);
  });

  it('returns [] for an empty request', async () => {
    const { caller } = buildCaller();
    await expect(caller.cyboflow.ideaComponents.getMany({ ideaIds: [] })).resolves.toEqual([]);
  });

  it('rejects a batch beyond the input cap', async () => {
    const { caller } = buildCaller();
    const tooMany = Array.from({ length: 201 }, (_, i) => `idea-${i}`);
    await expect(caller.cyboflow.ideaComponents.getMany({ ideaIds: tooMany })).rejects.toThrow();
  });
});
