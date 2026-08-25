/**
 * designHandoffService — the Approve intent-first recoverable state machine
 * (design-mode.md "Approve — intent-first recoverable state machine").
 *
 * Approve(sessionId, draftRevision, expectedIdeaVersion) folds a design session's
 * durable design-spec draft into the linked idea and publishes the bound prototype
 * as an approved design. It is a DURABLE state machine so a crash at any transition
 * boundary converges on the next drive (boot recovery OR a re-invocation with the
 * same (session, draft) key), never stranding or double-applying:
 *
 *   intent  --Step 1 snapshot-->  snapshotted  --Step 2 fold-->  folded
 *           --Step 3 publish-->  complete
 *   (off-path terminals: superseded [stale idea version], failed [broken link etc.])
 *
 * Step 0 (before any side effect) validates the draft<->prototype CAS (the
 * artifact's CURRENT revision must equal the draft's bound revision) so an approved
 * handoff never pairs one revision's prose with another revision's bytes. Step 2
 * folds the idea body AND transitions the handoff to `folded` in ONE SQLite
 * transaction (the sanctioned co-write exception — entityBodyFold.ts), so the
 * version bump and the record that it happened are atomic. Every guarded UPDATE is
 * conditioned on the exact prior state; a 0-row result is a lost race, re-driven by
 * reloading the row (convergence), never a blind proceed.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3', or
 * any concrete service in main/src/services/*. The DB is the narrow DatabaseLike;
 * the (electron-backed) prototype-byte reader and the snapshot base dir are
 * INJECTED at the boot wiring seam (index.ts), so this module — and the tRPC
 * router that imports it — stay standalone-typecheck-clean. `node:fs`/`node:path`
 * (atomic snapshot write) mirror artifactSnapshot.ts and are allowed.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { DatabaseLike, LoggerLike } from '../types';
import type { DesignHandoffRow, DesignSpecDraftRow } from '../../database/models';
import {
  DESIGN_SPEC_SECTION_HEADING,
  replaceDesignSpecSection,
} from '../../../../shared/types/artifacts';
import {
  taskChangeEvents,
  taskProjectChannel,
  TASK_ALL_CHANNEL,
} from '../taskChangeRouter';
import { selectTaskById } from '../taskListing';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';
import { coWriteIdeaBodyReplace } from './entityBodyFold';
import { IdeaComponentRouter } from '../ideaComponents/ideaComponentRouter';

// ---------------------------------------------------------------------------
// Public API shapes
// ---------------------------------------------------------------------------

export interface DesignApproveInput {
  sessionId: string;
  draftRevision: number;
  expectedIdeaVersion: number;
}

/** The failure taxonomy the frontend branches on (via tRPC type inference). */
export type DesignApproveCode =
  | 'stale-draft'
  | 'stale-idea-version'
  | 'no-prototype'
  | 'link-broken'
  | 'unknown-draft'
  | 'already-complete';

export type DesignApproveResult =
  | { ok: true; handoffId: string }
  | { ok: false; code: DesignApproveCode; message: string; handoffId?: string };

export interface DesignHandoffDeps {
  db: DatabaseLike;
  /**
   * Read the CURRENT canonical prototype HTML bytes for a run (the live
   * per-run artifacts subtree, then the committed store) — null when absent.
   * `atype` is the bound artifact's prototype-family atype: the live-subtree
   * path ignores it, but the committed-store fallback is keyed per atype, so
   * an interactive-prototype handoff must not read ui-prototype's directory.
   * Injected so this module never imports the electron-backed path resolvers.
   */
  loadPrototypeHtml: (runId: string, atype: string) => Promise<string | null>;
  /**
   * Base dir the design snapshots publish under: `<base>/<ideaId>/<handoffId>.html`.
   * Injected (electron-backed getCyboflowSubdirectory) to keep this module
   * standalone-typecheck-safe.
   */
  snapshotBaseDir: string;
  logger?: LoggerLike;
  /** Injectable clock (ISO string) for deterministic tests. */
  now?: () => string;
}

// ---------------------------------------------------------------------------
// Internal row shapes + reads
// ---------------------------------------------------------------------------

interface SessionRow {
  design_idea_id: string | null;
  project_id: number | null;
  chat_run_id: string | null;
}

