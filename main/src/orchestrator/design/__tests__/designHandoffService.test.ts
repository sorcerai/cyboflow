/**
 * Unit tests for the Design Mode v0 Approve state machine (LANE G,
 * docs/ideas/design-mode.md "Approve — intent-first recoverable state machine").
 *
 * Driven against a REAL temp DB carrying the full migration chain (through 082)
 * via DatabaseService.initialize(), so ideas/entity_events/board_stages/artifacts/
 * sessions/design_* all behave exactly as in production. The idea under design is
 * created through the TaskChangeRouter chokepoint (real version + stage + created
 * event); the session/chat-run/prototype/draft are seeded raw.
 *
 * Coverage (design-mode.md v0 acceptance):
 *  (a) happy path intent -> snapshotted -> folded -> complete; body fold
 *      creates the '## Design spec' section; approved_designs current row present;
 *      entity_events carries kind 'design-spec-folded'; idea version bumped once.
 *  (b) stale-draft CAS: prototype advanced after the draft was written -> reject
 *      'stale-draft' with NO side effects (no handoff row; body unchanged).
 *  (c) stale idea version -> fold rejects, handoff 'superseded', body/version unchanged.
 *  (d) crash at every boundary (stop after intent / snapshotted / folded) ->
 *      recoverDesignHandoffs converges to complete, ONE current approved row, no
 *      double fold (exactly one '## Design spec' section, version bumped once).
 *  (e) re-approve of a newer draft supersedes the prior approved row.
 *  (f) fold+transition atomicity: a failed Step 2 handoff-state UPDATE rolls the
 *      body write back with it.
 * Plus: entityBodyFold CAS units + the approvedDesigns read model.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../../database/database';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { TaskChangeRouter } from '../../taskChangeRouter';
import { ArtifactRouter } from '../../artifactRouter';
import { ReviewItemRouter } from '../../reviewItemRouter';
import { IdeaComponentRouter } from '../../ideaComponents/ideaComponentRouter';
import { resolveIdeaComponents } from '../../ideaComponents/resolveIdeaComponents';
import type { DatabaseLike } from '../../types';
import type { DesignHandoffRow } from '../../../database/models';
import {
  approveDesign,
  runSnapshotStep,
  runFoldStep,
  type DesignHandoffDeps,
} from '../designHandoffService';
import { recoverDesignHandoffs } from '../designHandoffRecovery';
import { coWriteIdeaBodyReplace } from '../entityBodyFold';
import { getCurrentApprovedDesign, listApprovedDesignHistory } from '../approvedDesigns';

const MIG_DIR = join(__dirname, '..', '..', '..', 'database', 'migrations');

const SESSION = 'sess-design';
const CHAT_RUN = 'run-chat';
const ARTIFACT = 'art-proto';
const PROTO_HTML = '<!doctype html><html><body><h1>left rail prototype</h1></body></html>';
const CLOCK = '2026-07-22T12:00:00.000Z';

interface Harness {
  svc: DatabaseService;
  db: DatabaseLike;
  projectId: number;
  ideaId: string;
  dir: string;
  snapDir: string;
}

let active: Harness | null = null;

/** Count fenced/line occurrences of the '## Design spec' heading in a body. */
function designSpecHeadingCount(body: string): number {
  return body.split(/\r?\n/).filter((l) => /^##[ \t]+Design spec[ \t]*$/i.test(l)).length;
}

function ideaRow(db: DatabaseLike, ideaId: string): { version: number; body: string | null } {
  return db.prepare('SELECT version, body FROM ideas WHERE id = ?').get(ideaId) as {
    version: number;
    body: string | null;
  };
}

function handoffRow(db: DatabaseLike, id: string): DesignHandoffRow | undefined {
  return db.prepare('SELECT * FROM design_handoffs WHERE id = ?').get(id) as
    | DesignHandoffRow
    | undefined;
}

function insertArtifact(db: DatabaseLike, id: string, revision: number): void {
  db.prepare(
    `INSERT INTO artifacts (id, run_id, session_id, atype, label, mode, revision, payload_json)
     VALUES (?, ?, ?, 'ui-prototype', 'Prototype', 'canvas', ?, ?)`,
  ).run(id, CHAT_RUN, SESSION, revision, JSON.stringify({ fileName: 'prototype/index.html' }));
}

function insertDraft(
  db: DatabaseLike,
  opts: { id: string; ideaId: string; revision: number; boundId: string | null; boundRev: number | null; spec: string },
): void {
  db.prepare(
    `INSERT INTO design_spec_drafts
       (id, session_id, idea_id, draft_revision, spec_markdown, bound_artifact_id, bound_artifact_revision)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(opts.id, SESSION, opts.ideaId, opts.revision, opts.spec, opts.boundId, opts.boundRev);
}

/** Insert a design_handoffs row directly (simulate a crash at `state`). */
function insertHandoff(
  db: DatabaseLike,
  opts: {
    id: string;
    ideaId: string;
    projectId: number;
    draftRevision: number;
    state: DesignHandoffRow['state'];
    expectedIdeaVersion: number;
    snapshotPath?: string | null;
    prototypeRevision?: number;
  },
): void {
  db.prepare(
    `INSERT INTO design_handoffs
       (id, session_id, idea_id, project_id, draft_revision, prototype_artifact_id,
        prototype_revision, expected_idea_version, state, snapshot_path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    SESSION,
    opts.ideaId,
    opts.projectId,
    opts.draftRevision,
    ARTIFACT,
    opts.prototypeRevision ?? 1,
    opts.expectedIdeaVersion,
    opts.state,
    opts.snapshotPath ?? null,
    CLOCK,
    CLOCK,
  );
}

const DRAFT_SPEC = 'The redesigned left rail keeps the run list.\n\n### Baseline\n\n- frontend/src/Rail.tsx';

async function setup(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'cyboflow-design-'));
  const snapDir = mkdtempSync(join(tmpdir(), 'cyboflow-design-snap-'));
  const svc = new DatabaseService(join(dir, 'test.db'));
  svc.setMigrationsDirForTesting(MIG_DIR);
  svc.initialize();
  const rawDb = svc.getDb();
  const db = dbAdapter(rawDb);

  const project = svc.createProject('Design Test', join(dir, 'proj'));
  const projectId = project.id;

  TaskChangeRouter._resetForTesting();
  ArtifactRouter._resetForTesting();
  ReviewItemRouter._resetForTesting();
  // Deliberately NOT initialized here (left null) — most tests in this file
  // exercise approveDesign with the idea component ledger UNINITIALIZED,
  // which is exactly the fail-soft path stampPrototypeComplete must survive
  // (see designHandoffService.ts). Tests that need to observe an actual
  // ledger stamp call IdeaComponentRouter.initialize(db) themselves.
  IdeaComponentRouter._resetForTesting();
  const router = TaskChangeRouter.initialize(db);
  const created = await router.applyChange(projectId, {
    actor: 'user',
    entityType: 'idea',
    title: 'Left rail redesign',
  });
  const ideaId = created.taskId;
  // Set a known body with an unrelated section that the fold must preserve. Raw
  // UPDATE keeps version=1 (Approve's expectedIdeaVersion baseline).
  db.prepare('UPDATE ideas SET body = ? WHERE id = ?').run(
    'Original idea body.\n\n## Notes\n\nkeep this untouched.',
    ideaId,
  );

  // Chat workflow + run (artifact FK + entity_events run_id FK).
  db.prepare("INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', ?, 'design', '{}')").run(
    projectId,
  );
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', ?, 'running', 'default')`,
  ).run(CHAT_RUN, projectId);

  // Design session linked to the idea + its chat run.
  db.prepare(
    `INSERT INTO sessions (id, name, initial_prompt, worktree_name, worktree_path, project_id, chat_run_id, design_idea_id, is_quick)
     VALUES (?, 'Design session', 'design', 'wt', ?, ?, ?, ?, 1)`,
  ).run(SESSION, join(dir, 'wt'), projectId, CHAT_RUN, ideaId);

  insertArtifact(db, ARTIFACT, 1);
  insertDraft(db, { id: 'draft-1', ideaId, revision: 1, boundId: ARTIFACT, boundRev: 1, spec: DRAFT_SPEC });

  active = { svc, db, projectId, ideaId, dir, snapDir };
  return active;
}

