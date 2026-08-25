/**
 * autoMintArtifacts — the orchestrator-side auto-mint hook for run artifacts.
 *
 * When a workflow step whose `WorkflowStep.outputArtifact` is set completes
 * (status='done'), the step-transition path calls `handleStepCompletion`, which
 * derives the artifact's identity from the entity DB and mints it through the
 * single ArtifactRouter chokepoint (op='create' UPSERTs by (runId, atype), so a
 * re-derive is idempotent). For TEMPLATED artifacts (idea-spec,
 * decomposed-stories) the CONTENT is re-derived on READ from the entity DB —
 * `payload_json` stays null; only the label/sourceRef/stepOrigin metadata is
 * minted here.
 *
 * FAIL-SOFT CONTRACT: this runs inside the step-transition path, which must NEVER
 * be broken by an observational side-effect. The entire body is wrapped in
 * try/catch; any failure (missing run row, no resolvable seed idea, ArtifactRouter
 * not initialized, a thrown query) is logged via the optional logger and SWALLOWED.
 * `handleStepCompletion` never throws and never rejects with a meaningful error to
 * the caller.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/* — it reaches
 * the DB only through the narrow DatabaseLike surface, mirroring
 * stepTransitionBridge.ts / runEntityOwnership.ts. ArtifactRouter is reached via
 * its singleton (already initialized at boot from main/src/index.ts).
 */
import * as fs from 'fs/promises';
import * as path from 'node:path';
import { ArtifactRouter } from './artifactRouter';
import { listApproveIdeasBatchRows, listRunOwnedOrBatchIdeaIds } from './runEntityOwnership';
import type { DatabaseLike, LoggerLike } from './types';
import { resolveWorkflowDefinition, type WorkflowStep } from '../../../shared/types/workflows';
import { resolveRunFrozenSpec } from './runFrozenSpec';
import {
  COMBINED_BATCH_PAYLOAD_JSON,
  extractArchDesignSection,
} from '../../../shared/types/artifacts';
import { TERMINAL_RUN_STATUSES } from '../../../shared/types/cyboflow';
import type {
  ApproveIdeasArtifactPayload,
  ApproveDesignsArtifactPayload,
} from '../../../shared/types/artifacts';
import {
  resolveIdeaComponents,
  resolveIdeaComponentsBatch,
} from './ideaComponents/resolveIdeaComponents';
import type { IdeaComponentState } from '../../../shared/types/ideaComponents';

// ---------------------------------------------------------------------------
// Terminal-status gate (finding H-automint-1)
// ---------------------------------------------------------------------------

/**
 * Run statuses for which the synthesized lifecycle 'done' must NOT mint a
 * templated artifact. The run-end lifecycle (runExecutor) fires a synthesized
 * `stepTransitionEmitter.emit(runId, 'done')` for the INITIAL step id on EVERY
 * terminal seam — clean drain AND failure AND cancel — and the failure/cancel
 * lifecycle transition (transitionToFailed / transitionToCanceled) has ALREADY
 * stamped workflow_runs.status terminal BEFORE that emit (runExecutor execute()
 * catch arm: onLifecycleTransition('failed'|'canceled') is awaited, THEN
 * emitStep(runId,'done')). Minting on a 'failed'/'canceled' run would stamp an
 * idea-spec artifact as if the context step had succeeded. 'completed' is
 * excluded from this skip set: a completed run legitimately produced its
 * artifact. Note the explicit-agent path (cyboflow_report_step('context','done')
 * via mcpQueryHandler) does NOT transition status, so a live run still mints.
 */
const TERMINAL_SKIP_STATUSES = new Set<string>(
  TERMINAL_RUN_STATUSES.filter((s) => s === 'failed' || s === 'canceled'),
);

/**
 * Workflow names whose steps are permitted to auto-mint the templated planner
 * atypes ('idea-spec' / 'decomposed-stories'). A custom/edited step outside this
 * set that declares one of these atypes would otherwise mint against the run's
 * owned ideas (finding H-automint-2). The atypes are planner/launch-only by
 * design — launch is a multi-idea planning flow (mint identical to planner's) —
 * so a workflow outside this set declaring them is fail-soft skipped.
 */
const TEMPLATED_ATYPE_WORKFLOWS = new Set<string>(['planner', 'launch']);

/**
 * Workflows whose steps are permitted to auto-mint the templated 'arch-design'
 * atype. Unlike idea-spec/decomposed-stories (planner/launch-only), the optional
 * architecture-design step exists on planner, ship, AND launch (head of the
 * Refine phase), so all three mint. A custom workflow outside this set declaring
 * the atype is fail-soft skipped, mirroring TEMPLATED_ATYPE_WORKFLOWS.
 */
const ARCH_DESIGN_WORKFLOWS = new Set<string>(['planner', 'ship', 'launch']);

/**
 * Workflows whose RUN START mints the templated baselines (idea-spec +
 * decomposed-stories) from the idea the run originates from / operates on.
 *
 * WHY a run-start path exists alongside handleStepCompletion: the agents NEVER
 * report a step `'done'`. The flow prompts tell the orchestrator to report each
 * step as it BEGINS (cyboflow_report_step defaults status='running'); nothing
 * emits status='done', and there is no implicit "previous step done" synthesis
 * when the next step goes 'running'. So handleStepCompletion — which fires ONLY
 * on status='done' — never runs in practice, and a run that relied on it for its
 * templated atypes would show "No deliverables yet" forever (the original
 * planner idea-spec bug). Minting at run start instead gives every such run its
 * deliverable tabs the moment it is live, deterministically. This is sound
 * because templated artifacts RE-DERIVE their content on READ from the live
 * entity DB (the row is just a pointer: atype + sourceRef=ideaId) — an early
 * mint is always fresh, and the decomposed-stories tab simply renders its "not
 * decomposed yet" empty state until the decomposition exists.
 *
 * Planner is included: its idea-spec / decomposed-stories deliverables were
 * meant to mint via the `outputArtifact` steps, but since no step ever reports
 * 'done', that path never fired. The run-start path is the deterministic fix.
 * For a SEEDED planner run the idea exists at the initial 'running' and mints
 * immediately; for a raw-prompt planner run the idea is CREATED during 'context'
 * (not yet present at the initial 'running'), so stepTransitionBridge fires this
 * hook on every planner 'running' transition — the first one after the idea
 * exists mints it, and the idempotent (runId, atype) UPSERT makes every later
 * call a no-op re-derive.
 *
 * Launch mirrors planner here: its ideas are created during the 'ideas' step
 * (not yet present at the initial 'interview' running), so the same
 * fires-on-every-'running' / idempotent-UPSERT reasoning applies unchanged.
 */
const BASELINE_RUN_START_WORKFLOWS = new Set<string>(['planner', 'sprint', 'ship', 'launch']);

/**
 * Workflows whose templated baselines are CONTENT-DRIVEN: the deliverable tabs
 * mint as the entity model fills in (handleEntityWrite on each idea/epic/task
 * write) rather than wholesale at run start. A seeded planner/ship mints its
 * idea-spec at start (the idea exists) but SKIPS decomposed-stories until the
 * first epic/task lands; a raw-prompt planner mints nothing at start (no idea
 * yet) and relies entirely on handleEntityWrite. Launch mints nothing at start
 * either — its ideas don't exist until the 'ideas' step — and relies entirely on
 * handleEntityWrite, same as a raw-prompt planner. Sprint stays run-start-driven
 * — its decomposition pre-exists, so both baselines are real at start.
 */
const CONTENT_DRIVEN_WORKFLOWS = new Set<string>(['planner', 'ship', 'launch']);

