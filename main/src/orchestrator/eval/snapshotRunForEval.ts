/**
 * snapshotRunForEval — the TRIGGER side of the eval feature. Fired (fire-and-forget,
 * error-swallowed) when a built-in run crosses the sprint-review => human-review
 * boundary. It captures everything an async judge needs to survive worktree
 * teardown — the frozen diff, gate results, run provenance — into a pending
 * run_evals row RIGHT NOW (before a fast human merge can delete the worktree), then
 * enqueues the worker.
 *
 * Why capture at trigger and store TEXT (not a pointer): merge/dismiss close-out
 * removes the worktree; an async worker that tried to re-derive the diff later would
 * find it gone. The row is self-contained.
 *
 * Opt-in: default ON for built-in flows (isCyboflowWorkflowName); OFF for quick
 * sessions (they run under the __quick__ sentinel workflow, never a cyboflow name)
 * and custom/edited flows (checked on the WORKFLOW NAME, not the step id, since a
 * custom flow could carry a step literally named 'human-review'). Sprint + ship
 * reach this trigger; planner has no human-review step. COMPOUND and VERIFY-SETUP
 * both DO carry a terminal 'human-review' step (their "merge in changes" gate), but
 * both are EXPLICITLY EXEMPT here — verify-setup because its diff is a verification
 * runbook plus isolation levers whose real acceptance test is its own proof run
 * (docs/proposals/verification-setup-flow.md §5.1), and compound because it
 * mines already-merged work and its write-back diff (doc edits + quick fixes) is
 * not rubric-eval material. Both are skipped BY NAME even though they are cyboflow
 * built-ins — preserving the long-standing "planner/compound never auto-eval"
 * contract now that these flows have the step.
 *
 * Re-fire dedup: the composite PK (run_id, rubric_version) + INSERT OR IGNORE means
 * a request-changes loop or interactive resume re-reporting human-review does NOT
 * create a second row — instead it flips human_influenced=1 (the first, pre-human
 * snapshot is canonical) and does NOT re-enqueue or re-capture.
 *
 * AD-HOC INTERACTION (migration 090): snapshotRunForAdHocEval below can mint a row
 * with origin='adhoc' for the SAME (run, rubric_version) PK slot before this
 * automatic trigger ever fires. When that happens the existing-row branch here
 * treats the ad-hoc row as a re-fire: it flips human_influenced=1 (already 1 on an
 * ad-hoc row) and does NOT re-capture — i.e. the ad-hoc row OCCUPIES the slot and
 * the automatic pre-human snapshot is not taken for that run. This is ACCEPTED and
 * documented rather than fixed: the ad-hoc row is a mid-session (human-influenced)
 * grade of the same diff lineage, the human explicitly asked for it, and splitting
 * the PK to allow both would fork every downstream reader (insights canonical-row
 * selection, the score panel, retry-eval). It can only happen on a run whose
 * session called the MCP tool, which for built-in flows is not the norm.
 *
 * Standalone-typecheck invariant: no electron / better-sqlite3 / services import.
 * The diff capture is an injected closure (over GitDiffManager in index.ts).
 */
import type { DatabaseLike, LoggerLike } from '../types';
import type { RunGitDiff } from '../../../../shared/types/runFiles';
import { isCyboflowWorkflowName } from '../../../../shared/types/workflows';
import { computeSpecHash } from '../specHash';
import { exciseBootstrapDiff } from './exciseBootstrapDiff';
import { RUBRIC_VERSION } from './rubric';
import { judgeStaticPromptText } from './judgePromptScaffold';
import type { GateResults, GateStatus } from './scoring';

/**
 * The prompt-hash content address: the sha256 of the FULL run-independent judge
 * prompt (scoring-contract preamble + serialized rubric + output-format
 * instructions), not the rubric alone — so a preamble edit that changes judge
 * behavior actually changes the hash (see judgePromptScaffold).
 */
export function computeJudgePromptHash(): string {
  return computeSpecHash(judgeStaticPromptText());
}