function makeDeps(h: Harness, overrides: Partial<DesignHandoffDeps> = {}): DesignHandoffDeps {
  return {
    db: h.db,
    loadPrototypeHtml: async () => PROTO_HTML,
    snapshotBaseDir: h.snapDir,
    now: () => CLOCK,
    ...overrides,
  };
}

afterEach(() => {
  TaskChangeRouter._resetForTesting();
  ArtifactRouter._resetForTesting();
  ReviewItemRouter._resetForTesting();
  IdeaComponentRouter._resetForTesting();
  if (active) {
    active.svc.close();
    rmSync(active.dir, { recursive: true, force: true });
    rmSync(active.snapDir, { recursive: true, force: true });
    active = null;
  }
});

// ---------------------------------------------------------------------------
// (a) Happy path
// ---------------------------------------------------------------------------

describe('approveDesign — happy path (a)', () => {
  it('walks intent -> complete, folds the design spec, publishes the read model, bumps version once', async () => {
    const h = await setup();
    const deps = makeDeps(h);

    const result = await approveDesign(deps, {
      sessionId: SESSION,
      draftRevision: 1,
      expectedIdeaVersion: 1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Handoff reached complete.
    const handoff = handoffRow(h.db, result.handoffId)!;
    expect(handoff.state).toBe('complete');
    expect(handoff.snapshot_path).toBeTruthy();

    // Body fold created exactly one '## Design spec' section, preserved '## Notes'.
    const idea = ideaRow(h.db, h.ideaId);
    expect(idea.body).toContain('## Design spec');
    expect(idea.body).toContain('### Baseline');
    expect(idea.body).toContain('## Notes');
    expect(idea.body).toContain('keep this untouched.');
    expect(designSpecHeadingCount(idea.body ?? '')).toBe(1);
    // Version bumped exactly once (1 -> 2).
    expect(idea.version).toBe(2);

    // entity_events carries the design-spec-folded delta.
    const foldEvent = h.db
      .prepare(
        `SELECT COUNT(*) AS n FROM entity_events
          WHERE entity_type = 'idea' AND entity_id = ? AND kind = 'design-spec-folded'`,
      )
      .get(h.ideaId) as { n: number };
    expect(foldEvent.n).toBe(1);

    // approved_designs: exactly one current row for the idea.
    const current = getCurrentApprovedDesign(h.db, h.ideaId);
    expect(current).not.toBeNull();
    expect(current!.prototypeRevision).toBe(1);
    expect(current!.draftRevision).toBe(1);
    expect(current!.snapshotPath).toBe(handoff.snapshot_path);
    const allCurrent = h.db
      .prepare('SELECT COUNT(*) AS n FROM approved_designs WHERE idea_id = ? AND superseded_at IS NULL')
      .get(h.ideaId) as { n: number };
    expect(allCurrent.n).toBe(1);

    // Snapshot bytes published to disk.
    expect(existsSync(handoff.snapshot_path!)).toBe(true);
    expect(readFileSync(handoff.snapshot_path!, 'utf-8')).toBe(PROTO_HTML);
  });
});

// ---------------------------------------------------------------------------
// (b) Stale-draft CAS
// ---------------------------------------------------------------------------

describe('approveDesign — stale-draft CAS (b)', () => {
  it('rejects when the prototype advanced past the draft, with NO side effects', async () => {
    const h = await setup();
    // Prototype advanced to r2 AFTER the draft (bound to r1) was written.
    h.db.prepare('UPDATE artifacts SET revision = 2 WHERE id = ?').run(ARTIFACT);

    const result = await approveDesign(makeDeps(h), {
      sessionId: SESSION,
      draftRevision: 1,
      expectedIdeaVersion: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('stale-draft');

    // No handoff row minted.
    const handoffs = h.db.prepare('SELECT COUNT(*) AS n FROM design_handoffs').get() as { n: number };
    expect(handoffs.n).toBe(0);
    // Body + version untouched.
    const idea = ideaRow(h.db, h.ideaId);
    expect(idea.body).not.toContain('## Design spec');
    expect(idea.version).toBe(1);
    // No approved design.
    expect(getCurrentApprovedDesign(h.db, h.ideaId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) Stale idea version
// ---------------------------------------------------------------------------

describe('approveDesign — stale idea version (c)', () => {
  it('fold rejects a stale expectedIdeaVersion; handoff lands superseded; body/version unchanged', async () => {
    const h = await setup();

    const result = await approveDesign(makeDeps(h), {
      sessionId: SESSION,
      draftRevision: 1,
      expectedIdeaVersion: 99, // stale
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('stale-idea-version');

    const handoff = handoffRow(h.db, result.handoffId!)!;
    expect(handoff.state).toBe('superseded');

    const idea = ideaRow(h.db, h.ideaId);
    expect(idea.body).not.toContain('## Design spec');
    expect(idea.version).toBe(1);
    expect(getCurrentApprovedDesign(h.db, h.ideaId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) Crash at every boundary -> recovery converges
// ---------------------------------------------------------------------------

describe('recoverDesignHandoffs — crash at every boundary (d)', () => {
  it('resumes an intent handoff to complete', async () => {
    const h = await setup();
    insertHandoff(h.db, {
      id: 'dho-intent',
      ideaId: h.ideaId,
      projectId: h.projectId,
      draftRevision: 1,
      state: 'intent',
      expectedIdeaVersion: 1,
    });

    const summary = await recoverDesignHandoffs(makeDeps(h));
    expect(summary.completed).toBe(1);

    expect(handoffRow(h.db, 'dho-intent')!.state).toBe('complete');
    const idea = ideaRow(h.db, h.ideaId);
    expect(designSpecHeadingCount(idea.body ?? '')).toBe(1);
    expect(idea.version).toBe(2);
    expect(getCurrentApprovedDesign(h.db, h.ideaId)).not.toBeNull();
  });

  it('resumes a snapshotted handoff to complete (one fold, version bumped once)', async () => {
    const h = await setup();
    // Simulate a real Step 1 having run: drive the snapshot step, leaving 'snapshotted'.
    insertHandoff(h.db, {
      id: 'dho-snap',
      ideaId: h.ideaId,
      projectId: h.projectId,
      draftRevision: 1,
      state: 'intent',
      expectedIdeaVersion: 1,
    });
    const step1 = await runSnapshotStep(makeDeps(h), handoffRow(h.db, 'dho-snap')!);
    expect(step1.kind).toBe('advanced');
    expect(handoffRow(h.db, 'dho-snap')!.state).toBe('snapshotted');

    const summary = await recoverDesignHandoffs(makeDeps(h));
    expect(summary.completed).toBe(1);

    expect(handoffRow(h.db, 'dho-snap')!.state).toBe('complete');
    const idea = ideaRow(h.db, h.ideaId);
    expect(designSpecHeadingCount(idea.body ?? '')).toBe(1);
    expect(idea.version).toBe(2);
  });

  it('resumes a folded handoff at Step 3 — no double fold, ONE current approved row', async () => {
    const h = await setup();
    // Drive through the fold: intent -> snapshotted -> folded (body already folded,
    // version already bumped 1 -> 2). A crash here must NOT re-fold on recovery.
    insertHandoff(h.db, {
      id: 'dho-fold',
      ideaId: h.ideaId,
      projectId: h.projectId,
      draftRevision: 1,
      state: 'intent',
      expectedIdeaVersion: 1,
    });
    await runSnapshotStep(makeDeps(h), handoffRow(h.db, 'dho-fold')!);
    const step2 = await runFoldStep(makeDeps(h), handoffRow(h.db, 'dho-fold')!);
    expect(step2.kind).toBe('advanced');
    expect(handoffRow(h.db, 'dho-fold')!.state).toBe('folded');
    // Body folded, version already bumped once.
    expect(ideaRow(h.db, h.ideaId).version).toBe(2);
    expect(designSpecHeadingCount(ideaRow(h.db, h.ideaId).body ?? '')).toBe(1);

    const summary = await recoverDesignHandoffs(makeDeps(h));
    expect(summary.completed).toBe(1);

    expect(handoffRow(h.db, 'dho-fold')!.state).toBe('complete');
    const idea = ideaRow(h.db, h.ideaId);
    // No double fold: still exactly one section, version still 2.
    expect(designSpecHeadingCount(idea.body ?? '')).toBe(1);
    expect(idea.version).toBe(2);
    const currentCount = h.db
      .prepare('SELECT COUNT(*) AS n FROM approved_designs WHERE idea_id = ? AND superseded_at IS NULL')
      .get(h.ideaId) as { n: number };
    expect(currentCount.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (e) Re-approve supersedes the prior approved design
// ---------------------------------------------------------------------------

describe('approveDesign — re-approve supersedes (e)', () => {
  it('a newer draft supersedes the prior approved_designs row (old retained, new current)', async () => {
    const h = await setup();

    // First approval (draft r1 / prototype r1 / idea v1).
    const first = await approveDesign(makeDeps(h), {
      sessionId: SESSION,
      draftRevision: 1,
      expectedIdeaVersion: 1,
    });
    expect(first.ok).toBe(true);
    const firstApproved = getCurrentApprovedDesign(h.db, h.ideaId)!;

    // Advance the prototype to r2 and write a newer draft r2 bound to it. The idea
    // version is now 2 (the first fold bumped it).
    h.db.prepare('UPDATE artifacts SET revision = 2 WHERE id = ?').run(ARTIFACT);
    insertDraft(h.db, {
      id: 'draft-2',
      ideaId: h.ideaId,
      revision: 2,
      boundId: ARTIFACT,
      boundRev: 2,
      spec: 'A second-iteration left rail with a compact mode.\n\n### Baseline\n\n- frontend/src/Rail.tsx',
    });

    const second = await approveDesign(makeDeps(h), {
      sessionId: SESSION,
      draftRevision: 2,
      expectedIdeaVersion: 2,
    });
    expect(second.ok).toBe(true);

    const history = listApprovedDesignHistory(h.db, h.ideaId);
    expect(history.length).toBe(2);
    const current = getCurrentApprovedDesign(h.db, h.ideaId)!;
    expect(current.draftRevision).toBe(2);
    expect(current.prototypeRevision).toBe(2);
    expect(current.supersededAt).toBeNull();

    // The prior row is retained but superseded.
    const priorRow = history.find((r) => r.id === firstApproved.id)!;
    expect(priorRow.supersededAt).not.toBeNull();

    // Exactly one current row.
    const currentCount = h.db
      .prepare('SELECT COUNT(*) AS n FROM approved_designs WHERE idea_id = ? AND superseded_at IS NULL')
      .get(h.ideaId) as { n: number };
    expect(currentCount.n).toBe(1);
    // The newer draft's spec is now the folded section.
    expect(ideaRow(h.db, h.ideaId).body).toContain('compact mode');
    expect(designSpecHeadingCount(ideaRow(h.db, h.ideaId).body ?? '')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (f) Fold + transition atomicity
// ---------------------------------------------------------------------------

describe('runFoldStep — fold + transition atomicity (f)', () => {
  it('rolls the body write back when the handoff-state UPDATE loses its race', async () => {
    const h = await setup();
    // A handoff in 'intent' (NOT 'snapshotted'): the fold's guarded
    // `WHERE state='snapshotted'` matches 0 rows, so the whole transaction — the
    // idea-body fold included — rolls back.
    insertHandoff(h.db, {
      id: 'dho-race',
      ideaId: h.ideaId,
      projectId: h.projectId,
      draftRevision: 1,
      state: 'intent',
      expectedIdeaVersion: 1,
    });

    const outcome = await runFoldStep(makeDeps(h), handoffRow(h.db, 'dho-race')!);
    expect(outcome.kind).toBe('raced');

    // Body write rolled back with the failed transition.
    const idea = ideaRow(h.db, h.ideaId);
    expect(idea.body).not.toContain('## Design spec');
    expect(idea.version).toBe(1);
    // No fold event leaked.
    const foldEvents = h.db
      .prepare(
        `SELECT COUNT(*) AS n FROM entity_events
          WHERE entity_type = 'idea' AND entity_id = ? AND kind = 'design-spec-folded'`,
      )
      .get(h.ideaId) as { n: number };
    expect(foldEvents.n).toBe(0);
    // Handoff untouched (still intent).
    expect(handoffRow(h.db, 'dho-race')!.state).toBe('intent');
  });
});

// ---------------------------------------------------------------------------
// entityBodyFold — CAS units
// ---------------------------------------------------------------------------

describe('coWriteIdeaBodyReplace — CAS', () => {
  it('folds under the matching version, bumps version, appends a shape-identical event', async () => {
    const h = await setup();
    const txn = h.db.transaction(() => {
      return coWriteIdeaBodyReplace(h.db, {
        ideaId: h.ideaId,
        expectedVersion: 1,
        newBody: 'folded body',
        runId: CHAT_RUN,
        kind: 'design-spec-folded',
        now: CLOCK,
      });
    });
    const res = (txn as () => ReturnType<typeof coWriteIdeaBodyReplace>)();
    expect(res).toEqual({ ok: true, version: 2 });
    const idea = ideaRow(h.db, h.ideaId);
    expect(idea.body).toBe('folded body');
    expect(idea.version).toBe(2);
  });

  it('rejects a stale expectedVersion with code concurrency (no write)', async () => {
    const h = await setup();
    const before = ideaRow(h.db, h.ideaId);
    const txn = h.db.transaction(() =>
      coWriteIdeaBodyReplace(h.db, {
        ideaId: h.ideaId,
        expectedVersion: 42,
        newBody: 'should not land',
        runId: null,
        kind: 'design-spec-folded',
        now: CLOCK,
      }),
    );
    const res = (txn as () => ReturnType<typeof coWriteIdeaBodyReplace>)();
    expect(res).toEqual({ ok: false, code: 'concurrency' });
    const after = ideaRow(h.db, h.ideaId);
    expect(after.body).toBe(before.body);
    expect(after.version).toBe(1);
  });

  it('returns not_found for a missing idea', async () => {
    const h = await setup();
    const txn = h.db.transaction(() =>
      coWriteIdeaBodyReplace(h.db, {
        ideaId: 'ide_missing',
        expectedVersion: 1,
        newBody: 'x',
        runId: null,
        kind: 'design-spec-folded',
        now: CLOCK,
      }),
    );
    const res = (txn as () => ReturnType<typeof coWriteIdeaBodyReplace>)();
    expect(res).toEqual({ ok: false, code: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// Idempotency + link integrity
// ---------------------------------------------------------------------------

describe('approveDesign — idempotency + integrity', () => {
  it('a second approve of a completed draft returns already-complete without a second fold', async () => {
    const h = await setup();
    const first = await approveDesign(makeDeps(h), { sessionId: SESSION, draftRevision: 1, expectedIdeaVersion: 1 });
    expect(first.ok).toBe(true);
    const versionAfterFirst = ideaRow(h.db, h.ideaId).version;

    const second = await approveDesign(makeDeps(h), { sessionId: SESSION, draftRevision: 1, expectedIdeaVersion: 1 });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('already-complete');
    // No second fold.
    expect(ideaRow(h.db, h.ideaId).version).toBe(versionAfterFirst);
    expect(designSpecHeadingCount(ideaRow(h.db, h.ideaId).body ?? '')).toBe(1);
    const handoffCount = h.db.prepare('SELECT COUNT(*) AS n FROM design_handoffs').get() as { n: number };
    expect(handoffCount.n).toBe(1);
  });

  it('rejects an unknown draft revision', async () => {
    const h = await setup();
    const result = await approveDesign(makeDeps(h), { sessionId: SESSION, draftRevision: 99, expectedIdeaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unknown-draft');
  });

  it('rejects a draft with no bound prototype (no-prototype)', async () => {
    const h = await setup();
    insertDraft(h.db, { id: 'draft-np', ideaId: h.ideaId, revision: 2, boundId: null, boundRev: null, spec: 'x' });
    const result = await approveDesign(makeDeps(h), { sessionId: SESSION, draftRevision: 2, expectedIdeaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('no-prototype');
  });

  it('fails soft (link-broken) when the linked idea is decomposed mid-session', async () => {
    const h = await setup();
    h.db.prepare("UPDATE ideas SET decomposed_at = ? WHERE id = ?").run(CLOCK, h.ideaId);
    const result = await approveDesign(makeDeps(h), { sessionId: SESSION, draftRevision: 1, expectedIdeaVersion: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('link-broken');
    // No side effects.
    expect(getCurrentApprovedDesign(h.db, h.ideaId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (g) Idea component ledger convergence — approval stamps `prototype`
// complete through IdeaComponentRouter (the two-prototype-pathway
// convergence fix). See stampPrototypeComplete in designHandoffService.ts.
// ---------------------------------------------------------------------------

describe('approveDesign — idea component ledger convergence (g)', () => {
  it('a completed approval stamps the `prototype` component complete, source flow, against the post-fold idea version', async () => {
    const h = await setup();
    IdeaComponentRouter.initialize(h.db);

    const result = await approveDesign(makeDeps(h), {
      sessionId: SESSION,
      draftRevision: 1,
      expectedIdeaVersion: 1,
    });
    expect(result.ok).toBe(true);

    const states = resolveIdeaComponents(h.db, h.ideaId);
    const prototype = states.find((s) => s.component === 'prototype')!;
    expect(prototype.state).toBe('complete');
    expect(prototype.source).toBe('flow');
    expect(prototype.sourceSessionId).toBe(SESSION);
    expect(prototype.sourceRunId).toBe(CHAT_RUN);
    expect(prototype.staleAt).toBeNull();
    // The idea's version AFTER the Step 2 fold bumped it (1 -> 2) — "the
    // version this component was built against", read fresh post-commit.
    expect(prototype.builtAgainstVersion).toBe(2);
  });

  it('clears a pre-existing stale flag end to end — the design-mode convergence bug this fix closes', async () => {
    const h = await setup();
    const componentRouter = IdeaComponentRouter.initialize(h.db);

    // A prior planner run already completed the prototype component...
    await componentRouter.applyChange(h.projectId, {
      op: 'set-component-state',
      ideaId: h.ideaId,
      component: 'prototype',
      state: 'complete',
      source: 'flow',
      builtAgainstVersion: 1,
    });
    // ...then the idea's body changed, which (via taskChangeRouter.ts's
    // staleness hook in production) flips prototype to stale+incomplete.
    // Driven directly here so this test stays independent of that hook's own
    // section-attribution logic — this test is about approveDesign's
    // clearing behavior, not the hook that produced the stale flag.
    await componentRouter.applyChange(h.projectId, {
      op: 'mark-stale',
      ideaId: h.ideaId,
      staleReason: 'idea body changed',
      components: ['prototype'],
    });
    const beforeApprove = resolveIdeaComponents(h.db, h.ideaId).find((s) => s.component === 'prototype')!;
    expect(beforeApprove.state).toBe('incomplete');
    expect(beforeApprove.staleAt).not.toBeNull();

    // The user reopens design mode, iterates, and approves a fresh design —
    // exactly the re-verification the stale flag was waiting for.
    const result = await approveDesign(makeDeps(h), {
      sessionId: SESSION,
      draftRevision: 1,
      expectedIdeaVersion: 1,
    });
    expect(result.ok).toBe(true);

    const afterApprove = resolveIdeaComponents(h.db, h.ideaId).find((s) => s.component === 'prototype')!;
    expect(afterApprove.state).toBe('complete');
    expect(afterApprove.staleAt).toBeNull();
    expect(afterApprove.staleReason).toBeNull();
  });

  it('an UNINITIALIZED IdeaComponentRouter does not fail the approval (getInstance throws synchronously)', async () => {
    const h = await setup();
    // Deliberately left uninitialized (setup()'s default) — getInstance()
    // throws SYNCHRONOUSLY, which a bare `.catch()` would not catch; the
    // stamp must be wrapped in a real try/catch around the whole call.
    expect(() => IdeaComponentRouter.getInstance()).toThrow();

    const result = await approveDesign(makeDeps(h), {
      sessionId: SESSION,
      draftRevision: 1,
      expectedIdeaVersion: 1,
    });

    expect(result.ok).toBe(true);
    const handoff = handoffRow(h.db, (result as { ok: true; handoffId: string }).handoffId)!;
    expect(handoff.state).toBe('complete');
  });

  it('a THROWING (initialized but broken) IdeaComponentRouter does not fail an already-committed approval', async () => {
    const h = await setup();
    // A router wired to a DB handle that throws on every prepare() — proves
    // the fail-soft catch survives a genuine runtime failure, not just the
    // "never initialized" case above.
    const brokenDb = {
      prepare: () => {
        throw new Error('idea_components: database is locked');
      },
      transaction: <T>(fn: (...args: unknown[]) => T) => fn,
    };
    IdeaComponentRouter.initialize(brokenDb);

    const result = await approveDesign(makeDeps(h), {
      sessionId: SESSION,
      draftRevision: 1,
      expectedIdeaVersion: 1,
    });

    // The approval (already committed by the time the stamp runs) still succeeds.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const handoff = handoffRow(h.db, result.handoffId)!;
    expect(handoff.state).toBe('complete');
    expect(getCurrentApprovedDesign(h.db, h.ideaId)).not.toBeNull();
  });
});