/**
 * Workflows whose runs are scanned for on-disk screenshot PNGs (the agent-driven
 * visual-verify deliverable). A scan mints/enriches a single 'screenshots'
 * artifact from whatever image files the producer laid down under the run's
 * artifacts dir — the SAFETY NET behind the agent-reported path
 * (cyboflow_report_artifact), so PNGs surface even when the orchestrator never
 * calls the tool. Planner has no visual step, so it is excluded.
 */
const VISUAL_SCAN_WORKFLOWS = new Set<string>(['sprint', 'ship']);

/** Provenance label per workflow stamped onto a scanned screenshots artifact. */
const VISUAL_SCAN_STEP_ORIGIN: Record<string, string> = {
  sprint: 'Sprint · visual-verify',
  ship: 'Ship · visual-verify',
};

/** Image extensions the gallery's load-images handler can serve back as data URLs. */
const SCREENSHOT_EXTS = new Set<string>(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/**
 * Injected resolver: runId -> the absolute run artifacts dir
 * (CYBOFLOW_DIR/artifacts/runs/<runId>), the SAME subtree artifacts:load-images
 * serves bytes from and the agent writes PNGs into via $CYBOFLOW_RUN_ARTIFACTS_DIR.
 * Set ONCE at boot from main/src/index.ts (the only layer allowed to import the
 * electron-backed cyboflowDirectory util). Left null in standalone/unit contexts,
 * where the scan is a deliberate no-op — preserving the standalone-typecheck
 * invariant (this module never imports 'electron'). Mirrors the ArtifactRouter
 * boot-singleton pattern.
 */
let runArtifactsDirResolver: ((runId: string) => string) | null = null;

/**
 * Inject the run-artifacts-dir resolver at boot (see runArtifactsDirResolver).
 * Pass null to clear it (the scan then no-ops) — used by unit tests to restore
 * the standalone default between cases.
 */
export function setRunArtifactsDirResolver(fn: ((runId: string) => string) | null): void {
  runArtifactsDirResolver = fn;
}

/** Run-start provenance label per workflow, stamped onto baseline artifacts. */
const RUN_START_STEP_ORIGIN: Record<string, string> = {
  planner: 'Plan · run start',
  sprint: 'Sprint · run start',
  ship: 'Ship · run start',
  launch: 'Launch · run start',
};

/** Entity-write provenance labels for the content-driven mint path. */
const ENTITY_WRITE_STEP_ORIGIN = {
  ideaSpec: 'Plan · idea spec',
  decomposition: 'Plan · decomposition',
  archDesign: 'Refine · architecture design',
  approveIdeas: 'Plan · approve ideas',
  approveDesigns: 'Refine · approve designs',
  ideaSummary: 'Plan · idea summary',
} as const;

/**
 * Workflows whose runs auto-mint the JOINT batch-gate artifacts (approve-ideas /
 * approve-designs). Only the multi-idea planning flows have those gates —
 * sprint has no planning gate and ship is single-idea — so the batch surfaces
 * are planner + launch, mirroring TEMPLATED_ATYPE_WORKFLOWS.
 */
const BATCH_GATE_WORKFLOWS = new Set<string>(['planner', 'launch']);

/**
 * Workflows whose runs auto-mint the templated 'idea-summary' hub artifact —
 * the per-idea ledger-status surface (idea spec / prototype / architecture /
 * epics / stories) that links out to each real sibling deliverable tab.
 * Deliberately its OWN set (NOT a reuse of BASELINE_RUN_START_WORKFLOWS or
 * CONTENT_DRIVEN_WORKFLOWS, even though its membership happens to equal the
 * former today) so a future change to either set does not silently change
 * idea-summary's mint surface. Minted at TWO seams:
 *   - handleRunStart, for every member here (planner, sprint, ship) — so a
 *     re-entered idea's hub is visible immediately even for a run that never
 *     edits the idea again (a standalone sprint purely executing an
 *     already-decomposed idea's tasks never calls handleEntityWrite
 *     meaningfully — see CONTENT_DRIVEN_WORKFLOWS below — so run-start is its
 *     ONLY mint opportunity).
 *   - handleEntityWrite, for CONTENT_DRIVEN_WORKFLOWS (planner, ship) only —
 *     refreshes the content gate as the idea's own components (spec,
 *     architecture) and its epics/stories fill in mid-run. A sprint's hub is
 *     therefore fixed at its run-start snapshot; the TAB CONTENT still stays
 *     live regardless (useArtifactData re-derives the ledger + idea on every
 *     read and subscribes to onTaskChanged/onComponentsChanged) — only the
 *     row's identity/label needs a mint, and sprint gets exactly one.
 */
const IDEA_SUMMARY_WORKFLOWS = new Set<string>(['planner', 'sprint', 'ship']);

// ---------------------------------------------------------------------------
// Step-origin labels (human-readable provenance shown on the artifact tab)
// ---------------------------------------------------------------------------

/** Phase·step provenance string stamped onto each auto-minted artifact. */
const STEP_ORIGIN: Record<string, string> = {
  context: 'Plan · get context',
  tasks: 'Refine · decompose into tasks',
  architecture: 'Refine · architecture design',
};

// ---------------------------------------------------------------------------
// Internal row shapes (narrow projections — no `any`)
// ---------------------------------------------------------------------------

interface RunRow {
  projectId: number | null;
}

interface IdeaContentRow {
  ref: string | null;
  title: string | null;
  body: string | null;
  summary: string | null;
}

// ---------------------------------------------------------------------------
// Definition / step resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the run's EFFECTIVE workflow definition and locate the step by id in
 * its flat step list. Mirrors the resolution in stepTransitionBridge.isValidStepId
 * / mcpQueryHandler.handleReportStep (resolveWorkflowDefinition is the runtime
 * source of truth that fully overrides the static WORKFLOW_DEFINITIONS seed).
 * Returns null when the run row is missing, the definition cannot be resolved, or
 * the step id is absent.
 */
function resolveStep(db: DatabaseLike, runId: string, stepId: string): WorkflowStep | null {
  // A/B testing (migration 048): resolve the run's FROZEN effective spec (its
  // variant graph, else the live spec) via resolveRunFrozenSpec instead of a live
  // JOIN read, so a variant run's steps resolve against ITS definition.
  const runRow = resolveRunFrozenSpec(db, runId);
  if (!runRow) return null;

  const def = resolveWorkflowDefinition(runRow.workflowName, runRow.specJson);
  if (def === null) return null;

  return def.phases.flatMap((p) => p.steps).find((s) => s.id === stepId) ?? null;
}

interface RunMetaRow {
  workflowName: unknown;
  status: unknown;
}

/**
 * Resolve the run's workflow name (workflows.name) and current lifecycle status
 * (workflow_runs.status). Used to (a) gate templated mints to the planner
 * workflow and (b) skip the mint when the run has already failed/canceled — both
 * read from the SAME row the synthesized lifecycle 'done' sees, since
 * transitionToFailed / transitionToCanceled stamp status BEFORE emitStep fires.
 * Returns null when the run row is missing.
 */
function resolveRunMeta(
  db: DatabaseLike,
  runId: string,
): { workflowName: string | null; status: string | null } | null {
  const row = db
    .prepare(
      `SELECT w.name AS workflowName, r.status AS status
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
        WHERE r.id = ?`,
    )
    .get(runId) as RunMetaRow | undefined;
  if (!row) return null;
  return {
    workflowName: typeof row.workflowName === 'string' ? row.workflowName : null,
    status: typeof row.status === 'string' ? row.status : null,
  };
}

/** Resolve the run's owning project id (workflow_runs.project_id), or null. */
function resolveProjectId(db: DatabaseLike, runId: string): number | null {
  const row = db
    .prepare('SELECT project_id AS projectId FROM workflow_runs WHERE id = ?')
    .get(runId) as RunRow | undefined;
  if (!row) return null;
  return typeof row.projectId === 'number' ? row.projectId : null;
}

/**
 * Resolve the single idea this run originates from / operates on for artifact
 * derivation: the FIRST of `listRunOwnedOrBatchIdeaIds` (the run's owned ideas —
 * seed_idea_id UNION run-created ideas — else the single sprint-batch idea a
 * standalone sprint operates on). Returns null when neither resolves. See
 * `runEntityOwnership.listRunOwnedOrBatchIdeaIds` for the full resolution order.
 */
function resolveOriginatingIdeaId(db: DatabaseLike, runId: string): string | null {
  const ideaIds = listRunOwnedOrBatchIdeaIds(db, runId);
  return ideaIds.length > 0 ? ideaIds[0] : null;
}

// ---------------------------------------------------------------------------
// Per-atype derivation + mint
// ---------------------------------------------------------------------------

/**
 * idea-spec mint for a KNOWN idea: label = the idea's title (falling back to its
 * ref, then `labelFallback`); sourceRef = ideaId. Content is re-derived on read
 * (mode 'template') so payloadJson is left null. Missing idea row → fail-soft
 * (logs + returns without minting). Shared by the step-completion path
 * (mintIdeaSpec) and the run-start baseline path (handleRunStart).
 *
 * CONTENT GATE: an idea-spec tab is only minted when the idea actually has spec
 * content — a non-empty `body` OR `summary`. A bare idea (title/ref only, no
 * body/summary yet) is skipped so the deliverable never appears as an empty doc.
 */
async function mintIdeaSpecForIdea(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  ideaId: string,
  stepOrigin: string | null,
  labelFallback: string,
  logger?: LoggerLike,
): Promise<void> {
  const ideaRow = db
    .prepare('SELECT ref AS ref, title AS title, body AS body, summary AS summary FROM ideas WHERE id = ?')
    .get(ideaId) as IdeaContentRow | undefined;
  if (!ideaRow) {
    logger?.debug('[autoMintArtifacts] idea-spec skipped — idea row not found', { runId, ideaId });
    return;
  }

  // CONTENT GATE — refuse to mint when there is no spec content to render.
  const hasBody = typeof ideaRow.body === 'string' && ideaRow.body.length > 0;
  const hasSummary = typeof ideaRow.summary === 'string' && ideaRow.summary.length > 0;
  if (!hasBody && !hasSummary) {
    logger?.debug('[autoMintArtifacts] idea-spec skipped — idea has no body/summary yet', {
      runId,
      ideaId,
    });
    return;
  }

  const title = typeof ideaRow.title === 'string' && ideaRow.title.length > 0 ? ideaRow.title : null;
  const ref = typeof ideaRow.ref === 'string' && ideaRow.ref.length > 0 ? ideaRow.ref : null;
  const label = title ?? ref ?? labelFallback;

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'idea-spec',
    label,
    sourceRef: ideaId,
    stepOrigin,
    isNew: true,
    actor: 'orchestrator',
  });
}

