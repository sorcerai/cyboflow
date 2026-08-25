/**
 * laneRewindHandler — business logic for the monitor's PER-LANE rewind power:
 * pull ONE live sprint fan-out lane back to an earlier step of its inner chain
 * while the run, the outer walk, and every sibling lane keep going.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * Why this exists next to rewindRunHandler rather than inside it
 * ───────────────────────────────────────────────────────────────────────────
 * The whole-run `rewind_to_step` is the only rewind the monitor had, and it is
 * deliberately heavy: it aborts the walk, purges the target-and-after
 * `step_results`, reopens the batch, resets failed lanes, flips the run row back
 * to 'starting', and re-drives the DAG from an OUTER step through the crash-safe
 * resume machinery. That is the right tool when earlier output was wrong and
 * later steps built on it — and the wrong tool for the case that motivated this
 * module: ONE sprint lane wedged on an inner step while its siblings are making
 * fine progress. Rewinding the run to un-stick one lane throws away every
 * sibling's in-flight work.
 *
 * A lane rewind is a fundamentally different operation, not a narrower one:
 *   - it mutates NOTHING durable — no run status, no `step_results`, no batch
 *     row, no lane row of its own (the controller's next lane write moves the
 *     pointer). Its entire effect is one entry in the run's in-memory
 *     `RunDirectives.laneRewinds`, consumed by the fan-out inner loop.
 *   - it targets an INNER step id (`implement`, `code-review`, …), which the
 *     run rewind explicitly refuses — the walk's resume machinery is
 *     OUTER-step-indexed (see index.ts's `validateRunStep` note).
 *   - it requires a LIVE fan-out. There is nothing to rewind into once the walk
 *     has left the fan-out step; that case IS the whole-run rewind.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * How the request reaches a lane that is not looking
 * ───────────────────────────────────────────────────────────────────────────
 * Recording the directive is necessary but not sufficient: the lane consults it
 * between inner steps, and a STUCK lane — the whole point — is by definition not
 * between inner steps. So this handler also INTERRUPTS the lane, choosing the
 * seam by what the lane is actually blocked on:
 *
 *   - mid-agent-turn ⇒ kill that lane's spawn. Fan-out lanes spawn under the
 *     per-lane key `${runId}:${taskId}` (workflowController's `ctx.spawnKey`),
 *     so the substrate facade can abort exactly one lane's process without
 *     touching its siblings or the run-level walk. The killed spawn surfaces to
 *     the controller as an ordinary `failed` step result (the RUN abort signal
 *     never fires), and the pending directive is what stops that failure from
 *     consuming a loopback attempt or failing the lane.
 *   - parked at the visual merge gate ⇒ fire the lane's UNPARK hook. A lane
 *     awaiting an async verification verdict has no process to kill; the
 *     controller registers `RunDirectives.laneInterrupts[itemId]` for the
 *     duration of the park, and `RunExecutor.requestLaneRewind` fires it.
 *   - idle between inner steps ⇒ nothing to interrupt; the loop-head consult
 *     picks the request up on its own.
 *
 * ORDERING INVARIANT: the directive is recorded BEFORE either interrupt fires.
 * A woken lane that finds an empty `laneRewinds` map reads its wake-up as a
 * genuine step failure — which, for the spawn-kill path, would fail the very lane
 * the operator was trying to rescue. `requestLaneRewind` bakes the record-then-
 * interrupt order into the executor; the spawn abort here happens strictly after
 * that call returns.
 *
 * FAIL-SOFT SPAWN ABORT: the abort is best-effort. A rejection (or a lane whose
 * spawn key is not live) is logged and the rewind still reports `delivered` —
 * the directive is already in place, so the lane honors it at its next consult
 * point instead of instantly. Refusing the whole action because a kill failed
 * would strand the operator with a stuck lane and no recourse.
 *
 * Standalone-typecheck invariant: reads through the narrow `DatabaseLike` surface
 * and pure shared types only — no 'electron' / 'better-sqlite3' / service import
 * (the substrate abort + the executor mutator arrive as injected seams), matching
 * rewindRunHandler / retryRunHandler.
 */
