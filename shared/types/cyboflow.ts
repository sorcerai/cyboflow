// Row types for the Cyboflow orchestrator schema (migration 006).
// JSON columns are kept as `string` here — parsing/validation happens at
// the service boundary with the corresponding Zod schemas.

export type WorkflowRunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'awaiting_review'
  | 'stuck'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'awaiting_input'
  // Non-terminal. SDK-only: Pause stops the active turn but RETAINS
  // claude_session_id + current_step_id so Resume can re-drive via --resume.
  // Deliberately NOT in TERMINAL_RUN_STATUSES — a paused run still occupies its
  // session and must survive an app restart (boot recovery must not force-fail it).
  | 'paused';

/**
 * Terminal workflow_runs statuses — runs in these states cannot transition
 * further. Used by every cancel/finalize path that needs to reject re-entry.
 *
 * The SQL literal is derived from the array so a future status addition is
 * a single edit. Both `services/cyboflow/*` and `orchestrator/trpc/routers/*`
 * import from this module, so this constant is the canonical source.
 */
export const TERMINAL_RUN_STATUSES = ['canceled', 'failed', 'completed'] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export const TERMINAL_RUN_STATUSES_SQL_IN = `('${TERMINAL_RUN_STATUSES.join(
  "','",
)}')`;

/**
 * `workflow_runs.outcome` values that mean THE SESSION'S WORK WAS DELIVERED —
 * it reached the project's main line (or is on its way there via a pushed
 * branch) rather than being thrown away.
 *
 *   'merged'    — squash/rebase merged into main through our own merge path.
 *   'integrated'— the per-task close-out: merged into a sprint integration branch.
 *   'completed' — the work landed by a path we did not observe (the agent merged
 *                 it in chat, the user merged outside the app). Stamped ONLY by
 *                 the explicit "Mark complete" human action.
 *   'pr_open'   — the branch was pushed and a PR opened; delivery is in flight.
 *
 * This is the ONE predicate behind three behaviours that must never disagree:
 * the archive sweeps preserve a delivered session's FINDINGS (they describe code
 * that is now in the tree, so they still apply), and the Insights compounding
 * surface only offers findings whose work actually landed. A run outcome absent
 * from this list ('dismissed' / 'failed' / 'canceled' / 'interrupted') means the
 * work never landed, so its findings are a no-op and are swept.
 */
export const DELIVERED_RUN_OUTCOMES = ['merged', 'integrated', 'completed', 'pr_open'] as const;
export type DeliveredRunOutcome = (typeof DELIVERED_RUN_OUTCOMES)[number];
export const DELIVERED_RUN_OUTCOMES_SQL_IN = `('${DELIVERED_RUN_OUTCOMES.join(
  "','",
)}')`;

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timed_out';

/**
 * Live settle state for a session's accept actions (Merge / Create-PR),
 * computed in the main process AT READ TIME — never persisted, so it cannot go
 * stale the way `sessions.status` does (a flow session's perpetually-running
 * `__quick__` chat sentinel wedges that status at 'running' forever).
 *
 *  - `flowBusy`: the session has a workflow run actively driving
 *    (queued/starting/running), EXCLUDING `__quick__` sentinel runs — the chat
 *    vehicle is running by design and says nothing about the flow. Rest states
 *    (awaiting_review/awaiting_input/stuck/paused) do NOT count: merging while
 *    a run is parked at a gate is the user's call, exactly as before.
 *  - `chatTurnInFlight`: some chat on the session has an agent turn in flight
 *    RIGHT NOW (SubstrateDispatchFacade.hasTurnInFlightForSession — SDK managers
 *    answer from live turn state; interactive PTY from the ROB-5 submit→Stop-hook
 *    window).
 */
export interface SessionSettleState {
  flowBusy: boolean;
  chatTurnInFlight: boolean;
}

/**
 * Emitted on the global `runStatusEvents` emitter whenever the RunExecutor
 * drives a workflow_run through a lifecycle transition (running, awaiting_review
 * on clean drain, failed, canceled). This is the project-wide "run status
 * changed" signal that the rail/action-bar reactivity (`activeRunsStore`) was
 * previously missing — a clean-drain REST to awaiting_review creates no approval
 * row and so fired none of the approval/stuck events the store listened to,
 * leaving the action bar disabled on a finished run.
 */
export interface RunStatusChangedEvent {
  runId: string;
  status: WorkflowRunStatus;
}

export interface WorkflowRow {
  id: string;
  project_id: number;
  name: string;
  description: string | null;
  spec_json: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  project_id: number;
  worktree_path: string;
  status: WorkflowRunStatus;
  policy_json: string;
  stuck_at: string | null;
  stuck_reason: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface RawEventRow {
  id: number;
  run_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface MessageRow {
  id: string;
  run_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content_json: string;
  created_at: string;
}

export interface ApprovalRow {
  id: string;
  run_id: string;
  tool_name: string;
  tool_input_json: string;
  tool_use_id: string;
  rationale: string | null;
  status: ApprovalStatus;
  decided_at: string | null;
  decided_by: string | null;
  created_at: string;
}