/**
 * idea-spec mint for the ideas the run OWNS.
 *
 * SINGLE-idea run: one per-idea tab, sourceRef = the idea, label = its title —
 * unchanged since migration 062/063.
 *
 * MULTI-idea batch: ONE run-scoped COMBINED tab (the decomposed-stories
 * pattern) instead of N disjoint per-idea tabs. sourceRef anchors on the FIRST
 * owned idea so the row minted while the batch was still size 1 is ADOPTED in
 * place by the (run_id, atype, source_ref) UPSERT — the single→multi transition
 * converts that row rather than orphaning it. `payload_json.combined = true` is
 * the renderer's branch marker (it re-derives the batch's specs from the live
 * entity model via tasks.runDecomposition, exactly like decomposed-stories).
 * Content gate: only ideas with a body OR summary count toward the label; a
 * batch with NO content-bearing idea mints nothing.
 *
 * Resolution is the FULL result of `listRunOwnedOrBatchIdeaIds` — the run's
 * owned ideas (planner/ship/launch seed/create/adopt them), else the single
 * sprint-batch idea (a standalone sprint owns none) — vs. resolveOriginatingIdeaId,
 * which takes only the FIRST of that same list. No resolvable idea → fail-soft
 * (logs + returns).
 */
async function mintIdeaSpecForOwnedIdeas(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  stepOrigin: string | null,
  labelFallback: string,
  logger?: LoggerLike,
): Promise<void> {
  // Owned ideas, else the single sprint-batch idea (standalone sprint) — the
  // SHARED owned-else-batch resolution (runEntityOwnership.listRunOwnedOrBatchIdeaIds),
  // preserving resolveOriginatingIdeaId's second resolution rung.
  const ideaIds = listRunOwnedOrBatchIdeaIds(db, runId);
  if (ideaIds.length === 0) {
    logger?.debug('[autoMintArtifacts] idea-spec skipped — run owns no resolvable idea', { runId });
    return;
  }

  if (ideaIds.length === 1) {
    await mintIdeaSpecForIdea(db, runId, projectId, ideaIds[0], stepOrigin, labelFallback, logger);
    return;
  }

  // CONTENT GATE — mirror mintIdeaSpecForIdea's per-idea gate across the batch:
  // count the ideas that actually have spec content; none yet → no tab.
  let withContent = 0;
  for (const ideaId of ideaIds) {
    const row = db
      .prepare('SELECT body AS body, summary AS summary FROM ideas WHERE id = ?')
      .get(ideaId) as { body: unknown; summary: unknown } | undefined;
    if (!row) continue;
    const hasBody = typeof row.body === 'string' && row.body.length > 0;
    const hasSummary = typeof row.summary === 'string' && row.summary.length > 0;
    if (hasBody || hasSummary) withContent += 1;
  }
  if (withContent === 0) {
    logger?.debug('[autoMintArtifacts] combined idea-spec skipped — no idea has content yet', {
      runId,
    });
    return;
  }

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'idea-spec',
    label: 'Idea specs · ' + pluralize(withContent, 'idea'),
    sourceRef: ideaIds[0],
    stepOrigin,
    payloadJson: COMBINED_BATCH_PAYLOAD_JSON,
    isNew: true,
    actor: 'orchestrator',
  });
}

/**
 * idea-spec: mint one per owned idea (multi-idea batch aware). No resolvable idea
 * → fail-soft (logs + returns without minting).
 */
async function mintIdeaSpec(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  step: WorkflowStep,
  logger?: LoggerLike,
): Promise<void> {
  await mintIdeaSpecForOwnedIdeas(
    db,
    runId,
    projectId,
    STEP_ORIGIN[step.id] ?? null,
    step.outputArtifact!.label,
    logger,
  );
}

/**
 * arch-design mint for a KNOWN idea: label = 'Architecture design';
 * sourceRef = ideaId. Content is re-derived on read (mode 'template') from the
 * idea body's '## Architecture design' section, so payloadJson is left null.
 * Missing idea row → fail-soft (logs + returns without minting). Shared by the
 * step-completion, run-start, and entity-write paths.
 *
 * CONTENT GATE: only minted when extractArchDesignSection(body) is non-null —
 * the SAME shared extractor the frontend renders with, so the tab can never
 * mint against a body the renderer would show empty.
 */
async function mintArchDesignForIdea(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  ideaId: string,
  stepOrigin: string | null,
  logger?: LoggerLike,
): Promise<void> {
  const ideaRow = db
    .prepare('SELECT ref AS ref, title AS title, body AS body, summary AS summary FROM ideas WHERE id = ?')
    .get(ideaId) as IdeaContentRow | undefined;
  if (!ideaRow) {
    logger?.debug('[autoMintArtifacts] arch-design skipped — idea row not found', { runId, ideaId });
    return;
  }

  // CONTENT GATE — refuse to mint when the body has no architecture-design section.
  const body = typeof ideaRow.body === 'string' ? ideaRow.body : null;
  if (extractArchDesignSection(body) === null) {
    logger?.debug('[autoMintArtifacts] arch-design skipped — no architecture-design section yet', {
      runId,
      ideaId,
    });
    return;
  }

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'arch-design',
    label: 'Architecture design',
    sourceRef: ideaId,
    stepOrigin,
    isNew: true,
    actor: 'orchestrator',
  });
}

