/**
 * Fan-out dispatch mode — HOW an orchestrated run executes a fan-out step's
 * inner chain.
 *
 * - `prose` — the orchestrator agent drives each lane itself via Agent-tool
 *   subagents, following the instruction block `fan-out-instructions.ts`
 *   renders. The pre-0.2.5 behavior, now the explicit opt-out.
 * - `workflow` — the orchestrator dispatches a BATCH of consecutive non-gated
 *   inner stages for ONE wave to a pre-installed Claude Code dynamic workflow
 *   (`.claude/workflows/cyboflow-*.js`, rendered by `fanOutStageScript.ts`),
 *   reads back structured per-item results, and performs every cyboflow write
 *   itself at the batch boundary.
 *
 *   LANE-MAJOR, not stage-major: the script runs
 *   `parallel(items.map(runItem))`, and each `runItem` walks its own item
 *   through the whole batch sequentially. Items run concurrently and no item
 *   waits on a sibling between stages — that absence of a per-stage barrier is
 *   where the speed comes from. The batch as a whole IS a barrier: it resolves
 *   only once every item has settled.
 *
 *   The chain is split at FIRM GATES (`FanOutInnerStep.firmGate`), which end a
 *   batch and stay with the orchestrator — that is how single-writer, the
 *   host-owned visual merge-gate, and live wave re-resolution all survive.
 *   `visual-verify` is the only firm gate in the built-in chains, and it is
 *   terminal there; `builtInFirmGatesAreTerminal.test.ts` pins that, because a
 *   MID-chain gate would fragment the chain into multiple batches and
 *   reintroduce a full cross-lane barrier at each split.
 *
 *   The deliberate trade: lane `current_step` does not tick per stage inside a
 *   batch. The script returns each item's full stage trail and the orchestrator
 *   backfills it when the batch returns. See `fanOutStageScript.ts` for the
 *   rendering contract and `FanOutInnerStep.firmGate` for the gate semantics.
 *
 * Lives in `shared/` rather than beside either AppConfig because BOTH the main
 * and frontend `AppConfig` declarations carry the field and must stay in parity
 * (docs/CODE-PATTERNS.md → IPC / type-parity rules).
 *
 * INTERACTIVE-ONLY in practice: the SDK substrate composes its prompt through
 * `workflowPromptReaderAdapter` and its spawn passes `prose` explicitly. The
 * install seam is substrate-shared, so the mode is threaded to it as an argument
 * rather than read from global config inside it — otherwise SDK worktrees would
 * accrue scripts nothing consumes.
 */

/** How a fan-out step's inner chain is executed. */
export type FanOutDispatch = 'prose' | 'workflow';

/**
 * The NEUTRAL library floor for callers that do not specify a mode.
 *
 * Deliberately still 'prose', and load-bearing: `workflowPromptReaderAdapter`
 * (the SDK prompt composer) calls `buildFanOutAppend(def)` with NO opts, while
 * `claudeCodeManager` installs the workflow bundle with 'prose' EXPLICITLY. If
 * this floor became 'workflow', the SDK orchestrator would be instructed to
 * dispatch to `.claude/workflows/cyboflow-*.js` scripts that were never written
 * to its worktree. The shipped-ON default belongs to the INTERACTIVE read
 * instead — see {@link INTERACTIVE_FAN_OUT_DISPATCH_DEFAULT}.
 */
export const DEFAULT_FAN_OUT_DISPATCH: FanOutDispatch = 'prose';

/**
 * The SHIPPED default for orchestrated INTERACTIVE runs — what
 * `ConfigManager.getFanOutDispatch()` floors to, so dispatch is ON unless a user
 * pins `fanOutDispatch: 'prose'` in config.json. Scoped to the interactive read
 * rather than the shared floor precisely so the SDK path above is unaffected.
 *
 * NOT gated on `agentPermissionMode`, deliberately. Dispatch is verified only
 * under 'auto'; under 'dontAsk' the CLI's own review gate prompts in a terminal
 * nobody watches. That is a defect in how cyboflow maps 'dontAsk' onto the CLI,
 * tracked separately — not something this default compensates for.
 */
export const INTERACTIVE_FAN_OUT_DISPATCH_DEFAULT: FanOutDispatch = 'workflow';

/** Runtime guard — config.json is user-editable, so reads are validated. */
export function isFanOutDispatch(value: unknown): value is FanOutDispatch {
  return value === 'prose' || value === 'workflow';
}