export interface SnapshotDeps {
  db: DatabaseLike;
  logger?: LoggerLike;
  /** Diff capture closure (worktree, base ref) => unified diff + stats, or null. */
  gitDiff: (worktreePath: string, baseRef?: string) => Promise<RunGitDiff | null>;
  /** App version string (package.json), stamped as judge_build_id later by the worker. */
  appVersion: string;
  /**
   * GLOBAL code-review-eval on/off, read fresh per trigger. Injected as a closure
   * (over configManager.getCodeReviewEvalEnabled in index.ts) so this module keeps
   * the standalone-typecheck invariant — no concrete-service import. Consulted ONLY
   * when the per-run override (workflow_runs.eval_enabled) is NULL; a per-run 0/1
   * outranks it. Guarded at the call site: a throw here defaults to enabled.
   */
  isEvalEnabled: () => boolean;
  /**
   * Repo paths the run's RUNBOOK BOOTSTRAP wrote, excised from the captured diff
   * before it is frozen (docs/proposals/lane-runbook-bootstrap.md §11).
   *
   * This function already exempts verify-setup from auto-eval, and its stated
   * reason applies verbatim here: a verification runbook's real acceptance test
   * is its own proof run, not a rubric. The bootstrap moves that diff class into
   * sprint/ship runs, which ARE graded and A/B-compared — so without this a run
   * is scored on machine-written JSON none of its agents authored, and projects
   * that happen to need a bootstrap score differently for reasons unrelated to
   * the work.
   *
   * Absent (unit tests, any deployment with the feature off) ⇒ nothing is
   * excised, which is byte-identical to the pre-bootstrap behavior.
   */
  bootstrapWrittenPaths?: (runId: string) => string[];
  /**
   * Sub-toggle consulted ONLY for variant/experiment-TAGGED runs (A/B testing
   * slice C): the "Auto-grade variant & experiment runs" setting (default ON),
   * injected as a closure over configManager.getAutoGradeVariantRuns so this
   * module keeps its standalone-typecheck invariant. When a tagged run reaches
   * this trigger and auto-grade is OFF, the snapshot is skipped (no run_evals
   * row, no enqueue). Untagged built-in runs never consult it. Absent => treated
   * as ON (a config-read fault never silently disables auto-grade).
   */
  isVariantAutoGradeEnabled?: () => boolean;
  /** Enqueue the worker to grade this (run, rubric) after the row lands. */
  enqueue: (runId: string, rubricVersion: string) => void;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** The outcome of a trigger, surfaced for tests/logging. */
export type SnapshotOutcome = 'inserted' | 'refire' | 'skipped';

/**
 * The outcome of an AD-HOC (MCP-tool-requested) eval request. A discriminated
 * union so the MCP handler maps each branch to its own wire code without any
 * stringly-typed guessing:
 *   queued    — a fresh row was inserted and the worker enqueued.
 *   requeued  — a prior AD-HOC verdict was replaced (deleted + re-snapshotted).
 *   in_flight — a grade for this (run, rubric) is already pending/running; the
 *               request is a no-op (no writes, no second enqueue).
 *   rejected  — nothing was written; `reason` says why (see the decision table
 *               on snapshotRunForAdHocEval).
 */
export type AdHocSnapshotResult =
  | { outcome: 'queued' | 'requeued'; rubricVersion: string }
  | { outcome: 'in_flight'; rubricVersion: string }
  | { outcome: 'rejected'; reason: 'run_not_found' | 'tagged_run' | 'exists_auto' | 'no_diff' };

/** Value of run_evals.origin for a row minted by the ad-hoc MCP tool (migration 090). */
export const EVAL_ORIGIN_ADHOC = 'adhoc';

interface RunRow {
  project_id: number;
  worktree_path: string | null;
  base_sha: string | null;
  /**
   * Owning session (quick sessions link their `__quick__` sentinel run here).
   * Used ONLY by the ad-hoc path to recover a base ref when base_sha is NULL —
   * see resolveAdHocBaseRef.
   */
  session_id: string | null;
  spec_hash: string | null;
  model: string | null;
  /** Per-run eval override (migration 044): 0 = off, 1 = on, NULL = inherit global. */
  eval_enabled: number | null;
  /** A/B testing tags (migration 048) — set => this run is variant/experiment-tagged. */
  experiment_id: string | null;
  variant_id: string | null;
  workflow_id: string;
  workflowName: string;
}

interface StepResultRow {
  step_id: string;
  outcome: string;
  summary: string | null;
  error: string | null;
}

/**
 * Derive a coarse GateResults from a run's step_results rows. CAVEAT: cyboflow has
 * NO deterministic build/test/typecheck/lint artifact for orchestrated runs today
 * (step_results is written only on the programmatic plane). The single signal we
 * can honor is a *-verify step's outcome: 'failed' => the run's deterministic suite
 * failed (maps to test='fail' => GATED); 'done' => test='pass'. Everything else is
 * left absent so we never spuriously gate. Raw rows are retained for display.
 */
export function deriveGateResults(rows: StepResultRow[]): GateResults | null {
  if (rows.length === 0) return null;
  const verify = rows.find((r) => /verify/i.test(r.step_id));
  const gate: GateResults = { raw: rows };
  if (verify) {
    let status: GateStatus = 'unknown';
    if (verify.outcome === 'failed') status = 'fail';
    else if (verify.outcome === 'done') status = 'pass';
    gate.test = status;
  }
  return gate;
}

/**
 * Resolve the run + its (denormalized) workflow name. Workflows are
 * user-editable/deletable, so the name is snapshotted onto the eval row. Shared
 * by BOTH mint paths (automatic trigger + ad-hoc MCP tool) so a column added for
 * one is available to the other.
 */
function resolveRunRow(db: DatabaseLike, runId: string): RunRow | undefined {
  return db
    .prepare(
      `SELECT r.project_id AS project_id, r.worktree_path AS worktree_path,
              r.base_sha AS base_sha, r.session_id AS session_id,
              r.spec_hash AS spec_hash, r.model AS model,
              r.eval_enabled AS eval_enabled,
              r.experiment_id AS experiment_id, r.variant_id AS variant_id,
              r.workflow_id AS workflow_id, w.name AS workflowName
       FROM workflow_runs r
       JOIN workflows w ON w.id = r.workflow_id
       WHERE r.id = ?`,
    )
    .get(runId) as RunRow | undefined;
}

/**
 * Capture the frozen diff for a run. Best-effort by contract: a missing worktree
 * or a capture throw yields `{ diffText: null, diffStatsJson: null }` rather than
 * propagating — the AUTO path stores the null and lets the worker fail soft; the
 * AD-HOC path turns a null/empty capture into an immediate rejected/no_diff.
 */
async function captureFrozenDiff(
  runId: string,
  worktreePath: string | null,
  baseRef: string | undefined,
  deps: SnapshotDeps,
): Promise<{ diffText: string | null; diffStatsJson: string | null }> {
  if (!worktreePath) return { diffText: null, diffStatsJson: null };
  try {
    const captured = await deps.gitDiff(worktreePath, baseRef);
    if (!captured) return { diffText: null, diffStatsJson: null };
    // §11 — drop the runbook bootstrap's own files before the diff is frozen.
    // Best-effort like everything else on this path: a resolver that throws
    // leaves the diff exactly as captured, which is what shipped.
    let effective = captured;
    try {
      const excised = deps.bootstrapWrittenPaths?.(runId) ?? [];
      if (excised.length > 0) {
        effective = exciseBootstrapDiff(captured, excised);
        deps.logger?.debug('[eval] excised runbook-bootstrap files from the frozen diff', {
          runId,
          paths: excised,
        });
      }
    } catch (err) {
      deps.logger?.debug('[eval] bootstrap-path resolution failed; grading the diff as captured', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { diffText: effective.diff, diffStatsJson: JSON.stringify(effective.stats) };
  } catch (err) {
    deps.logger?.warn('[eval] diff capture failed at snapshot', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { diffText: null, diffStatsJson: null };
  }
}

/**
 * Fold any step_results (sprint-verify) rows into the gate snapshot JSON.
 * Best-effort — a read/serialize failure yields null (gates simply absent).
 */
function foldGateResultsJson(runId: string, deps: SnapshotDeps): string | null {
  try {
    const stepRows = deps.db
      .prepare('SELECT step_id, outcome, summary, error FROM step_results WHERE run_id = ?')
      .all(runId) as StepResultRow[];
    const gate = deriveGateResults(stepRows);
    return gate ? JSON.stringify(gate) : null;
  } catch (err) {
    deps.logger?.warn('[eval] gate-result fold failed at snapshot', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Snapshot a run for eval at the human-review trigger. Returns the outcome. NEVER
 * throws for a business reason — the only throws are programming errors the caller
 * (index.ts subscriber) still wraps in a swallowing .catch, so a snapshot failure
 * can never affect the run.
 */
export async function snapshotRunForEval(
  runId: string,
  deps: SnapshotDeps,
): Promise<SnapshotOutcome> {
  const { db, logger } = deps;
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  const run = resolveRunRow(db, runId);

  if (!run) {
    logger?.warn('[eval] snapshot skipped — no workflow_runs row', { runId });
    return 'skipped';
  }

  // Compound and verify-setup are eval-exempt BY NAME. Both carry a terminal
  // 'human-review' step (their "merge in changes" gate) that fires this trigger on
  // BOTH planes (the programmatic human gate and the orchestrated
  // cyboflow_report_step both emit the transition), and neither one's diff is rubric
  // material: compound's mines already-merged work, and verify-setup's is a
  // `.cyboflow/verify-runbook.json` plus at most a couple of isolation levers
  // (docs/proposals/verification-setup-flow.md §5.1 — "the setup flow must not be
  // rubric-graded"; grading it would tax every project that dares to configure
  // verification, for a diff whose real acceptance test is the proof run itself).
  // Skipping here — the single chokepoint covering path A (human-review step-begin)
  // AND the terminal A/B subscriber — means neither flow ever auto-grades regardless
  // of caller.
  if (run.workflowName === 'compound' || run.workflowName === 'verify-setup') {
    return 'skipped';
  }

  // Opt-in gate (A/B testing slice C widening): a built-in flow (name, not step id)
  // OR a variant/experiment-tagged run. Quick sessions and untagged custom flows
  // fall out here. The tag columns land in migration 048 — the row read above is
  // fail-soft (the surrounding caller swallows any throw), and on a pre-048 DB the
  // SELECT simply omits them (undefined → treated as null → not tagged).
  const tagged = run.experiment_id !== null || run.variant_id !== null;
  if (!isCyboflowWorkflowName(run.workflowName) && !tagged) {
    return 'skipped';
  }

  // For a TAGGED run, the "Auto-grade variant & experiment runs" sub-toggle
  // (default ON) gates the eval on TOP of eval_enabled/global — OFF means a
  // variant/experiment run is never auto-graded (prevents silent Opus spend from
  // merely activating variants). Untagged built-in runs never consult it. A
  // closure throw defaults to ON so a config-read fault never silently disables.
  if (tagged) {
    let autoGrade = true;
    try {
      autoGrade = deps.isVariantAutoGradeEnabled?.() ?? true;
    } catch {
      autoGrade = true;
    }
    if (!autoGrade) {
      logger?.info('[eval] snapshot skipped — auto-grade variant/experiment runs OFF', { runId });
      return 'skipped';
    }
  }

  // Eval on/off resolution (migration 044). Cheap + exception-safe — a skip here
  // must never write a run_evals row and must never throw. Order:
  //   per-run 0 → OFF (explicit per-run OFF wins over a global-ON setting)
  //   per-run 1 → ON  (explicit per-run ON  wins over a global-OFF setting)
  //   per-run NULL → follow the GLOBAL setting (default ON).
  // The isCyboflowWorkflowName gate above already ran, so a per-run ON does NOT
  // unlock quick/custom flows.
  if (run.eval_enabled === 0) {
    logger?.info('[eval] snapshot skipped — per-run override OFF', { runId });
    return 'skipped';
  }
  if (run.eval_enabled !== 1) {
    // NULL / undefined → consult the global toggle. A closure throw defaults to
    // enabled (the global default) so a config-read fault never silently disables.
    let globalEnabled = true;
    try {
      globalEnabled = deps.isEvalEnabled();
    } catch {
      globalEnabled = true;
    }
    if (!globalEnabled) {
      logger?.info('[eval] snapshot skipped — global code-review eval disabled', { runId });
      return 'skipped';
    }
  }

  // Re-fire dedup: if a row already exists, this is a request-changes loop / resume
  // re-report. Flip human_influenced=1 (first snapshot stays canonical) and stop.
  const existing = db
    .prepare('SELECT eval_status FROM run_evals WHERE run_id = ? AND rubric_version = ?')
    .get(runId, RUBRIC_VERSION) as { eval_status: string } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE run_evals SET human_influenced = 1, updated_at = ?
       WHERE run_id = ? AND rubric_version = ?`,
    ).run(nowIso, runId, RUBRIC_VERSION);
    return 'refire';
  }

  // Capture the frozen diff NOW (before any teardown races). Best-effort: a diff
  // failure must not block the snapshot — the worker can still fail-soft on an
  // empty diff.
  const { diffText, diffStatsJson } = await captureFrozenDiff(
    runId,
    run.worktree_path,
    run.base_sha ?? undefined,
    deps,
  );

  // Fold any step_results (sprint-verify) rows into the gate snapshot.
  const gateResultsJson = foldGateResultsJson(runId, deps);

  const promptHash = computeJudgePromptHash();

  // INSERT OR IGNORE gives re-fire dedup for free even against a race: if a
  // concurrent trigger inserted first, changes===0 and we flip human_influenced.
  //
  // `origin` (migration 090) is deliberately ABSENT from this column list: the
  // automatic trigger is the NULL origin (every legacy row is NULL too), and the
  // column defaults NULL. Do not add it here — "NULL means automatic" is the
  // contract the ad-hoc path's exists_auto guard reads.
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO run_evals (
         run_id, rubric_version, eval_status,
         base_sha, diff_text, diff_stats_json, gate_results_json,
         human_influenced, snapshot_at,
         prompt_hash, judge_build_id,
         workflow_id, workflow_name, spec_hash, run_model
       ) VALUES (?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      RUBRIC_VERSION,
      run.base_sha,
      diffText,
      diffStatsJson,
      gateResultsJson,
      nowIso,
      promptHash,
      deps.appVersion,
      run.workflow_id,
      run.workflowName,
      run.spec_hash,
      run.model,
    );

  if (result.changes === 0) {
    // Lost an insert race with a concurrent trigger — treat as re-fire.
    db.prepare(
      `UPDATE run_evals SET human_influenced = 1, updated_at = ?
       WHERE run_id = ? AND rubric_version = ?`,
    ).run(nowIso, runId, RUBRIC_VERSION);
    return 'refire';
  }

  deps.enqueue(runId, RUBRIC_VERSION);
  logger?.info('[eval] snapshot captured; eval enqueued', {
    runId,
    workflow: run.workflowName,
    hasDiff: diffText !== null,
  });
  return 'inserted';
}

/**
 * Resolve the base ref the AD-HOC capture diffs against.
 *
 * Why this exists: `workflow_runs.base_sha` is stamped by RunLauncher, so it is
 * populated for flow runs but NULL for a quick session's `__quick__` sentinel run
 * (createQuickSessionCore stamps worktree_path only). With no ref the injected
 * gitDiff closure falls back to a working-directory capture (`git diff` vs HEAD),
 * which HIDES everything already committed — and a session that commits as it goes
 * would ask for an eval of an empty diff. The session row carries the worktree's
 * base commit (`sessions.base_commit`, captured at worktree creation), so fall back
 * to it: `git diff <base_commit>` covers committed AND uncommitted work since base.
 *
 * Fail-soft: any read problem (no session link, pre-column DB, NULL base_commit)
 * returns undefined, which degrades to the working-directory capture rather than
 * failing the request.
 */
function resolveAdHocBaseRef(db: DatabaseLike, run: RunRow): string | undefined {
  if (typeof run.base_sha === 'string' && run.base_sha.length > 0) return run.base_sha;
  if (!run.session_id) return undefined;
  try {
    const row = db
      .prepare('SELECT base_commit AS baseCommit FROM sessions WHERE id = ?')
      .get(run.session_id) as { baseCommit?: unknown } | undefined;
    return typeof row?.baseCommit === 'string' && row.baseCommit.length > 0
      ? row.baseCommit
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * AD-HOC eval request (the `cyboflow_run_eval` MCP tool). Grades THIS session's
 * CURRENT working-tree diff on demand — the fire-and-continue twin of the automatic
 * human-review trigger above, and the only way a quick session (or a custom flow)
 * ever gets a rubric verdict.
 *
 * DELIBERATE BYPASSES — an explicit tool call is its own opt-in, and every gate
 * below governs AUTOMATIC grading only, so none of them is consulted here:
 *   - NO isCyboflowWorkflowName gate (the whole point is quick/custom sessions);
 *   - NO 'compound' exemption (a human asking to grade a compound diff may);
 *   - NO eval_enabled per-run override, NO global code-review-eval toggle, NO
 *     auto-grade-variant sub-toggle. Those settings mean "don't grade my runs
 *     behind my back", not "refuse when I ask".
 *
 * Decision table (each branch commented at its site):
 *   1. no workflow_runs row                     → rejected/run_not_found
 *   2. variant/experiment-TAGGED run            → rejected/tagged_run
 *   3. existing row, pending|running            → in_flight (no writes)
 *   4. existing row, terminal, origin='adhoc'   → delete + re-snapshot → requeued
 *   5. existing row, terminal, origin NULL      → rejected/exists_auto
 *   6. no row                                   → capture; empty → rejected/no_diff,
 *                                                 else insert(origin='adhoc') → queued
 *
 * Like snapshotRunForEval this never throws for a business reason; a DB/programming
 * fault still propagates to the caller (the MCP handler surfaces it as ok:false).
 */
export async function snapshotRunForAdHocEval(
  runId: string,
  deps: SnapshotDeps,
): Promise<AdHocSnapshotResult> {
  const { db, logger } = deps;
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  // (1) No run row — the caller's CYBOFLOW_RUN_ID does not resolve (deleted run,
  // or a runId that was never a workflow_runs id).
  const run = resolveRunRow(db, runId);
  if (!run) {
    logger?.warn('[eval] ad-hoc eval rejected — no workflow_runs row', { runId });
    return { outcome: 'rejected', reason: 'run_not_found' };
  }

  // (2) A/B-tagged runs are OFF LIMITS. A tagged run auto-grades at its terminal
  // status specifically so the two arms are scored under identical conditions; an
  // ad-hoc mid-session eval would occupy the arm's (run, rubric) PK slot and
  // pre-empt / replace its canonical score, silently distorting the comparison.
  if (run.experiment_id !== null || run.variant_id !== null) {
    logger?.info('[eval] ad-hoc eval rejected — variant/experiment-tagged run', { runId });
    return { outcome: 'rejected', reason: 'tagged_run' };
  }

  const existing = db
    .prepare('SELECT eval_status, origin FROM run_evals WHERE run_id = ? AND rubric_version = ?')
    .get(runId, RUBRIC_VERSION) as { eval_status?: unknown; origin?: unknown } | undefined;

  if (existing) {
    const status = typeof existing.eval_status === 'string' ? existing.eval_status : '';
    // (3) A grade is already in flight for this (run, rubric). Re-requesting must
    // not double-enqueue the jury (3 judge subprocesses per grade) nor clobber the
    // row the worker is mid-way through — report it and let it land.
    if (status === 'pending' || status === 'running') {
      return { outcome: 'in_flight', rubricVersion: RUBRIC_VERSION };
    }
    // (5) The existing terminal row is the run's CANONICAL automatic eval (origin
    // NULL — see migration 090). Insights + the score panel read it; destroying it
    // to re-grade a later diff would rewrite history. Reject instead.
    if (existing.origin !== EVAL_ORIGIN_ADHOC) {
      logger?.info('[eval] ad-hoc eval rejected — canonical automatic eval exists', { runId });
      return { outcome: 'rejected', reason: 'exists_auto' };
    }
    // (4) A terminal AD-HOC row is ours to replace: re-grading after more work is
    // exactly what the tool is for. Delete it here so the capture below can INSERT
    // a fresh row on the same PK (the composite PK admits only one row per rubric
    // version). The delete is deliberately AFTER the checks and BEFORE the capture
    // so a subsequent no_diff rejection leaves no stale verdict claiming to
    // describe the current tree.
    db.prepare('DELETE FROM run_evals WHERE run_id = ? AND rubric_version = ?').run(
      runId,
      RUBRIC_VERSION,
    );
  }
  const replacingAdHoc = existing !== undefined;

  // (6) Capture the diff. Unlike the auto path — which stores a null diff and lets
  // the worker fail soft, because its trigger is a step transition nobody is
  // waiting on — an EXPLICIT caller deserves an immediate, actionable error rather
  // than a pending row doomed to grade nothing.
  const adHocBaseRef = resolveAdHocBaseRef(db, run);
  const { diffText, diffStatsJson } = await captureFrozenDiff(
    runId,
    run.worktree_path,
    adHocBaseRef,
    deps,
  );
  if (diffText === null || diffText.trim().length === 0) {
    logger?.info('[eval] ad-hoc eval rejected — no diff to grade', { runId });
    return { outcome: 'rejected', reason: 'no_diff' };
  }

  const gateResultsJson = foldGateResultsJson(runId, deps);
  const promptHash = computeJudgePromptHash();

  // human_influenced = 1: an ad-hoc mid-session diff is BY DEFINITION not the
  // frozen pre-human snapshot the flag was invented to identify. It also keeps the
  // canonical-row selection in insightsQueries (ORDER BY human_influenced ASC)
  // preferring a later automatic row should one ever coexist.
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO run_evals (
         run_id, rubric_version, eval_status,
         base_sha, diff_text, diff_stats_json, gate_results_json,
         human_influenced, snapshot_at,
         prompt_hash, judge_build_id,
         workflow_id, workflow_name, spec_hash, run_model,
         origin
       ) VALUES (?, ?, 'pending', ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      RUBRIC_VERSION,
      // Stamp the ref the diff was ACTUALLY captured against (for a quick session
      // that is the session's base_commit, not the NULL run.base_sha) so the frozen
      // row's provenance matches its diff_text.
      adHocBaseRef ?? run.base_sha,
      diffText,
      diffStatsJson,
      gateResultsJson,
      nowIso,
      promptHash,
      deps.appVersion,
      run.workflow_id,
      run.workflowName,
      run.spec_hash,
      run.model,
      EVAL_ORIGIN_ADHOC,
    );

  if (inserted.changes === 0) {
    // Lost the PK to a concurrent request between the checks and the insert. The
    // winner's grade covers the same tree, so report it as in flight rather than
    // clobbering it.
    return { outcome: 'in_flight', rubricVersion: RUBRIC_VERSION };
  }

  deps.enqueue(runId, RUBRIC_VERSION);
  logger?.info('[eval] ad-hoc snapshot captured; eval enqueued', {
    runId,
    workflow: run.workflowName,
    replaced: replacingAdHoc,
  });
  return { outcome: replacingAdHoc ? 'requeued' : 'queued', rubricVersion: RUBRIC_VERSION };
}