/**
 * arch-design mint for EVERY idea the run OWNS — the per-entity sibling of
 * mintIdeaSpecForOwnedIdeas (migration 073 makes arch-design identity
 * (run_id, atype, source_ref), so the per-idea rows coexist). A multi-idea planner
 * run that runs architecture across several ideas surfaces one architecture tab
 * per idea. Each per-idea mint is content-gated inside mintArchDesignForIdea (an
 * idea whose body carries no '## Architecture design' section is skipped), so a
 * batch surfaces a tab only for the ideas that actually have an architecture
 * design yet. No resolvable idea → fail-soft (logs + returns).
 */
async function mintArchDesignForOwnedIdeas(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  stepOrigin: string | null,
  logger?: LoggerLike,
): Promise<void> {
  const ideaIds = listRunOwnedOrBatchIdeaIds(db, runId);
  if (ideaIds.length === 0) {
    logger?.debug('[autoMintArtifacts] arch-design skipped — run owns no resolvable idea', { runId });
    return;
  }
  for (const ideaId of ideaIds) {
    await mintArchDesignForIdea(db, runId, projectId, ideaId, stepOrigin, logger);
  }
}

/** Fixed label for the SINGLE-idea idea-summary hub tab (mirrors arch-design's fixed label). */
const IDEA_SUMMARY_LABEL = 'Idea summary';

/**
 * Label STEM for the COMBINED multi-idea hub tab; the idea count is appended
 * ('Idea summaries · 4 ideas'). Its own constant rather than a pluralization of
 * IDEA_SUMMARY_LABEL because 'summary' → 'summaries' is not the suffix rule
 * `pluralize` implements.
 */
const IDEA_SUMMARIES_LABEL = 'Idea summaries';

/**
 * CONTENT GATE for idea-summary: true when at least one of the idea's five
 * ledger components carries REAL state — complete, explicitly skipped, or
 * incomplete-but-needs-review (staleAt !== null, prior work exists that just
 * needs re-verification). False only when every component is the untouched
 * "not started" default (state='incomplete', staleAt=null) — a hub summarizing
 * a totally blank ledger has nothing useful to show, mirroring every other
 * templated atype's content gate in this file.
 */
function hasMeaningfulComponentState(states: IdeaComponentState[]): boolean {
  return states.some((s) => s.state !== 'incomplete' || s.staleAt !== null);
}

/**
 * idea-summary mint for a KNOWN idea: label = the fixed IDEA_SUMMARY_LABEL;
 * sourceRef = ideaId. Content (the ledger snapshot + links to sibling
 * deliverables) is entirely re-derived on read (mode 'template') by the
 * frontend's useArtifactData (idea + `cyboflow.ideaComponents.get`), so
 * payloadJson stays null here. Missing idea row -> fail-soft. Reached ONLY via
 * mintIdeaSummaryForOwnedIdeas's SINGLE-idea branch (a multi-idea batch mints
 * one combined tab instead — see that function).
 *
 * CONTENT GATE: only minted when resolveIdeaComponents finds at least one
 * component with real state (hasMeaningfulComponentState) — see that
 * function's doc.
 */
async function mintIdeaSummaryForIdea(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  ideaId: string,
  stepOrigin: string | null,
  logger?: LoggerLike,
): Promise<void> {
  const ideaRow = db.prepare('SELECT id AS id FROM ideas WHERE id = ?').get(ideaId) as
    | { id: string }
    | undefined;
  if (!ideaRow) {
    logger?.debug('[autoMintArtifacts] idea-summary skipped — idea row not found', { runId, ideaId });
    return;
  }

  const states = resolveIdeaComponents(db, ideaId);
  if (!hasMeaningfulComponentState(states)) {
    logger?.debug('[autoMintArtifacts] idea-summary skipped — ledger has no meaningful component yet', {
      runId,
      ideaId,
    });
    return;
  }

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'idea-summary',
    label: IDEA_SUMMARY_LABEL,
    sourceRef: ideaId,
    stepOrigin,
    isNew: true,
    actor: 'orchestrator',
  });
}

/**
 * idea-summary mint for the ideas the run OWNS.
 *
 * SINGLE-idea run: one per-idea hub tab, sourceRef = the idea, label = the fixed
 * IDEA_SUMMARY_LABEL — unchanged since migration 102.
 *
 * MULTI-idea batch: ONE run-scoped COMBINED tab (the mintIdeaSpecForOwnedIdeas
 * pattern) instead of N per-idea tabs that all carry the SAME fixed label and are
 * therefore indistinguishable in the tab strip. sourceRef anchors on the FIRST
 * owned idea so the row minted while the batch was still size 1 is ADOPTED in
 * place by the (run_id, atype, source_ref) UPSERT — the single→multi transition
 * converts that row rather than orphaning it. `payload_json.combined = true` is
 * the renderer's branch marker (it re-derives the batch's ideas from the live
 * entity model via tasks.runDecomposition + ideaComponents.getMany, exactly like
 * the combined idea-spec tab).
 *
 * CONTENT GATE (batch): mirrors the per-idea gate across the batch — the tab is
 * minted once at least ONE owned idea's ledger carries real state
 * (hasMeaningfulComponentState). Ideas whose ledger is still the untouched
 * "not started" default DO get a row on the combined tab (five "not started"
 * cells is real information about the batch, unlike a lone hub over a blank
 * ledger), so the label counts every non-archived owned idea rather than only
 * the state-bearing ones.
 *
 * No resolvable idea → fail-soft (logs + returns).
 */
async function mintIdeaSummaryForOwnedIdeas(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  stepOrigin: string | null,
  logger?: LoggerLike,
): Promise<void> {
  const ideaIds = listRunOwnedOrBatchIdeaIds(db, runId);
  if (ideaIds.length === 0) {
    logger?.debug('[autoMintArtifacts] idea-summary skipped — run owns no resolvable idea', { runId });
    return;
  }

  if (ideaIds.length === 1) {
    await mintIdeaSummaryForIdea(db, runId, projectId, ideaIds[0], stepOrigin, logger);
    return;
  }

  // CONTENT GATE + label count: `withState` gates the tab (at least one real
  // ledger state anywhere in the batch), `rendered` is the row count the renderer
  // will show (non-archived owned ideas) and so the count in the label. The
  // ledgers come from the GROUPED resolveIdeaComponentsBatch rather than a
  // resolve per idea — this runs on every entity write of a planner run.
  const ledgers = resolveIdeaComponentsBatch(db, ideaIds);
  let withState = 0;
  let rendered = 0;
  for (const ideaId of ideaIds) {
    const row = db.prepare('SELECT archived_at AS archivedAt FROM ideas WHERE id = ?').get(ideaId) as
      | { archivedAt: unknown }
      | undefined;
    if (!row) continue;
    if (row.archivedAt === null || row.archivedAt === undefined) rendered += 1;
    if (hasMeaningfulComponentState(ledgers.get(ideaId) ?? [])) withState += 1;
  }
  if (withState === 0) {
    logger?.debug('[autoMintArtifacts] combined idea-summary skipped — no idea has a meaningful ledger yet', {
      runId,
    });
    return;
  }
  if (rendered === 0) {
    logger?.debug('[autoMintArtifacts] combined idea-summary skipped — every owned idea is archived', { runId });
    return;
  }

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'idea-summary',
    label: IDEA_SUMMARIES_LABEL + ' · ' + pluralize(rendered, 'idea'),
    sourceRef: ideaIds[0],
    stepOrigin,
    payloadJson: COMBINED_BATCH_PAYLOAD_JSON,
    isNew: true,
    actor: 'orchestrator',
  });
}

