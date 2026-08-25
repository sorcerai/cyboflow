/**
 * Unit tests for `listIdeaArtifactLinks` (main/src/orchestrator/ideaArtifacts.ts)
 * — the read model behind `cyboflow.artifacts.listForIdea`.
 *
 * `resolveIdeaComponents` itself already has its own exhaustive suite
 * (`ideaComponents/__tests__/resolveIdeaComponents.test.ts`); these tests pin
 * ONLY the artifact-resolution layer on top of it — feeding hand-crafted
 * ledger rows in and a fake `listForRun` so every case is deterministic and
 * exercises no real ArtifactRouter/DB artifact writes.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { listIdeaArtifactLinks, type IdeaArtifactsDeps } from '../ideaArtifacts';
import { IDEA_COMPONENT_KEYS, type IdeaComponentKey } from '../../../../shared/types/ideaComponents';
import { COMBINED_BATCH_PAYLOAD_JSON, type Artifact, type ArtifactType } from '../../../../shared/types/artifacts';

const PROJECT_ID = 1;

/** Same minimal ad-hoc schema as `resolveIdeaComponents.test.ts`, plus a
 *  `project_id` column on `workflow_runs` (this module's own cross-project
 *  guard reads it; resolveIdeaComponents.test.ts's buildDb doesn't need it). */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  db.exec(readFileSync(join(migDir, '101_idea_component_ledger.sql'), 'utf-8'));
  db.exec(`
    CREATE TABLE ideas (id TEXT PRIMARY KEY, body TEXT);
    CREATE TABLE approved_designs (
      id TEXT PRIMARY KEY,
      idea_id TEXT NOT NULL,
      superseded_at TEXT
    );
    CREATE TABLE epics (id TEXT PRIMARY KEY, originating_idea_id TEXT);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_epic_id TEXT,
      originating_idea_id TEXT
    );
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      project_id INTEGER,
      seed_idea_id TEXT,
      seed_idea_ids TEXT
    );
    CREATE TABLE entity_events (
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      run_id TEXT
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      atype TEXT NOT NULL
    );
  `);
  return db;
}

function insertIdea(db: Database.Database, id: string, body: string | null = null): void {
  db.prepare('INSERT INTO ideas (id, body) VALUES (?, ?)').run(id, body);
}

function insertRun(db: Database.Database, id: string, projectId: number | null): void {
  db.prepare('INSERT INTO workflow_runs (id, project_id) VALUES (?, ?)').run(id, projectId);
}