interface IdeaRow {
  project_id: number;
  decomposed_at: string | null;
  version: number;
  title: string;
  body: string | null;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  session_id: string | null;
  /** Prototype-family atype ('ui-prototype' | 'interactive-prototype') — threaded
   *  into loadPrototypeHtml so the committed-store fallback reads the RIGHT
   *  per-atype snapshot directory (the live run-subtree path is atype-agnostic). */
  atype: string;
  revision: number;
  payload_json: string | null;
}

function loadSession(db: DatabaseLike, sessionId: string): SessionRow | undefined {
  return db
    .prepare('SELECT design_idea_id, project_id, chat_run_id FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
}

function loadIdea(db: DatabaseLike, ideaId: string): IdeaRow | undefined {
  return db
    .prepare('SELECT project_id, decomposed_at, version, title, body FROM ideas WHERE id = ?')
    .get(ideaId) as IdeaRow | undefined;
}

function loadDraft(
  db: DatabaseLike,
  sessionId: string,
  draftRevision: number,
): DesignSpecDraftRow | undefined {
  return db
    .prepare('SELECT * FROM design_spec_drafts WHERE session_id = ? AND draft_revision = ?')
    .get(sessionId, draftRevision) as DesignSpecDraftRow | undefined;
}

function loadArtifact(db: DatabaseLike, artifactId: string): ArtifactRow | undefined {
  return db
    .prepare('SELECT id, run_id, session_id, atype, revision, payload_json FROM artifacts WHERE id = ?')
    .get(artifactId) as ArtifactRow | undefined;
}

function loadHandoff(db: DatabaseLike, handoffId: string): DesignHandoffRow | undefined {
  return db
    .prepare('SELECT * FROM design_handoffs WHERE id = ?')
    .get(handoffId) as DesignHandoffRow | undefined;
}

/** Latest handoff for a (session, draft) — the idempotency lookup. */
function loadLatestHandoff(
  db: DatabaseLike,
  sessionId: string,
  draftRevision: number,
): DesignHandoffRow | undefined {
  return db
    .prepare(
      `SELECT * FROM design_handoffs
        WHERE session_id = ? AND draft_revision = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(sessionId, draftRevision) as DesignHandoffRow | undefined;
}

// ---------------------------------------------------------------------------
// Post-commit idea-changed emit (bypass-chokepoint co-write must broadcast itself)
// ---------------------------------------------------------------------------

/**
 * Broadcast the idea's TaskChangedEvent on BOTH the per-project channel and the
 * cross-project TASK_ALL_CHANNEL, shape-identical to TaskChangeRouter.emitChange —
 * so the live board/idea subscriptions refetch the folded body. Because the fold
 * bypasses the chokepoint (Step 2's single-transaction co-write), the caller is
 * responsible for this emit AFTER the transaction commits. Rebuilds the read-model
 * item via the same selectTaskById the tasks.get procedure uses; a null (idea
 * deleted between commit and emit) is a silent no-op, mirroring emitChange.
 */
function emitIdeaChanged(db: DatabaseLike, projectId: number, ideaId: string): void {
  const task = selectTaskById(db, ideaId);
  if (!task) return;
  const event: TaskChangedEvent = { projectId, taskId: ideaId, action: 'updated', task };
  taskChangeEvents.emit(taskProjectChannel(projectId), event);
  taskChangeEvents.emit(TASK_ALL_CHANNEL, event);
}

// ---------------------------------------------------------------------------
// Transition helpers
// ---------------------------------------------------------------------------

/** Thrown inside a Step transaction to force a rollback (fold-abort / lost race). */
class HandoffTxnAbort extends Error {
  constructor(public readonly reason: 'fold-failed' | 'handoff-race') {
    super(reason);
    this.name = 'HandoffTxnAbort';
  }
}

function nowOf(deps: DesignHandoffDeps): string {
  return deps.now ? deps.now() : new Date().toISOString();
}

/** Guarded terminal-mark: never overwrites an already-terminal handoff. */
function markHandoffFailed(
  db: DatabaseLike,
  handoffId: string,
  code: DesignApproveCode,
  message: string,
  now: string,
): void {
  db.prepare(
    `UPDATE design_handoffs SET state = 'failed', error = ?, updated_at = ?
      WHERE id = ? AND state NOT IN ('complete', 'failed', 'superseded')`,
  ).run(`${code}: ${message}`, now, handoffId);
}

/** Guarded terminal-mark for a stale expectedIdeaVersion (Step 2 concurrency). */
function markHandoffSuperseded(db: DatabaseLike, handoffId: string, message: string, now: string): void {
  db.prepare(
    `UPDATE design_handoffs SET state = 'superseded', error = ?, updated_at = ?
      WHERE id = ? AND state NOT IN ('complete', 'failed', 'superseded')`,
  ).run(`stale-idea-version: ${message}`, now, handoffId);
}

/** Recover a machine-readable code from a terminal row's encoded `error` prefix. */
function codeFromError(error: string | null): DesignApproveCode {
  const known: DesignApproveCode[] = [
    'stale-draft',
    'stale-idea-version',
    'no-prototype',
    'link-broken',
    'unknown-draft',
    'already-complete',
  ];
  const prefix = (error ?? '').split(':', 1)[0]?.trim() ?? '';
  return (known as string[]).includes(prefix) ? (prefix as DesignApproveCode) : 'link-broken';
}

// ---------------------------------------------------------------------------
// Post-commit idea-component ledger stamp (the two-prototype-pathway
// convergence fix — migration 101 / shared/types/ideaComponents.ts)
// ---------------------------------------------------------------------------

/**
 * Once a design approval reaches `complete`, stamp the idea's `prototype`
 * ledger component `complete` through `IdeaComponentRouter.applyChange`. The
 * whole point of the ledger is that it is the ONE record both the planner's
 * ui-prototype step and design mode converge on (shared/types/ideaComponents.ts
 * file header) — without this stamp, design mode never wrote it at all, so
 * convergence rested entirely on `approved_designs` DERIVATION, and
 * derivation is masked outright the moment any `prototype` row exists (a
 * ledger row always wins over derivation). Concretely: an idea planned once
 * has `prototype`=complete (source 'flow'); an idea body edit flips it
 * stale+incomplete via taskChangeRouter.ts's staleness hook; a user then
 * iterates in design mode and approves a NEW design — without this stamp the
 * ledger would keep reading "needs review" forever, even though the
 * freshly-approved design is exactly the re-verification that hook was
 * waiting for. `set-component-state` is an UPSERT that always clears
 * `stale_at`/`stale_reason` as a side effect (an explicit stamp is a
 * reviewed judgment — see the op's own JSDoc), which is exactly the fix.
 *
 * Placement mirrors the precedent set by that same staleness hook
 * (taskChangeRouter.ts's post-commit block): called strictly AFTER the
 * publish transaction below has committed, never from inside it —
 * `IdeaComponentRouter` keys its own per-project PQueue + transaction, and
 * calling it from inside an already-open transaction risks a nested/re-
 * entrant write the driver does not support. Best-effort and fail-soft in a
 * real try/catch (NOT a bare `.catch()` on the returned promise) because
 * `IdeaComponentRouter.getInstance()` THROWS SYNCHRONOUSLY when the
 * singleton was never initialized (e.g. every existing unit test in this
 * file, which never calls `IdeaComponentRouter.initialize()`) — a `.catch()`
 * chained onto a call that never returns a promise would not catch that. A
 * ledger write failure must never fail or roll back an approval whose
 * `approved_designs` row and `state='complete'` transition already
 * committed.
 *
 * Idempotent across the state machine's re-approve / crash-recovery
 * retries: this only runs on an ACTUAL folded -> complete transition — the
 * guarded UPDATE inside `runPublishStep` advances a given handoff row at
 * most once, and every later call (a re-approve of an already-`complete`
 * handoff, or `driveHandoffForward` resuming a `complete` row after a
 * restart) short-circuits to the `case 'complete'` terminal without ever
 * re-entering `runPublishStep`. `set-component-state` is itself an UPSERT,
 * so even a hypothetical duplicate call would just re-affirm the same
 * complete state rather than misbehave.
 */
async function stampPrototypeComplete(deps: DesignHandoffDeps, handoff: DesignHandoffRow): Promise<void> {
  try {
    const session = loadSession(deps.db, handoff.session_id);
    const idea = loadIdea(deps.db, handoff.idea_id);
    await IdeaComponentRouter.getInstance().applyChange(handoff.project_id, {
      op: 'set-component-state',
      ideaId: handoff.idea_id,
      component: 'prototype',
      state: 'complete',
      source: 'flow',
      sourceRunId: session?.chat_run_id ?? null,
      sourceSessionId: handoff.session_id,
      builtAgainstVersion: idea?.version ?? null,
    });
  } catch (err) {
    deps.logger?.warn('[designHandoff] idea-component ledger stamp failed (approval already committed)', {
      handoffId: handoff.id,
      ideaId: handoff.idea_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Step outcomes + the shared step functions (first-run AND recovery use these)
// ---------------------------------------------------------------------------

/**
 * The result of running one Step. `advanced`/`raced` drive the loop; `done`
 * carries a terminal result. Exported so crash-at-boundary tests can drive the
 * steps one at a time (stop after intent / snapshotted / folded, then recover).
 */
export type StepOutcome =
  /** Advanced to the next state — the drive loop reloads and continues. */
  | { kind: 'advanced' }
  /** A guarded UPDATE matched 0 rows (a concurrent driver won) — reload + retry. */
  | { kind: 'raced' }
  /** A terminal decision was reached — return this result to the caller. */
  | { kind: 'done'; result: DesignApproveResult };

/**
 * Step 1 — snapshot the prototype bound to the idea. Re-validates the Step 0 CAS
 * FIRST (recovery may resume an 'intent' row after the prototype advanced while the
 * app was down — never snapshot mismatched bytes; mark failed 'stale-draft'), reads
 * the canonical prototype HTML, publishes it atomically (temp + rename), then the
 * guarded transition intent -> snapshotted. A transient read/write failure leaves
 * the row 'intent' (recovery / re-approve retries) rather than burning it.
 */
export async function runSnapshotStep(deps: DesignHandoffDeps, handoff: DesignHandoffRow): Promise<StepOutcome> {
  const { db } = deps;
  const now = nowOf(deps);

  const artifact = loadArtifact(db, handoff.prototype_artifact_id);
  if (!artifact) {
    markHandoffFailed(db, handoff.id, 'no-prototype', 'the prototype artifact is no longer present', now);
    return { kind: 'done', result: { ok: false, code: 'no-prototype', message: 'the prototype artifact is no longer present', handoffId: handoff.id } };
  }
  // Step 0 CAS re-check (recovery safety): the artifact's current revision must
  // still equal the revision this handoff was minted against.
  if (artifact.revision !== handoff.prototype_revision) {
    const message = `the prototype advanced (handoff r${handoff.prototype_revision} vs prototype r${artifact.revision}) — refresh the draft`;
    markHandoffFailed(db, handoff.id, 'stale-draft', message, now);
    return { kind: 'done', result: { ok: false, code: 'stale-draft', message, handoffId: handoff.id } };
  }

  let snapshotPath: string;
  try {
    const html = await deps.loadPrototypeHtml(artifact.run_id, artifact.atype);
    if (html === null) {
      // Transient: leave 'intent' so a later drive retries.
      return { kind: 'done', result: { ok: false, code: 'no-prototype', message: 'the prototype HTML could not be read — regenerate the prototype and retry', handoffId: handoff.id } };
    }
    const ideaDir = path.join(deps.snapshotBaseDir, handoff.idea_id);
    await fs.mkdir(ideaDir, { recursive: true });
    snapshotPath = path.join(ideaDir, `${handoff.id}.html`);
    const tmp = path.join(ideaDir, `.tmp-${handoff.id}-${randomBytes(6).toString('hex')}.html`);
    await fs.writeFile(tmp, html, 'utf-8');
    await fs.rename(tmp, snapshotPath);
  } catch (err) {
    deps.logger?.warn('[designHandoff] snapshot write failed (staying intent)', {
      handoffId: handoff.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { kind: 'done', result: { ok: false, code: 'no-prototype', message: 'the prototype snapshot could not be written — retry', handoffId: handoff.id } };
  }

  const info = db
    .prepare(
      `UPDATE design_handoffs SET state = 'snapshotted', snapshot_path = ?, updated_at = ?
        WHERE id = ? AND state = 'intent'`,
    )
    .run(snapshotPath, now, handoff.id) as { changes: number };
  return info.changes === 0 ? { kind: 'raced' } : { kind: 'advanced' };
}

/**
 * Step 2 — fold the design-spec draft into the idea body AND transition the
 * handoff snapshotted -> folded in ONE transaction (atomicity: the version bump
 * and the record that it happened commit or roll back together). A stale
 * expectedIdeaVersion (fold `concurrency`) marks the handoff 'superseded' and
 * returns the re-read state — never a silent retry past a concurrent edit. A lost
 * race on the handoff-state UPDATE rolls the body write back with it.
 */
export async function runFoldStep(deps: DesignHandoffDeps, handoff: DesignHandoffRow): Promise<StepOutcome> {
  const { db } = deps;
  const now = nowOf(deps);

  const draft = loadDraft(db, handoff.session_id, handoff.draft_revision);
  if (!draft) {
    markHandoffFailed(db, handoff.id, 'unknown-draft', 'the design-spec draft is no longer present', now);
    return { kind: 'done', result: { ok: false, code: 'unknown-draft', message: 'the design-spec draft is no longer present', handoffId: handoff.id } };
  }

  // The chat run recorded on the fold's entity_events row (informational; null when
  // the session/run is gone — the FK is SET NULL).
  const session = loadSession(db, handoff.session_id);
  const foldRunId = session?.chat_run_id ?? null;

  let foldConcurrency = false;
  let foldNotFound = false;
  let raced = false;
  const txn = db.transaction(() => {
    // Re-read the idea body INSIDE the transaction and compose the new body there
    // (design-mode.md Step 2), so the fold reflects the body as of the version the
    // CAS below guards against — never a body read before a concurrent edit.
    const idea = loadIdea(db, handoff.idea_id);
    if (!idea) {
      foldNotFound = true;
      throw new HandoffTxnAbort('fold-failed');
    }
    // A complete '## Design spec' section (heading-led) so the fold re-extracts.
    const newBody = replaceDesignSpecSection(
      idea.body,
      `## ${DESIGN_SPEC_SECTION_HEADING}\n\n${draft.spec_markdown}`,
    );
    const fold = coWriteIdeaBodyReplace(db, {
      ideaId: handoff.idea_id,
      expectedVersion: handoff.expected_idea_version,
      newBody,
      runId: foldRunId,
      kind: 'design-spec-folded',
      now,
    });
    if (!fold.ok) {
      if (fold.code === 'concurrency') foldConcurrency = true;
      else foldNotFound = true;
      throw new HandoffTxnAbort('fold-failed'); // roll the fold back
    }
    const info = db
      .prepare(
        `UPDATE design_handoffs SET state = 'folded', updated_at = ?
          WHERE id = ? AND state = 'snapshotted'`,
      )
      .run(now, handoff.id) as { changes: number };
    if (info.changes === 0) {
      // The handoff state moved under us — abort so the body write rolls back too.
      raced = true;
      throw new HandoffTxnAbort('handoff-race');
    }
  });
  try {
    (txn as () => void)();
  } catch (err) {
    if (!(err instanceof HandoffTxnAbort)) throw err;
  }

  // A lost handoff-state race is checked FIRST: the fold rolled back with it.
  if (raced) return { kind: 'raced' };
  if (foldConcurrency) {
    const message = `the idea changed during approval (expected version ${handoff.expected_idea_version}) — re-read and approve again`;
    markHandoffSuperseded(db, handoff.id, message, now);
    return { kind: 'done', result: { ok: false, code: 'stale-idea-version', message, handoffId: handoff.id } };
  }
  if (foldNotFound) {
    markHandoffFailed(db, handoff.id, 'link-broken', 'the linked idea no longer exists', now);
    return { kind: 'done', result: { ok: false, code: 'link-broken', message: 'the linked idea no longer exists', handoffId: handoff.id } };
  }

  // Fold committed — broadcast the idea change so live subscriptions refetch.
  emitIdeaChanged(db, handoff.project_id, handoff.idea_id);
  return { kind: 'advanced' };
}

