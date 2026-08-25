/**
 * ompGateTypes — the PINNED OMP (oh-my-pi) extension-API surface cyboflow's
 * gating extension depends on, plus cyboflow's own gate config / socket wire
 * types.
 *
 * We cannot import OMP's real types: the gate module is loaded INSIDE the
 * spawned `omp` process by Bun (`-e <path>`), and cyboflow has no dependency on
 * `@oh-my-pi/pi-coding-agent`. So this file re-declares the exact subset we
 * rely on, with the upstream evidence recorded inline. `ompGateContract.test.ts`
 * asserts our implementation against these declarations, so an OMP bump that
 * changes the shape fails a committed expectation rather than production.
 *
 * ---------------------------------------------------------------------------
 * Verified against oh-my-pi v17.3.3 (source snapshot, 2026-08-14). Paths below
 * are relative to `packages/coding-agent/src/` in the `can1357/oh-my-pi` tree.
 * ---------------------------------------------------------------------------
 *
 * (a) MODULE EXPORT SHAPE for a `-e` / `--hook` file
 *     `extensibility/extensions/loader.ts:55-59`
 *       type LoadedExtensionModule = ExtensionFactory | { default?: ExtensionFactory };
 *       const candidate = typeof module === "function" ? module : module.default;
 *     → a default-exported factory `(pi: ExtensionAPI) => void | Promise<void>`.
 *     `main.ts:1182-1189` merges `--extension` and `--hook` CLI paths into
 *     `additionalExtensionPaths`; `--no-extensions` only sets
 *     `disableExtensionDiscovery`, so an explicit `-e` path STILL loads (the
 *     lockdown posture the proposal depends on — docs/proposals §8.2).
 *     NOTE: `docs/hooks.md` documents the LEGACY hook subsystem
 *     (`extensibility/hooks/*`, `HookToolWrapper`). The live runtime is the
 *     EXTENSION runner (`docs/hooks.md:7-14`), which is what this file pins.
 *
 * (b) `tool_call` EVENT + RESULT
 *     `extensibility/extensions/types.ts:886-934` — ToolCallEventBase carries
 *     `{ type: 'tool_call'; toolCallId: string }`, each arm adds
 *     `toolName` + `input`; the open arm is
 *     `CustomToolCallEvent { toolName: string; input: Record<string, unknown> }`.
 *     `extensibility/shared-events.ts:310-321` — ToolCallEventResult is
 *     `{ block?: boolean; reason?: string; input?: Record<string, unknown> }`.
 *     Blocking = return `{ block: true, reason }`; rewriting = return `{ input }`
 *     (ignored when `block` is true).
 *     `extensibility/extensions/types.ts:1156` — handlers are
 *     `(event, ctx) => Promise<R | void> | R | void`.
 *
 * (c) A HANDLER THROW FAILS CLOSED
 *     `extensibility/extensions/runner.ts:1235-1270` — `emitToolCall` runs each
 *     handler through `#runHandlerWithTimeout` with an `onFailure` callback that
 *     synthesizes `{ block: true, reason }` for BOTH `'timeout'` and `'error'`;
 *     `runner.ts:1099` / `runner.ts:1109` return that value. A first `block`
 *     short-circuits the remaining handlers (`runner.ts:1262-1264`).
 *     Independently, on the non-loop dispatch path
 *     `extensibility/extensions/wrapper.ts:229-234` rethrows a handler error so
 *     execution stops. Both paths block. (`docs/extensions.md:480`:
 *     "`tool_call` errors block execution (fail-closed)".)
 *
 * (d) ORDERING — `tool_call` RUNS BEFORE THE APPROVAL PROMPT, AND A BLOCK
 *     SUPPRESSES THE PROMPT ENTIRELY.
 *     `extensibility/extensions/wrapper.ts:201-235` is step 1 ("Emit tool_call
 *     event first ... Doing this BEFORE the approval gate means approval (below)
 *     resolves against the input that actually executes"); the approval gate is
 *     step 2 at `wrapper.ts:237-339`, and the interactive prompt itself is
 *     `wrapper.ts:325` (`uiContext.select(prompt, ["Approve", "Deny"])`). A
 *     `{ block: true }` throws at `wrapper.ts:218-221`, BEFORE step 2 — so the
 *     prompt is never raised.
 *     MEASURED against omp v17.3.2: a session spawned `--approval-mode
 *     always-ask` with `bash` in `disallowedTools` blocked the model's bash
 *     call, surfaced our reason into the transcript verbatim, and raised ZERO
 *     `select`/`confirm` `extension_ui_request` frames (the only UI method seen
 *     was the unconditional `setWidget`). The block does suppress the prompt.
 *     For MODEL-ISSUED calls the event fires even earlier, in the agent loop:
 *     `session/agent-session.ts:3300-3333` (`#beforeToolCall`), whose own header
 *     says "before concurrency scheduling, `tool_execution_start`, and the
 *     wrapper's approval gate"; a block there returns a blocked tool result
 *     (`agent-session.ts:3324-3326`) and the wrapper's marker
 *     (`wrapper.ts:183`, `consumeToolCallEmitted`) stops a second emission.
 *
 * (e) OTHER EVENTS WE OBSERVE
 *     `session_start` and `session_shutdown` (`docs/extensions.md:228-236`,
 *     `extensibility/extensions/types.ts:1193`). The load sentinel is written
 *     even earlier than `session_start` — in the factory body itself, which runs
 *     at import time (`docs/extensions.md:38-44`, "Extensions are imported and
 *     their factory functions run").
 *
 * (f) THE 30-SECOND HANDLER CAP — LOAD-BEARING, SEE ompGateExtension.ts
 *     SUPERSEDED IN PART by omp 17.3.5, which made the cap the setting
 *     `extensionHandlers.toolCallTimeoutMs` (changelog: "Made extension
 *     tool-call timeouts configurable and paused them during user dialogs").
 *     Read at `runner.ts` as
 *     `O99(settings?.get('extensionHandlers.toolCallTimeoutMs') ?? 30000)`,
 *     where the validator accepts ANY positive finite number — there is no
 *     upper clamp — and falls back to 30000 for anything else. The paragraph
 *     below is still exactly right for 17.3.4 and earlier, which is why
 *     cyboflow gates the raise on the version
 *     (`supportsConfigurableHandlerTimeout`) rather than assuming it.
 *     `extensibility/extensions/runner.ts:84` `EXTENSION_HANDLER_TIMEOUT_MS = 30_000`,
 *     applied at `runner.ts:1237` and enforced by `raceHandlerWithTimeout`
 *     (`runner.ts:192-227`). The only mutator is `testSetExtensionHandlerTimeoutMs`
 *     (`runner.ts:91-93`), a test-only export with no production callsite and no
 *     env/settings override. A `tool_call` handler that has not resolved within
 *     30s is aborted and converted to `{ block: true, reason: 'Extension <path>
 *     timed out after 30000ms' }`.
 *
 * (g) MCP TOOL NAMING AS SEEN BY THE HOOK
 *     `mcp/tool-bridge.ts:335-358` (`createMCPToolName`): the name the hook sees
 *     is `mcp__<sanitizedServer>_<toolName>`, where each part is lowercased and
 *     `[^a-z_]+` is collapsed to `_`, and a redundant `<server>_` prefix on the
 *     tool name is stripped. cyboflow's server is named `cyboflow` and its tools
 *     are `cyboflow_*`, so `cyboflow_report_finding` arrives as
 *     `mcp__cyboflow_report_finding`.
 *
 * Standalone invariant: TYPES ONLY. This module must stay free of runtime
 * values so that `import type` from ompGateExtension.ts erases completely and
 * the emitted extension JS requires nothing but node builtins.
 */