/** Insert an AUTHORITATIVE ledger row — mirrors resolveIdeaComponents.test.ts's insertLedgerRow. */
function insertLedgerRow(
  db: Database.Database,
  ideaId: string,
  component: IdeaComponentKey,
  fields: {
    state: 'complete' | 'incomplete' | 'skipped';
    source?: 'flow' | 'manual';
    sourceRunId?: string | null;
    staleAt?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO idea_components
       (idea_id, project_id, component, state, source, source_run_id, source_session_id,
        built_against_version, stale_at, stale_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run(
    ideaId,
    PROJECT_ID,
    component,
    fields.state,
    fields.source ?? 'flow',
    fields.sourceRunId ?? null,
    fields.staleAt ?? null,
  );
}

/** Build a minimal, fully-shaped fake `Artifact` (defaults chosen so every
 *  field is present and type-checks — only the fields a given test cares
 *  about are overridden). */
function fakeArtifact(overrides: Partial<Artifact> & { runId: string; atype: ArtifactType }): Artifact {
  return {
    id: `art_${overrides.atype}_${overrides.sourceRef ?? 'x'}`,
    sessionId: null,
    label: 'Label',
    stepOrigin: null,
    mode: 'template',
    committed: false,
    sessionOnly: true,
    isNew: false,
    payloadJson: null,
    sourceRef: null,
    createdAt: '2026-01-01T00:00:00Z',
    committedAt: null,
    ...overrides,
  };
}

/** A `listForRun` fake keyed by runId, with a call-count tracker so a test
 *  can assert "ONE listForRun call per distinct run" — never per component. */
function fakeListForRun(byRun: Record<string, Artifact[]>): {
  listForRun: IdeaArtifactsDeps['listForRun'];
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    listForRun: async (_projectId: number, runId: string): Promise<Artifact[]> => {
      calls.push(runId);
      return byRun[runId] ?? [];
    },
  };
}

function pick(links: Awaited<ReturnType<typeof listIdeaArtifactLinks>>, component: IdeaComponentKey) {
  const found = links.find((l) => l.component === component);
  if (!found) throw new Error(`missing component ${component} in resolved links`);
  return found;
}

describe('listIdeaArtifactLinks', () => {
  it('always returns all five components, in IDEA_COMPONENT_KEYS order, with null artifact for a bare idea', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null); // no body -> every component derives to incomplete/derived, sourceRunId null
    const { listForRun } = fakeListForRun({});
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(links.map((l) => l.component)).toEqual([...IDEA_COMPONENT_KEYS]);
    expect(links.every((l) => l.artifact === null)).toBe(true);
  });

  it('a null sourceRunId (derived component) resolves to artifact:null without calling listForRun', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertLedgerRow(db, 'idea-1', 'architecture', { state: 'incomplete', sourceRunId: null });
    const { listForRun, calls } = fakeListForRun({});
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(pick(links, 'architecture').artifact).toBeNull();
    expect(calls).toEqual([]);
  });

  it('a sourceRunId naming a run with NO workflow_runs row resolves to artifact:null', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertLedgerRow(db, 'idea-1', 'idea-spec', { state: 'complete', sourceRunId: 'run-missing' });
    const { listForRun, calls } = fakeListForRun({});
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(pick(links, 'idea-spec').artifact).toBeNull();
    expect(calls).toEqual([]); // never fetched — the run doesn't resolve at all
  });

  it('a sourceRunId naming a run belonging to a DIFFERENT project resolves to artifact:null', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertRun(db, 'run-other-project', 999);
    insertLedgerRow(db, 'idea-1', 'idea-spec', { state: 'complete', sourceRunId: 'run-other-project' });
    const { listForRun, calls } = fakeListForRun({
      'run-other-project': [fakeArtifact({ runId: 'run-other-project', atype: 'idea-spec', sourceRef: 'idea-1' })],
    });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(pick(links, 'idea-spec').artifact).toBeNull();
    expect(calls).toEqual([]); // the cross-project run is treated as absent before any fetch
  });

  it('a run with neither a matching DB row nor a snapshot (listForRun -> []) resolves to artifact:null', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertRun(db, 'run-1', PROJECT_ID);
    insertLedgerRow(db, 'idea-1', 'idea-spec', { state: 'complete', sourceRunId: 'run-1' });
    const { listForRun, calls } = fakeListForRun({ 'run-1': [] });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(pick(links, 'idea-spec').artifact).toBeNull();
    expect(calls).toEqual(['run-1']); // still fetched — the run itself is valid, just empty
  });

  it('a direct source_ref hit resolves idea-spec to that artifact', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertRun(db, 'run-1', PROJECT_ID);
    insertLedgerRow(db, 'idea-1', 'idea-spec', { state: 'complete', sourceRunId: 'run-1' });
    const target = fakeArtifact({
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      id: 'art_direct',
      label: 'Idea One',
      committed: true,
    });
    const { listForRun } = fakeListForRun({ 'run-1': [target] });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(pick(links, 'idea-spec').artifact).toEqual({
      runId: 'run-1',
      artifactId: 'art_direct',
      atype: 'idea-spec',
      committed: true,
      label: 'Idea One',
    });
  });

  it('falls back to a COMBINED-batch idea-spec artifact for a non-first idea with no direct source_ref hit', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-2', null); // NOT the batch's first idea
    insertRun(db, 'run-1', PROJECT_ID);
    insertLedgerRow(db, 'idea-2', 'idea-spec', { state: 'complete', sourceRunId: 'run-1' });
    // The combined tab's source_ref anchors on the batch's FIRST idea ('idea-1'),
    // not 'idea-2' — a direct sourceRef match would miss it.
    const combined = fakeArtifact({
      runId: 'run-1',
      atype: 'idea-spec',
      sourceRef: 'idea-1',
      id: 'art_combined',
      label: 'Idea specs · 2 ideas',
      payloadJson: COMBINED_BATCH_PAYLOAD_JSON,
    });
    const { listForRun } = fakeListForRun({ 'run-1': [combined] });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-2');

    expect(pick(links, 'idea-spec').artifact?.artifactId).toBe('art_combined');
  });

  it('architecture has NO combined-batch fallback — a non-matching source_ref stays null', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-2', null);
    insertRun(db, 'run-1', PROJECT_ID);
    insertLedgerRow(db, 'idea-2', 'architecture', { state: 'complete', sourceRunId: 'run-1' });
    const otherIdeasDesign = fakeArtifact({ runId: 'run-1', atype: 'arch-design', sourceRef: 'idea-1' });
    const { listForRun } = fakeListForRun({ 'run-1': [otherIdeasDesign] });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-2');

    expect(pick(links, 'architecture').artifact).toBeNull();
  });

  it('prototype prefers interactive-prototype over ui-prototype when a run carries both', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertRun(db, 'run-1', PROJECT_ID);
    insertLedgerRow(db, 'idea-1', 'prototype', { state: 'complete', sourceRunId: 'run-1' });
    const staticProto = fakeArtifact({ runId: 'run-1', atype: 'ui-prototype', id: 'art_static' });
    const interactiveProto = fakeArtifact({ runId: 'run-1', atype: 'interactive-prototype', id: 'art_interactive' });
    const { listForRun } = fakeListForRun({ 'run-1': [staticProto, interactiveProto] });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(pick(links, 'prototype').artifact?.artifactId).toBe('art_interactive');
  });

  it('prototype falls back to ui-prototype when interactive-prototype is absent', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertRun(db, 'run-1', PROJECT_ID);
    insertLedgerRow(db, 'idea-1', 'prototype', { state: 'complete', sourceRunId: 'run-1' });
    const staticProto = fakeArtifact({ runId: 'run-1', atype: 'ui-prototype', id: 'art_static' });
    const { listForRun } = fakeListForRun({ 'run-1': [staticProto] });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(pick(links, 'prototype').artifact?.artifactId).toBe('art_static');
  });

  it('epics and stories both resolve to the SAME run-wide decomposed-stories artifact', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertRun(db, 'run-1', PROJECT_ID);
    insertLedgerRow(db, 'idea-1', 'epics', { state: 'complete', sourceRunId: 'run-1' });
    insertLedgerRow(db, 'idea-1', 'stories', { state: 'complete', sourceRunId: 'run-1' });
    const stories = fakeArtifact({ runId: 'run-1', atype: 'decomposed-stories', id: 'art_stories' });
    const { listForRun, calls } = fakeListForRun({ 'run-1': [stories] });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(pick(links, 'epics').artifact?.artifactId).toBe('art_stories');
    expect(pick(links, 'stories').artifact?.artifactId).toBe('art_stories');
    // ONE listForRun call for the shared run, not one per component.
    expect(calls).toEqual(['run-1']);
  });

  it('issues exactly one listForRun call per DISTINCT run even when several components share it', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertRun(db, 'run-1', PROJECT_ID);
    insertLedgerRow(db, 'idea-1', 'idea-spec', { state: 'complete', sourceRunId: 'run-1' });
    insertLedgerRow(db, 'idea-1', 'architecture', { state: 'complete', sourceRunId: 'run-1' });
    insertLedgerRow(db, 'idea-1', 'prototype', { state: 'complete', sourceRunId: 'run-1' });
    const { listForRun, calls } = fakeListForRun({ 'run-1': [] });
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    expect(calls).toEqual(['run-1']);
  });

  it('preserves staleAt on the returned link (needs-review signal survives the artifact join)', async () => {
    const db = buildDb();
    insertIdea(db, 'idea-1', null);
    insertLedgerRow(db, 'idea-1', 'architecture', {
      state: 'incomplete',
      sourceRunId: null,
      staleAt: '2026-02-01T00:00:00Z',
    });
    const { listForRun } = fakeListForRun({});
    const deps: IdeaArtifactsDeps = { db: dbAdapter(db), listForRun };

    const links = await listIdeaArtifactLinks(deps, PROJECT_ID, 'idea-1');

    const arch = pick(links, 'architecture');
    expect(arch.state).toBe('incomplete');
    expect(arch.staleAt).toBe('2026-02-01T00:00:00Z');
    expect(arch.artifact).toBeNull();
  });
});