/**
 * Step 3 — publish to the approved-design read model + transition folded ->
 * complete. Replace-on-re-approve: any prior current row for the idea is
 * superseded (superseded_at stamped) in the SAME transaction as the new current
 * row's insert, so there is always exactly one `superseded_at IS NULL` row per
 * idea. Superseded rows are retained. A lost handoff-state race rolls the whole
 * publish back.
 */
export async function runPublishStep(deps: DesignHandoffDeps, handoff: DesignHandoffRow): Promise<StepOutcome> {
  const { db } = deps;
  const now = nowOf(deps);

  if (!handoff.snapshot_path) {
    // Defensive: a 'folded' row always carries a snapshot_path (Step 1 set it).
    markHandoffFailed(db, handoff.id, 'no-prototype', 'the prototype snapshot path is missing', now);
    return { kind: 'done', result: { ok: false, code: 'no-prototype', message: 'the prototype snapshot path is missing', handoffId: handoff.id } };
  }

  let raced = false;
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE approved_designs SET superseded_at = datetime('now')
        WHERE idea_id = ? AND superseded_at IS NULL`,
    ).run(handoff.idea_id);
    const approvedId = `apd_${randomBytes(10).toString('hex')}`;
    db.prepare(
      `INSERT INTO approved_designs
         (id, idea_id, project_id, handoff_id, session_id, draft_revision,
          prototype_artifact_id, prototype_revision, snapshot_path, approved_at, superseded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      approvedId,
      handoff.idea_id,
      handoff.project_id,
      handoff.id,
      handoff.session_id,
      handoff.draft_revision,
      handoff.prototype_artifact_id,
      handoff.prototype_revision,
      handoff.snapshot_path,
      now,
    );
    const info = db
      .prepare(
        `UPDATE design_handoffs SET state = 'complete', updated_at = ?
          WHERE id = ? AND state = 'folded'`,
      )
      .run(now, handoff.id) as { changes: number };
    if (info.changes === 0) {
      raced = true;
      throw new HandoffTxnAbort('handoff-race');
    }
  });
  try {
    (txn as () => void)();
  } catch (err) {
    if (!(err instanceof HandoffTxnAbort)) throw err;
  }

  if (raced) return { kind: 'raced' };
  // Post-commit ledger stamp — see stampPrototypeComplete's own JSDoc for the
  // full placement/idempotency/fail-soft rationale.
  await stampPrototypeComplete(deps, handoff);
  return { kind: 'advanced' };
}