// ---------------------------------------------------------------------------
// (a)-(e): the pinned OMP extension API subset
// ---------------------------------------------------------------------------

/**
 * The `tool_call` event payload. Modelled on OMP's `CustomToolCallEvent`
 * (types.ts:921-924), the open arm of the `ToolCallEvent` union — every
 * built-in arm is assignable to it, so this single shape covers them all.
 */
export interface OmpToolCallEvent {
  type: 'tool_call';
  /** Canonical (lowercased) tool name, e.g. `bash`, `write`, `mcp__cyboflow_report_finding`. */
  toolName: string;
  /** Provider-issued call id; unique per call within a turn. */
  toolCallId: string;
  /** The normalized argument view OMP presents to hooks. */
  input: Record<string, unknown>;
}

/**
 * What a `tool_call` handler may return (shared-events.ts:310-321).
 * `reason` is surfaced to the model as the blocked-tool error text.
 * We never return `input` — cyboflow's gate decides, it does not rewrite.
 */
export interface OmpToolCallEventResult {
  block?: boolean;
  reason?: string;
  input?: Record<string, unknown>;
}

/** Handler context. We rely on none of its members; declared for signature parity. */
export interface OmpExtensionContext {
  readonly cwd?: string;
  readonly hasUI?: boolean;
}