/** Narrow projection for a batch-gate payload row (one per owned idea). */
interface IdeaBatchRow {
  ref: unknown;
  title: unknown;
  scope: unknown;
  summary: unknown;
  body: unknown;
}

/** Read one owned idea's batch-gate row fields (ref/title/scope/summary/body). */
function readIdeaBatchRow(db: DatabaseLike, ideaId: string): IdeaBatchRow | undefined {
  return db
    .prepare('SELECT ref AS ref, title AS title, scope AS scope, summary AS summary, body AS body FROM ideas WHERE id = ?')
    .get(ideaId) as IdeaBatchRow | undefined;
}

/**
 * Auto-mint the JOINT approve-ideas gate artifact (issue 1, deterministic): the
 * human-facing surface that renders one Approve/Deny row per owned idea. Unlike
 * the agent-reported legacy path, this mints from the run's OWNED idea rows so the
 * combined tab appears reliably for every multi-idea planner batch — the gate
 * DECISION (blocking review item) is still opened by the planner, but the surface
 * it renders into is now orchestrator-guaranteed.
 *
 * BATCH-ONLY: minted only when MORE THAN ONE owned idea carries stub/spec content
 * (a non-empty body OR summary AND a display ref). A single-idea run uses the
 * inline approve-idea gate and gets no joint tab. Content is STORED in
 * payload_json (the rows the template renders), refreshed on every re-mint
 * (idempotent UPSERT) as the stubs fill in. No resolvable batch → fail-soft.
 */
async function mintApproveIdeasForBatch(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  stepOrigin: string | null,
  logger?: LoggerLike,
): Promise<void> {
  if (listRunOwnedOrBatchIdeaIds(db, runId).length <= 1) return; // joint gate is for a multi-idea batch only

  // SHARED row derivation (runEntityOwnership.listApproveIdeasBatchRows): the
  // programmatic gate:human-step:approve-ideas payload's `ideaRefs` derive from
  // the SAME helper, so the tab's rows and the gate's refs can never drift.
  const ideas: ApproveIdeasArtifactPayload['ideas'] = listApproveIdeasBatchRows(db, runId);
  if (ideas.length <= 1) {
    logger?.debug('[autoMintArtifacts] approve-ideas skipped — fewer than 2 ideas with content', {
      runId,
      count: ideas.length,
    });
    return;
  }

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'approve-ideas',
    label: 'Approve ideas',
    payloadJson: JSON.stringify({ ideas } satisfies ApproveIdeasArtifactPayload),
    stepOrigin,
    isNew: true,
    actor: 'orchestrator',
  });
}

/**
 * Auto-mint the JOINT approve-designs gate artifact (issue 2, deterministic): the
 * design-approval sibling of mintApproveIdeasForBatch, rendering one Approve/Deny
 * row per owned idea whose body carries a '## Architecture design' section.
 *
 * BATCH-ONLY: minted only when MORE THAN ONE owned idea has an architecture design
 * (extractArchDesignSection non-null) AND a display ref. When exactly one idea has
 * a design the inline approve-design gate handles it and no joint tab appears.
 * Content is STORED in payload_json, refreshed on every re-mint. No qualifying
 * batch → fail-soft (no tab).
 */
async function mintApproveDesignsForBatch(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  stepOrigin: string | null,
  logger?: LoggerLike,
): Promise<void> {
  const ideaIds = listRunOwnedOrBatchIdeaIds(db, runId);
  if (ideaIds.length <= 1) return; // joint design gate is for a multi-idea batch only

  const designs: ApproveDesignsArtifactPayload['designs'] = [];
  for (const ideaId of ideaIds) {
    const row = readIdeaBatchRow(db, ideaId);
    if (!row) continue;
    const ref = typeof row.ref === 'string' && row.ref.length > 0 ? row.ref : null;
    if (ref === null) continue; // rows are keyed by display ref (the verdict-map key)
    const body = typeof row.body === 'string' ? row.body : null;
    if (extractArchDesignSection(body) === null) continue; // no architecture design yet
    const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : ref;
    const summary = typeof row.summary === 'string' && row.summary.length > 0 ? row.summary : null;
    designs.push({
      ref,
      title,
      scope: typeof row.scope === 'string' && row.scope.length > 0 ? row.scope : null,
      summary,
    });
  }
  if (designs.length <= 1) {
    logger?.debug('[autoMintArtifacts] approve-designs skipped — fewer than 2 ideas with a design', {
      runId,
      count: designs.length,
    });
    return;
  }

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'approve-designs',
    label: 'Approve designs',
    payloadJson: JSON.stringify({ designs } satisfies ApproveDesignsArtifactPayload),
    stepOrigin,
    isNew: true,
    actor: 'orchestrator',
  });
}

/**
 * Count an idea's epics + tasks. Mirrors TaskChangeRouter.collectDeleteCascade:
 * epics by originating_idea_id; tasks reachable directly (originating_idea_id)
 * UNION via a child epic (parent_epic_id IN epics), deduped.
 */
function countDecomposition(
  db: DatabaseLike,
  projectId: number,
  ideaId: string,
): { epicCount: number; taskCount: number } {
  const epics = db
    .prepare('SELECT id AS id FROM epics WHERE originating_idea_id = ? AND project_id = ?')
    .all(ideaId, projectId) as Array<{ id: unknown }>;
  const epicIds = epics
    .map((r) => r.id)
    .filter((id): id is string => typeof id === 'string');

  const taskIds = new Set<string>();

  const directTasks = db
    .prepare('SELECT id AS id FROM tasks WHERE originating_idea_id = ? AND project_id = ?')
    .all(ideaId, projectId) as Array<{ id: unknown }>;
  for (const r of directTasks) {
    if (typeof r.id === 'string') taskIds.add(r.id);
  }

  if (epicIds.length > 0) {
    const placeholders = epicIds.map(() => '?').join(',');
    const epicTasks = db
      .prepare(`SELECT id AS id FROM tasks WHERE parent_epic_id IN (${placeholders})`)
      .all(...epicIds) as Array<{ id: unknown }>;
    for (const r of epicTasks) {
      if (typeof r.id === 'string') taskIds.add(r.id);
    }
  }

  return { epicCount: epicIds.length, taskCount: taskIds.size };
}

/** Pluralize a noun by count (1 epic / 2 epics). Plain concatenation — no nested template literals. */
function pluralize(count: number, noun: string): string {
  return String(count) + ' ' + noun + (count === 1 ? '' : 's');
}

/**
 * decomposed-stories mint, RUN-SCOPED (batch fix, IDEA-009): label reflects the
 * COMBINED epic/task count across EVERY idea the run owns
 * (`listRunOwnedOrBatchIdeaIds` — the SAME owned-else-batch resolution the
 * multi-idea idea-spec mint uses), e.g. "5 epics, 12 tasks across 3 ideas".
 * sourceRef stays the run's FIRST owned idea (`ideaId`) — artifact IDENTITY is
 * UNCHANGED: still exactly ONE decomposed-stories artifact per (run_id, atype),
 * never one per idea like idea-spec (migration 063's per-source-ref identity is
 * idea-spec-only). Content is re-derived on read (mode 'template') so
 * payloadJson is left null. Shared by the step-completion path
 * (mintDecomposedStories) and the run-start baseline path (handleRunStart).
 *
 * CONTENT GATE: only minted when the COMBINED count across all owned ideas is
 * > 0. A run whose owned ideas are ALL not-yet-decomposed is skipped so the
 * deliverable never appears as an empty "0 epics, 0 tasks" tab. The label is
 * computed from the LIVE combined count at mint time, so a content-driven
 * re-mint (each task create, idempotent UPSERT) refreshes the count as ANY
 * owned idea's decomposition grows — not just the first idea's.
 */