/**
 * Drive a handoff row forward from whatever state it is in to a terminal result.
 * Shared by the first-run approve (after minting the intent row) AND boot recovery
 * — a crash resumes from the recorded state and this loop converges. Each iteration
 * reloads the row (so a concurrent driver's advance is picked up) and dispatches on
 * its CURRENT state; a 'raced' step reloads and retries. Bounded to guard against a
 * pathological non-converging loop.
 */
export async function driveHandoffForward(
  deps: DesignHandoffDeps,
  handoffId: string,
): Promise<DesignApproveResult> {
  const { db } = deps;
  const MAX_ITER = 12;
  for (let i = 0; i < MAX_ITER; i++) {
    const handoff = loadHandoff(db, handoffId);
    if (!handoff) return { ok: false, code: 'link-broken', message: 'the handoff record vanished' };

    switch (handoff.state) {
      case 'complete':
        return { ok: true, handoffId };
      case 'superseded':
        return {
          ok: false,
          code: 'stale-idea-version',
          message: handoff.error ?? 'the idea changed during approval',
          handoffId,
        };
      case 'failed':
        return {
          ok: false,
          code: codeFromError(handoff.error),
          message: handoff.error ?? 'the approval failed',
          handoffId,
        };
      case 'intent': {
        const o = await runSnapshotStep(deps, handoff);
        if (o.kind === 'done') return o.result;
        break; // advanced | raced -> reload
      }
      case 'snapshotted': {
        const o = await runFoldStep(deps, handoff);
        if (o.kind === 'done') return o.result;
        break;
      }
      case 'folded': {
        const o = await runPublishStep(deps, handoff);
        if (o.kind === 'done') return o.result;
        break;
      }
    }
  }
  return { ok: false, code: 'link-broken', message: 'approval did not converge' };
}