/** `ExtensionHandler<ToolCallEvent, ToolCallEventResult>` (types.ts:1156). */
export type OmpToolCallHandler = (
  event: OmpToolCallEvent,
  ctx: OmpExtensionContext,
) => Promise<OmpToolCallEventResult | void> | OmpToolCallEventResult | void;

/** Notification-only lifecycle handler (`session_start` / `session_shutdown`). */
export type OmpLifecycleHandler = (
  event: { type: string },
  ctx: OmpExtensionContext,
) => Promise<void> | void;

/**
 * The narrow slice of OMP's `ExtensionAPI` (types.ts:1168+) the gate uses.
 *
 * Deliberately minimal: every member declared here is a member we CALL, so the
 * contract test's assertions map 1:1 onto real dependencies. `setLabel` is
 * optional because it is cosmetic (the TUI extension label) and absent on the
 * headless paths.
 */
export interface OmpExtensionApi {
  on(event: 'tool_call', handler: OmpToolCallHandler): void;
  on(event: 'session_start' | 'session_shutdown', handler: OmpLifecycleHandler): void;
  setLabel?(label: string): void;
}

/** The default-export shape OMP's loader accepts (loader.ts:55-59). */
export type OmpExtensionFactory = (pi: OmpExtensionApi) => void;

// ---------------------------------------------------------------------------
// cyboflow's gate configuration (CYBOFLOW_OMP_GATE_CONFIG)
// ---------------------------------------------------------------------------

/**
 * The four cyboflow permission modes. Kept as a local literal union rather than
 * an import of `shared/types/workflows` — this module is compiled into a file
 * loaded by a foreign runtime and must not pull in cyboflow's type graph.
 */
export type OmpGatePermissionMode = 'default' | 'acceptEdits' | 'auto' | 'dontAsk';

/**
 * The JSON payload of `CYBOFLOW_OMP_GATE_CONFIG`, computed host-side by the
 * OMP SDK manager and injected into the spawned process env.
 *
 * Every list is a set of OMP tool names (lowercase canonical form) EXCEPT
 * `allowRules`, which carries cyboflow's `ToolName(specifier)` permission-rule
 * strings verbatim — see `parsePermissionRule` in ompGateExtension.ts for the
 * subset that is honored.
 */