async function mintDecomposedStoriesForIdea(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  ideaId: string,
  stepOrigin: string | null,
  logger?: LoggerLike,
): Promise<void> {
  // The run's full owned-idea set (falling back to [ideaId] defensively — this
  // should always include ideaId itself, since ideaId is derived from the same
  // owned-else-batch resolution by every caller).
  const ownedIdeaIds = listRunOwnedOrBatchIdeaIds(db, runId);
  const ideaIds = ownedIdeaIds.length > 0 ? ownedIdeaIds : [ideaId];

  let epicCount = 0;
  let taskCount = 0;
  for (const id of ideaIds) {
    const counts = countDecomposition(db, projectId, id);
    epicCount += counts.epicCount;
    taskCount += counts.taskCount;
  }

  // CONTENT GATE — nothing decomposed across ANY owned idea yet → do not mint
  // an empty stories tab.
  if (epicCount === 0 && taskCount === 0) {
    logger?.debug('[autoMintArtifacts] decomposed-stories skipped — no decomposition yet', {
      runId,
      ideaId,
      ideaCount: ideaIds.length,
    });
    return;
  }

  // Build the label with plain string concatenation (no nested template
  // literals). Multi-idea runs append ' across K ideas' so the tab reads as a
  // combined count rather than implying a single idea's decomposition.
  let label = pluralize(epicCount, 'epic') + ', ' + pluralize(taskCount, 'task');
  if (ideaIds.length > 1) {
    label = label + ' across ' + String(ideaIds.length) + ' ideas';
  }

  await ArtifactRouter.getInstance().apply(projectId, {
    op: 'create',
    runId,
    atype: 'decomposed-stories',
    label,
    sourceRef: ideaId,
    stepOrigin,
    isNew: true,
    actor: 'orchestrator',
  });
}

/**
 * decomposed-stories: resolve the run's originating idea, then mint via
 * mintDecomposedStoriesForIdea. No resolvable idea → fail-soft.
 */