// ---------------------------------------------------------------------------
// approveDesign — the full machine (Step 0 + idempotency + mint + drive)
// ---------------------------------------------------------------------------

/**
 * Approve a design session's draft. Validates the idea-link integrity contract +
 * the Step 0 draft<->prototype CAS with NO side effect, resolves idempotency
 * against any existing handoff for the (session, draft) key, mints the intent row,
 * and drives the machine to a terminal result.
 */
export async function approveDesign(
  deps: DesignHandoffDeps,
  input: DesignApproveInput,
): Promise<DesignApproveResult> {
  const { db } = deps;
  const { sessionId, draftRevision, expectedIdeaVersion } = input;

  // --- Idea-link integrity contract ---
  const session = loadSession(db, sessionId);
  if (!session || !session.design_idea_id) {
    return { ok: false, code: 'link-broken', message: 'this session is not linked to a design idea' };
  }
  const ideaId = session.design_idea_id;
  const idea = loadIdea(db, ideaId);
  if (!idea) return { ok: false, code: 'link-broken', message: 'the linked idea no longer exists' };
  if (idea.decomposed_at !== null) {
    return { ok: false, code: 'link-broken', message: 'the linked idea has been decomposed — relink or end the session' };
  }
  if (session.project_id != null && idea.project_id !== session.project_id) {
    return { ok: false, code: 'link-broken', message: 'the linked idea belongs to a different project' };
  }

  // --- Draft + bound prototype ---
  const draft = loadDraft(db, sessionId, draftRevision);
  if (!draft) return { ok: false, code: 'unknown-draft', message: `draft revision ${draftRevision} was not found for this session` };
  if (draft.idea_id !== ideaId) {
    return { ok: false, code: 'link-broken', message: 'the draft is bound to a different idea' };
  }
  if (draft.bound_artifact_id === null || draft.bound_artifact_revision === null) {
    return { ok: false, code: 'no-prototype', message: 'this draft predates any prototype — generate a prototype, then refresh the draft' };
  }
  const artifact = loadArtifact(db, draft.bound_artifact_id);
  if (!artifact) return { ok: false, code: 'no-prototype', message: 'the prototype artifact no longer exists' };

  // --- Step 0 CAS: BEFORE any side effect ---
  if (artifact.revision !== draft.bound_artifact_revision) {
    return {
      ok: false,
      code: 'stale-draft',
      message: `the prototype advanced (draft r${draft.bound_artifact_revision} vs prototype r${artifact.revision}) — refresh the draft before approving`,
    };
  }

  // --- Idempotency: resume a non-terminal handoff; mint fresh past a terminal one ---
  const existing = loadLatestHandoff(db, sessionId, draftRevision);
  if (existing) {
    if (existing.state === 'complete') {
      return { ok: false, code: 'already-complete', message: 'this draft has already been approved', handoffId: existing.id };
    }
    if (existing.state === 'intent' || existing.state === 'snapshotted' || existing.state === 'folded') {
      return driveHandoffForward(deps, existing.id);
    }
    // 'superseded' | 'failed' -> mint a fresh handoff below.
  }

  // --- Mint the intent row (persisted BEFORE any side effect) ---
  const handoffId = `dho_${randomBytes(10).toString('hex')}`;
  const now = nowOf(deps);
  db.prepare(
    `INSERT INTO design_handoffs
       (id, session_id, idea_id, project_id, draft_revision, prototype_artifact_id,
        prototype_revision, expected_idea_version, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
  ).run(
    handoffId,
    sessionId,
    ideaId,
    idea.project_id,
    draftRevision,
    artifact.id,
    artifact.revision,
    expectedIdeaVersion,
    now,
    now,
  );

  return driveHandoffForward(deps, handoffId);
}

// ---------------------------------------------------------------------------
// Singleton — boot-configured with the electron-backed deps; the tRPC router
// (standalone-typecheck-clean) reaches it via getInstance(), and boot recovery
// reads its deps bag to drive recoverDesignHandoffs.
// ---------------------------------------------------------------------------

export class DesignHandoffService {
  private static instance: DesignHandoffService | null = null;

  constructor(private readonly deps: DesignHandoffDeps) {}

  static initialize(deps: DesignHandoffDeps): DesignHandoffService {
    DesignHandoffService.instance = new DesignHandoffService(deps);
    return DesignHandoffService.instance;
  }

  static getInstance(): DesignHandoffService {
    if (!DesignHandoffService.instance) {
      throw new Error(
        'DesignHandoffService has not been initialized. Call DesignHandoffService.initialize() from main/src/index.ts.',
      );
    }
    return DesignHandoffService.instance;
  }

  /** Reset singleton — intended for tests only. */
  static _resetForTesting(): void {
    DesignHandoffService.instance = null;
  }

  /** The boot-configured deps bag — read by index.ts to drive boot recovery. */
  get depsBag(): DesignHandoffDeps {
    return this.deps;
  }

  approve(input: DesignApproveInput): Promise<DesignApproveResult> {
    return approveDesign(this.deps, input);
  }
}