export interface OmpGateConfig {
  permissionMode: OmpGatePermissionMode;
  /** Tools cyboflow refuses outright, in EVERY mode (including `dontAsk`). */
  disallowedTools: string[];
  /**
   * Read-safe tools cyboflow pre-cleared; auto-allowed in every gated mode —
   * UNLESS the call's arguments name a URI-scheme target, which disqualifies
   * every name-based shortcut (`hasUriSchemeTarget` in ompGateExtension.ts).
   */
  autoAllowTools: string[];
  /** cyboflow's edit-tool set; honored only in `acceptEdits` / `auto`, and subject to the same argument narrowing. */
  editTools: string[];
  /** Merged permission-rule allowlist; honored only in `auto`, and subject to the same argument narrowing. */
  allowRules: string[];
  /** Deny OMP's `task` subagent tool (hook scope inside subagents is unverified). */
  denyTaskTool: boolean;
  /**
   * The EXACT composed names of cyboflow's own MCP tools, as OMP presents them
   * to the hook (e.g. `mcp__cyboflow_report_finding` — see (g) above).
   *
   * THIS LIST IS THE WHOLE OF RULE 3. Membership is exact; there is no prefix
   * heuristic behind it. A `mcp__cyboflow_` prefix test would auto-allow a
   * FOREIGN server's tools, because OMP auto-imports the user's own MCP configs
   * and a server named `cyboflow-extra` sanitizes to `cyboflow_extra` (see (g)),
   * yielding `mcp__cyboflow_extra_*`.
   *
   * Optional so an older manager that does not compute the list still works.
   * Absent, empty, or malformed means NO MCP tool is auto-allowed — MCP calls
   * fall through to the human gate like any other undecidable tool.
   */
  cyboflowMcpToolNames?: string[];
  /**
   * How long the gate may block waiting for a human verdict, in ms.
   *
   * Present only when the host has RAISED OMP's own extension-handler cap for
   * this spawn (`ompHandlerTimeoutOverlay.ts`); the two numbers are computed
   * together so the gate always gives up before OMP does and the model sees
   * cyboflow's reason rather than OMP's generic timeout text.
   *
   * Optional, and the fallback matters: absent, malformed, or non-positive
   * means the gate keeps its built-in ~25s budget, which is the only correct
   * behavior against an OMP that still hard-caps handlers at 30s. A config
   * that claims a longer budget than the runtime allows would lose the gate's
   * own error text and strand the socket, so this field is trusted ONLY as
   * written by a host that also wrote the matching overlay.
   */
  humanDecisionBudgetMs?: number;
}

// ---------------------------------------------------------------------------
// Orchestrator socket wire types (CYBOFLOW_ORCH_SOCKET)
// ---------------------------------------------------------------------------

/**
 * The approval request, byte-identical to the interactive-Claude shell hook's
 * (`main/src/orchestrator/shellHooks/preToolUseShellHook.ts:179`) and to the
 * server's declared message arm
 * (`main/src/orchestrator/mcpServer/mcpQueryHandler.ts:854-860`). Newline-
 * delimited JSON on a Unix stream socket.
 */
export interface OmpGateApprovalRequest {
  type: 'shell-approval-request';
  requestId: string;
  runId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /**
   * Which substrate is asking. Present ONLY on this lane; the interactive-Claude
   * hook omits it and keeps the original semantics.
   *
   * The server branches the SOCKET-DIED disposition on it. For the interactive
   * hook a dead socket means the subprocess died and nothing will ever read the
   * verdict, so the approval is settled. For this gate it means OMP's 30s
   * extension-handler cap forced us to stop waiting — the human has simply not
   * answered yet — so the approval stays pending and a retry re-attaches to it.
   */
  substrate?: 'omp';
}

/**
 * The verdict frame the orchestrator writes back
 * (`mcpQueryHandler.ts:5477-5492`, `writeShellVerdict`). Correlated by
 * `requestId`; the decision lives under `data`.
 */
export interface OmpGateApprovalResponse {
  type: 'mcp-query-response';
  requestId: string;
  ok: boolean;
  data?: {
    permissionDecision?: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}

/** The sentinel JSON the extension stamps at load (CYBOFLOW_OMP_GATE_SENTINEL). */
export interface OmpGateSentinel {
  loadedAt: string;
  runId: string;
  pid: number;
}