async function mintDecomposedStories(
  db: DatabaseLike,
  runId: string,
  projectId: number,
  step: WorkflowStep,
  logger?: LoggerLike,
): Promise<void> {
  const ideaId = resolveOriginatingIdeaId(db, runId);
  if (ideaId === null) {
    logger?.debug('[autoMintArtifacts] decomposed-stories skipped — run owns no resolvable idea', {
      runId,
    });
    return;
  }
  await mintDecomposedStoriesForIdea(db, runId, projectId, ideaId, STEP_ORIGIN[step.id] ?? null, logger);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Auto-mint the artifact a completed step produces, if any.
 *
 * Called from stepTransitionBridge AFTER a step_transition row is persisted, ONLY
 * for status='done'. Resolves the run's effective workflow definition, finds the
 * step by id; if `step.outputArtifact` is undefined, returns. Otherwise derives
 * the artifact identity from the entity DB and mints it via the ArtifactRouter
 * chokepoint (templated types leave payloadJson null — content is re-derived on
 * read).
 *
 * TERMINAL-STATUS GATE (finding H-automint-1): the run-end lifecycle fires a
 * synthesized 'done' for the INITIAL step id (planner='context') on EVERY
 * terminal seam — clean drain AND failure AND cancel. Because transitionToFailed
 * / transitionToCanceled stamp workflow_runs.status terminal BEFORE that emit,
 * we read the run's status here and SKIP the templated mint when it is
 * 'failed'/'canceled' (so a never-completed context step does not produce an
 * idea-spec stamped as if it succeeded). A 'completed'/'running'/gated run mints
 * normally — the explicit-agent report_step path never sets status terminal.
 *
 * WORKFLOW GATE (finding H-automint-2): the templated atypes ('idea-spec' /
 * 'decomposed-stories') are planner/launch-only by design (launch is the
 * multi-idea super-planner). A custom/edited step outside that set declaring
 * one of them is fail-soft skipped (it would otherwise mint against the run's
 * owned ideas).
 *
 * FAIL-SOFT: the whole body is wrapped in try/catch — any failure logs via
 * `logger` and returns. NEVER throws (the caller is in the step-transition path).
 *
 * @param db     Narrow DatabaseLike interface.
 * @param runId  The workflow_runs.id whose step just completed.
 * @param stepId The id of the completed step.
 * @param logger Optional LoggerLike for warn/debug-level fail-soft logging.
 */
export async function handleStepCompletion(
  db: DatabaseLike,
  runId: string,
  stepId: string,
  logger?: LoggerLike,
): Promise<void> {
  try {
    const step = resolveStep(db, runId, stepId);
    if (step === null || step.outputArtifact === undefined) return; // no artifact-producing step

    const projectId = resolveProjectId(db, runId);
    if (projectId === null) {
      logger?.debug('[autoMintArtifacts] skipped — no project_id for run', { runId, stepId });
      return;
    }

    const atype = step.outputArtifact.atype;
    // Only the templated planner atypes are auto-minted from a step completion in
    // this milestone; other atypes (screenshots/ui-prototype/generic) are
    // agent/user canvas writes and are not gated here.
    if (atype === 'idea-spec' || atype === 'decomposed-stories') {
      const meta = resolveRunMeta(db, runId);

      // Finding H-automint-1: skip the templated mint when the run has already
      // failed/canceled. The synthesized lifecycle 'done' fires AFTER the
      // failed/canceled status stamp, so the step did not actually complete.
      if (meta !== null && meta.status !== null && TERMINAL_SKIP_STATUSES.has(meta.status)) {
        logger?.debug(
          '[autoMintArtifacts] skipped — run is in a terminal failed/canceled state',
          { runId, stepId, status: meta.status, atype },
        );
        return;
      }

      // Finding H-automint-2: the templated atypes are planner/launch-only. A
      // custom / edited step outside that set declaring them is fail-soft skipped.
      if (meta !== null && (meta.workflowName === null || !TEMPLATED_ATYPE_WORKFLOWS.has(meta.workflowName))) {
        logger?.debug(
          '[autoMintArtifacts] skipped — templated atype declared by a non-planner/launch workflow',
          { runId, stepId, workflowName: meta.workflowName, atype },
        );
        return;
      }
    }

    // arch-design mirrors the templated gates, but is planner+ship+launch (not
    // planner-only): the optional architecture step exists on all three workflows.
    if (atype === 'arch-design') {
      const meta = resolveRunMeta(db, runId);

      if (meta !== null && meta.status !== null && TERMINAL_SKIP_STATUSES.has(meta.status)) {
        logger?.debug(
          '[autoMintArtifacts] skipped — run is in a terminal failed/canceled state',
          { runId, stepId, status: meta.status, atype },
        );
        return;
      }

      if (meta !== null && (meta.workflowName === null || !ARCH_DESIGN_WORKFLOWS.has(meta.workflowName))) {
        logger?.debug(
          '[autoMintArtifacts] skipped — arch-design atype declared by a non-planner/ship/launch workflow',
          { runId, stepId, workflowName: meta.workflowName, atype },
        );
        return;
      }

      // Per OWNED idea (migration 073 made arch-design per-entity), so a
      // multi-idea planner batch surfaces one architecture tab per idea.
      await mintArchDesignForOwnedIdeas(db, runId, projectId, STEP_ORIGIN[step.id] ?? null, logger);
      return;
    }

    if (atype === 'idea-spec') {
      await mintIdeaSpec(db, runId, projectId, step, logger);
    } else if (atype === 'decomposed-stories') {
      await mintDecomposedStories(db, runId, projectId, step, logger);
    }
  } catch (err) {
    const msg = `[autoMintArtifacts] auto-mint failed for runId=${runId} stepId=${stepId} (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) {
      logger.warn(msg, { runId, stepId });
    } else {
      console.warn(msg);
    }
  }
}

/**
 * Auto-mint a run's BASELINE artifacts at run start (sprint / ship). Called from
 * stepTransitionBridge when the run's INITIAL step first goes 'running'.
 *
 * Mints both templated baselines — idea-spec + decomposed-stories — for the idea
 * the run originates from / operates on (resolveOriginatingIdeaId, which for a
 * standalone sprint resolves the idea via its sprint batch). These are the
 * deterministic half of the hybrid: agents enrich the same run with
 * ui-prototype / screenshots / generic canvases via the cyboflow_report_artifact
 * MCP tool (the same ArtifactRouter chokepoint, op='create' UPSERT).
 *
 * Gates:
 *   - WORKFLOW: only BASELINE_RUN_START_WORKFLOWS (sprint, ship). A planner run's
 *     initial-step 'running' is a no-op here (planner mints via its
 *     outputArtifact steps).
 *   - TERMINAL: a run already stamped failed/canceled (the synthesized lifecycle
 *     can emit a late 'running' on teardown) does not mint — mirrors the
 *     handleStepCompletion terminal gate.
 *
 * IDEMPOTENT: op='create' UPSERTs by (runId, atype), so a re-emitted initial-step
 * 'running' (observed: the initial step can emit 'running' more than once) is a
 * no-op re-derive, not a duplicate.
 *
 * FAIL-SOFT: the whole body is wrapped in try/catch — any failure logs via
 * `logger` and returns. NEVER throws (the caller is in the step-transition path).
 *
 * @param db     Narrow DatabaseLike interface.
 * @param runId  The workflow_runs.id whose run just started.
 * @param logger Optional LoggerLike for warn/debug-level fail-soft logging.
 */
export async function handleRunStart(
  db: DatabaseLike,
  runId: string,
  logger?: LoggerLike,
): Promise<void> {
  try {
    const meta = resolveRunMeta(db, runId);
    if (meta === null || meta.workflowName === null) return;
    if (!BASELINE_RUN_START_WORKFLOWS.has(meta.workflowName)) return; // not a baseline-at-start workflow
    if (meta.status !== null && TERMINAL_SKIP_STATUSES.has(meta.status)) {
      logger?.debug('[autoMintArtifacts] run-start baseline skipped — run is failed/canceled', {
        runId,
        status: meta.status,
      });
      return;
    }

    const projectId = resolveProjectId(db, runId);
    if (projectId === null) {
      logger?.debug('[autoMintArtifacts] run-start baseline skipped — no project_id for run', { runId });
      return;
    }

    const ideaId = resolveOriginatingIdeaId(db, runId);
    if (ideaId === null) {
      logger?.debug('[autoMintArtifacts] run-start baseline skipped — run owns no resolvable idea', {
        runId,
        workflowName: meta.workflowName,
      });
      return;
    }

    const stepOrigin = RUN_START_STEP_ORIGIN[meta.workflowName] ?? null;
    // Both mints are CONTENT-GATED inside their helpers: a seeded planner/ship
    // mints idea-spec (the idea has content) and SKIPS decomposed-stories (count
    // 0); a sprint mints both (its decomposition pre-exists). A raw-prompt planner
    // and launch (whose ideas don't exist until the 'ideas' step) mint nothing
    // here (no resolvable idea yet) and rely on handleEntityWrite.
    //
    // idea-spec + arch-design iterate ALL owned ideas (both per-entity — the
    // multi-idea planner batch surfaces one spec AND one architecture tab per
    // idea, each content-gated). decomposed-stories is RUN-SCOPED: its label
    // combines the count across every owned idea, though it still mints as a
    // SINGLE artifact sourced off the first owned idea (`ideaId`) — identity is
    // unchanged.
    await mintIdeaSpecForOwnedIdeas(db, runId, projectId, stepOrigin, 'Idea spec', logger);
    await mintDecomposedStoriesForIdea(db, runId, projectId, ideaId, stepOrigin, logger);
    // arch-design is content-gated inside its helper (no-op for an idea whose body
    // has no '## Architecture design' section).
    await mintArchDesignForOwnedIdeas(db, runId, projectId, stepOrigin, logger);
    // Joint batch-gate surfaces (multi-idea planning flows only) — deterministic, so the
    // combined Approve-ideas / Approve-designs tabs never depend on the agent
    // reporting them. Each is batch-gated (>1 qualifying idea) inside its helper.
    if (BATCH_GATE_WORKFLOWS.has(meta.workflowName)) {
      await mintApproveIdeasForBatch(db, runId, projectId, stepOrigin, logger);
      await mintApproveDesignsForBatch(db, runId, projectId, stepOrigin, logger);
    }
    // idea-summary: minted for EVERY IDEA_SUMMARY_WORKFLOWS member (planner,
    // sprint, ship) — see that set's header for why sprint needs this run-start
    // mint (it never calls handleEntityWrite meaningfully, so this is its only
    // chance to get a hub tab at all). Content-gated inside the helper.
    if (IDEA_SUMMARY_WORKFLOWS.has(meta.workflowName)) {
      await mintIdeaSummaryForOwnedIdeas(db, runId, projectId, stepOrigin, logger);
    }
  } catch (err) {
    const msg = `[autoMintArtifacts] run-start baseline failed for runId=${runId} (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) {
      logger.warn(msg, { runId });
    } else {
      console.warn(msg);
    }
  }
}

/**
 * CONTENT-DRIVEN auto-mint hook: fired AFTER a successful entity write (idea /
 * epic / task) by mcpQueryHandler, this mints the templated deliverable the write
 * just made non-empty, for a planner/ship/launch run only (CONTENT_DRIVEN_WORKFLOWS).
 *
 *   - entityType 'idea'         -> idea-spec        (the spec the planner authored)
 *   - entityType 'epic'|'task'  -> decomposed-stories (the decomposition tree)
 *
 * This replaces the old "mint everything at run start" timing that surfaced an
 * EMPTY decomposed-stories tab the moment the run went live (no stories yet) and
 * auto-navigated the user into it. The mint helpers are CONTENT-GATED (idea-spec
 * needs a non-empty body/summary; decomposed-stories needs count > 0), so a write
 * that did not actually produce content is a no-op. The decomposed-stories label
 * is recomputed from the LIVE combined count across every idea the run owns at
 * every call, so the tab's count refreshes as tasks are added under ANY owned
 * idea, not just the one that triggered this write (idempotent UPSERT by
 * (runId, atype)).
 *
 * Idempotent: ArtifactRouter op='create' UPSERTs by (runId, atype) — a re-fire is
 * a no-op re-derive, not a duplicate. Fully fail-soft: the whole body is wrapped
 * in try/catch and NEVER throws/rejects (the caller fires it fire-and-forget off
 * the MCP task-write path; an artifact hiccup must never fail the agent's write).
 *
 * @param db         Narrow DatabaseLike interface.
 * @param runId      The workflow_runs.id whose entity was just written.
 * @param entityType The kind of entity written ('idea' | 'epic' | 'task').
 * @param logger     Optional LoggerLike for warn/debug-level fail-soft logging.
 */
export async function handleEntityWrite(
  db: DatabaseLike,
  runId: string,
  entityType: 'idea' | 'epic' | 'task',
  logger?: LoggerLike,
): Promise<void> {
  try {
    const meta = resolveRunMeta(db, runId);
    if (meta === null || meta.workflowName === null) return;
    if (!CONTENT_DRIVEN_WORKFLOWS.has(meta.workflowName)) return; // sprint mints at run start
    if (meta.status !== null && TERMINAL_SKIP_STATUSES.has(meta.status)) {
      logger?.debug('[autoMintArtifacts] entity-write mint skipped — run is failed/canceled', {
        runId,
        status: meta.status,
        entityType,
      });
      return;
    }

    const projectId = resolveProjectId(db, runId);
    if (projectId === null) {
      logger?.debug('[autoMintArtifacts] entity-write mint skipped — no project_id for run', { runId });
      return;
    }

    const ideaId = resolveOriginatingIdeaId(db, runId);
    if (ideaId === null) {
      logger?.debug('[autoMintArtifacts] entity-write mint skipped — run owns no resolvable idea', {
        runId,
        entityType,
      });
      return;
    }

    if (entityType === 'idea') {
      // idea-spec + arch-design both iterate ALL owned ideas (both per-entity —
      // the multi-idea planner batch surfaces one spec AND one architecture tab
      // per idea, each content-gated).
      await mintIdeaSpecForOwnedIdeas(
        db,
        runId,
        projectId,
        ENTITY_WRITE_STEP_ORIGIN.ideaSpec,
        'Idea spec',
        logger,
      );
      // The architecture step folds a '## Architecture design' section into an
      // idea body — the write that lands it fires this hook, and the content gate
      // no-ops every idea write until the section exists.
      await mintArchDesignForOwnedIdeas(
        db,
        runId,
        projectId,
        ENTITY_WRITE_STEP_ORIGIN.archDesign,
        logger,
      );
      // Joint batch-gate surfaces (multi-idea planning flows only): refresh the combined
      // Approve-ideas / Approve-designs tabs as each idea's stub / architecture
      // fills in. Batch-gated (>1 qualifying idea) inside each helper.
      if (BATCH_GATE_WORKFLOWS.has(meta.workflowName)) {
        await mintApproveIdeasForBatch(
          db,
          runId,
          projectId,
          ENTITY_WRITE_STEP_ORIGIN.approveIdeas,
          logger,
        );
        await mintApproveDesignsForBatch(
          db,
          runId,
          projectId,
          ENTITY_WRITE_STEP_ORIGIN.approveDesigns,
          logger,
        );
      }
      // idea-summary refreshes the run's hub — the idea's own spec/architecture
      // components just changed (or a bare stub idea's ledger finally became
      // meaningful). One per-idea tab on a single-idea run, one combined tab on
      // a batch.
      if (IDEA_SUMMARY_WORKFLOWS.has(meta.workflowName)) {
        await mintIdeaSummaryForOwnedIdeas(
          db,
          runId,
          projectId,
          ENTITY_WRITE_STEP_ORIGIN.ideaSummary,
          logger,
        );
      }
    } else {
      await mintDecomposedStoriesForIdea(
        db,
        runId,
        projectId,
        ideaId,
        ENTITY_WRITE_STEP_ORIGIN.decomposition,
        logger,
      );
      // epics/stories are two of the five ledger components, and an epic/task
      // write can change either for ANY idea the run owns (not just `ideaId`,
      // the first) — refresh over the whole owned set rather than a single idea.
      if (IDEA_SUMMARY_WORKFLOWS.has(meta.workflowName)) {
        await mintIdeaSummaryForOwnedIdeas(
          db,
          runId,
          projectId,
          ENTITY_WRITE_STEP_ORIGIN.ideaSummary,
          logger,
        );
      }
    }
  } catch (err) {
    const msg = `[autoMintArtifacts] entity-write mint failed for runId=${runId} entityType=${entityType} (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) {
      logger.warn(msg, { runId, entityType });
    } else {
      console.warn(msg);
    }
  }
}

/**
 * Scan the run's artifacts dir for screenshot images and mint/enrich a single
 * 'screenshots' artifact from whatever PNGs the visual-verify producer laid down.
 *
 * This is the SAFETY NET behind the agent-reported screenshots path: the sprint /
 * ship visual-verify flow writes PNG bytes under $CYBOFLOW_RUN_ARTIFACTS_DIR
 * (== CYBOFLOW_DIR/artifacts/runs/<runId>) and is asked to report them via
 * cyboflow_report_artifact(atype:'screenshots') — but if it captures images yet
 * forgets to report them, this scan surfaces the tab anyway. Fired off each step
 * 'running' transition for a sprint/ship run (stepTransitionBridge), so any
 * images on disk after the visual step appear without waiting on the agent.
 *
 * Gates:
 *   - RESOLVER: no-op when the run-artifacts-dir resolver is not injected
 *     (standalone/unit contexts) — see runArtifactsDirResolver.
 *   - WORKFLOW: only VISUAL_SCAN_WORKFLOWS (sprint, ship).
 *   - TERMINAL: a run already stamped failed/canceled does not mint (mirrors the
 *     other hooks' terminal gate).
 *
 * UNOBTRUSIVE: the mint uses isNew=false so this background scan never steals the
 * center pane / pulses the tab — only an explicit agent report (isNew=true) or
 * the user surfaces it. The fileNames are SORTED so a re-scan with the same files
 * produces byte-identical payload_json → the idempotent (runId, atype) UPSERT
 * records no delta and emits no event (no UI churn).
 *
 * FAIL-SOFT: the whole body is wrapped in try/catch — any failure (missing dir,
 * unreadable, ArtifactRouter not initialized) logs via `logger` and returns.
 * NEVER throws (the caller is in the step-transition path). A missing dir (no
 * images captured yet) is the common case and is a silent no-op.
 *
 * @param db     Narrow DatabaseLike interface.
 * @param runId  The workflow_runs.id to scan.
 * @param logger Optional LoggerLike for warn/debug-level fail-soft logging.
 */
export async function handleVisualArtifactsScan(
  db: DatabaseLike,
  runId: string,
  logger?: LoggerLike,
): Promise<void> {
  try {
    if (runArtifactsDirResolver === null) return; // not wired (standalone/unit) → no-op

    const meta = resolveRunMeta(db, runId);
    if (meta === null || meta.workflowName === null) return;
    if (!VISUAL_SCAN_WORKFLOWS.has(meta.workflowName)) return; // not a visual-scan workflow
    if (meta.status !== null && TERMINAL_SKIP_STATUSES.has(meta.status)) {
      logger?.debug('[autoMintArtifacts] screenshots scan skipped — run is failed/canceled', {
        runId,
        status: meta.status,
      });
      return;
    }

    const projectId = resolveProjectId(db, runId);
    if (projectId === null) {
      logger?.debug('[autoMintArtifacts] screenshots scan skipped — no project_id for run', { runId });
      return;
    }

    const dir = runArtifactsDirResolver(runId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return; // dir does not exist yet — nothing captured (common case, silent)
    }

    const fileNames = entries
      .filter((name) => SCREENSHOT_EXTS.has(path.extname(name).toLowerCase()))
      .sort((a, b) => a.localeCompare(b));
    if (fileNames.length === 0) return; // no image files → nothing to surface

    // §5.9: route through the ATOMIC merge op instead of a read-then-create. The
    // scan supplies ONLY the fresh on-disk fileNames — the router reads + merges
    // the stored payload (verdict banner, per-task reports, captureOrigin) inside
    // one per-project queue task, so a concurrent verdict delivery's reports entry
    // can never be lost to this scan's write (the pre-§5.9 read-then-create had
    // exactly that stale-read window). fileNames are UNIONED, so the scan never
    // shrinks the set either.
    await ArtifactRouter.getInstance().mergeScreenshots(projectId, {
      op: 'merge-screenshots',
      runId,
      label: pluralize(fileNames.length, 'screenshot'),
      fileNames,
      stepOrigin: VISUAL_SCAN_STEP_ORIGIN[meta.workflowName] ?? null,
      isNew: false,
      actor: 'orchestrator',
    });
  } catch (err) {
    const msg = `[autoMintArtifacts] screenshots scan failed for runId=${runId} (fail-soft): ${
      err instanceof Error ? err.message : String(err)
    }`;
    if (logger) {
      logger.warn(msg, { runId });
    } else {
      console.warn(msg);
    }
  }
}