import type { DatabaseLike, LoggerLike } from './types';
import { resolveRunFanOutInner } from './laneChainResolution';
import { AWAITING_VERIFY_STEP, SPRINT_VISUAL_VERIFY_STEP } from '../../../shared/types/sprintBatch';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface LaneRewindDeps {
  db: DatabaseLike;
  /**
   * Record the lane-rewind directive and fire the lane's registered unpark hook
   * (RunExecutor.requestLaneRewind — which owns the record-then-interrupt order).
   * Validation is THIS module's job; the executor writes what it is told.
   */
  requestLaneRewind: (runId: string, itemId: string, stepId: string) => void;
  /**
   * Live spawn keys for the run (SubstrateDispatchFacade.listLiveSpawnKeys).
   * Consulted so a lane that is NOT mid-turn never reaches the abort seam — the
   * facade's untracked-panel fallback resolves a manager and kills by id, which
   * is needless work (and a warn) for an idle lane. Optional: absent ⇒ the abort
   * is skipped entirely and the directive lands at the lane's next consult.
   */
  listLiveSpawnKeys?: (runId: string) => readonly string[];
  /**
   * Kill ONE lane's in-flight agent process by its per-lane spawn key
   * (SubstrateDispatchFacade.abort). Fail-soft — see the header. Optional.
   */
  abortLaneSpawn?: (spawnKey: string) => Promise<void>;
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Reasons a lane rewind is refused without touching anything. */
export type LaneRewindNoOpReason =
  | 'not_found'
  | 'not_programmatic'
  | 'run_not_running'
  | 'no_fan_out'
  | 'unknown_task'
  | 'lane_not_found'
  | 'lane_not_live'
  | 'unknown_step'
  | 'target_not_prior';

export type LaneRewindResult =
  | {
      delivered: true;
      /** The resolved opaque task id of the rewound lane. */
      taskId: string;
      /** The lane's display ref (falls back to the task id). */
      ref: string;
      /** The inner step the lane will resume at. */
      stepId: string;
      /** The inner step the lane was on when the rewind was recorded, if known. */
      fromStepId: string | null;
      /** True when the lane's in-flight agent process was actually killed. */
      abortedSpawn: boolean;
    }
  | {
      noOp: true;
      reason: LaneRewindNoOpReason;
      /** The lane's current status — set for `lane_not_live` so callers can explain WHY. */
      laneStatus?: string;
    };

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface RunRow {
  status: string;
  execution_model: string | null;
  batch_id: string | null;
  project_id: number | null;
}

interface LaneRow {
  status: string;
  current_step_id: string | null;
  ref: string | null;
}

/**
 * Where the lane's persisted pointer sits in the inner chain, for the backward-
 * only guard. `awaiting-verify` is NOT a chain id — it is the park marker the
 * controller writes while a lane waits on the visual merge gate — so it resolves
 * to the `visual-verify` step it parks at (falling back to the end of the chain
 * for a custom chain with no such step). Returns -1 when the pointer is null or
 * unresolvable, which the caller treats as "no anchor ⇒ any target is allowed",
 * exactly as rewindRunHandler treats a null `current_step_id`.
 */
function laneChainIndex(inner: readonly { id: string }[], currentStepId: string | null): number {
  if (currentStepId === null) return -1;
  if (currentStepId === AWAITING_VERIFY_STEP) {
    const parkIdx = inner.findIndex((s) => s.id === SPRINT_VISUAL_VERIFY_STEP);
    return parkIdx >= 0 ? parkIdx : inner.length - 1;
  }
  return inner.findIndex((s) => s.id === currentStepId);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Rewind ONE live fan-out lane to an earlier step of its inner chain. See the
 * header for the record-then-interrupt ordering invariant, the two interrupt
 * seams, and why this is not a mode of `rewindRunHandler`.
 *
 * `taskRef` accepts the lane's opaque task id OR its project-scoped display ref
 * (`TASK-014`) — the same ref-or-id resolution `taskMutationHandler` and the
 * live-steer binding use, so the monitor can pass through whichever the operator
 * typed.
 */
export async function laneRewindHandler(
  runId: string,
  input: { taskRef: string; stepId: string },
  deps: LaneRewindDeps,
): Promise<LaneRewindResult> {
  const { db, requestLaneRewind, listLiveSpawnKeys, abortLaneSpawn, logger } = deps;

  // ── 1. The run must be a LIVE programmatic walk ───────────────────────────
  // A lane rewind edits in-memory fan-out state, so there must be a fan-out
  // running to edit. A failed / paused / resting run has no live lane loop; its
  // recovery paths are retry and the whole-run rewind.
  const run = db
    .prepare(
      `SELECT status, execution_model, batch_id, project_id
         FROM workflow_runs WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;
  if (!run) return { noOp: true, reason: 'not_found' };
  if (run.execution_model !== 'programmatic') return { noOp: true, reason: 'not_programmatic' };
  if (run.status !== 'running') return { noOp: true, reason: 'run_not_running' };
  if (run.batch_id === null) return { noOp: true, reason: 'no_fan_out' };

  // ── 2. Resolve the lane (ref-or-id) ───────────────────────────────────────
  const task = db
    .prepare('SELECT id FROM tasks WHERE id = ? OR (project_id = ? AND ref = ?)')
    .get(input.taskRef, run.project_id, input.taskRef) as { id: string } | undefined;
  if (!task) return { noOp: true, reason: 'unknown_task' };
  const lane = db
    .prepare(
      `SELECT bt.status, bt.current_step_id, t.ref AS ref
         FROM sprint_batch_tasks bt
         LEFT JOIN tasks t ON t.id = bt.task_id
        WHERE bt.batch_id = ? AND bt.task_id = ?`,
    )
    .get(run.batch_id, task.id) as LaneRow | undefined;
  if (!lane) return { noOp: true, reason: 'lane_not_found' };
  // Only a RUNNING lane is inside the inner loop that consumes the directive. A
  // queued lane has not started (it will run the chain from the top anyway); an
  // integrated/failed lane has SETTLED, and the wave loop never un-settles a lane
  // — re-driving one is the whole-run rewind's job, not this one.
  if (lane.status !== 'running') {
    return { noOp: true, reason: 'lane_not_live', laneStatus: lane.status };
  }

  // ── 3. Validate the target against the run's FROZEN lane vocabulary ───────
  // The same resolution the MCP lane write, the dispatch backstop, and the merge
  // gate use (laneChainResolution) — so a workflow whose fan-out chain was edited
  // validates against the chain this run is actually walking.
  const inner = resolveRunFanOutInner(db, runId);
  if (inner === null || inner.length === 0) return { noOp: true, reason: 'no_fan_out' };
  const targetIdx = inner.findIndex((s) => s.id === input.stepId);
  if (targetIdx < 0) return { noOp: true, reason: 'unknown_step' };
  // Backward-only, mirroring rewindRunHandler's directional guard: the target
  // must be at or before the lane's current step (`target === current` IS allowed
  // — "restart this step"). A null/unresolvable pointer leaves no anchor to be
  // prior to, so any valid target passes. The controller re-checks this against
  // its LIVE chain index, closing the window where the lane advanced in between.
  const currentIdx = laneChainIndex(inner, lane.current_step_id);
  if (currentIdx >= 0 && targetIdx > currentIdx) {
    return { noOp: true, reason: 'target_not_prior' };
  }

  // ── 4. Record FIRST (this also fires the merge-gate unpark hook) ──────────
  requestLaneRewind(runId, task.id, input.stepId);

  // ── 5. THEN interrupt a mid-agent-turn lane by killing its own spawn ──────
  // Strictly after the record above: a lane woken before the directive exists
  // reads the wake as a genuine failure. Fail-soft — the directive stands either
  // way, so a failed kill only delays the rewind to the lane's next consult.
  const spawnKey = `${runId}:${task.id}`;
  let abortedSpawn = false;
  if (abortLaneSpawn) {
    const live = listLiveSpawnKeys ? new Set(listLiveSpawnKeys(runId)) : undefined;
    if (live === undefined || live.has(spawnKey)) {
      try {
        await abortLaneSpawn(spawnKey);
        abortedSpawn = true;
      } catch (err) {
        logger?.warn('[laneRewind] lane spawn abort rejected — the directive still stands', {
          runId,
          spawnKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logger?.info('[laneRewind] recorded a lane rewind', {
    runId,
    taskId: task.id,
    stepId: input.stepId,
    fromStepId: lane.current_step_id,
    abortedSpawn,
  });

  return {
    delivered: true,
    taskId: task.id,
    ref: lane.ref ?? task.id,
    stepId: input.stepId,
    fromStepId: lane.current_step_id,
    abortedSpawn,
  };
}
