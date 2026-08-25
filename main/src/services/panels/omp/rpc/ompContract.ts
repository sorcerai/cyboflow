/**
 * ompContract — the WIRE contract for OMP's `omp --mode rpc` stdio protocol.
 *
 * OMP (oh-my-pi) is embedded by spawning `omp --mode rpc` and speaking NDJSON
 * over stdin/stdout. This module owns the protocol constants, the typed command
 * / response / event unions, and the normalization that turns a raw wire frame
 * into one of those unions.
 *
 * Two shapes of ground truth back every declaration here:
 *   - a live probe of the real `omp` binary (v17.3.2), whose captured frames are
 *     committed under `__fixtures__/` and pinned by `__tests__/ompRpcContract.test.ts`;
 *   - OMP's own `docs/rpc.md` + `packages/**` sources, cited inline as
 *     `rpc.md:<line>` / `<file>:<line>` for every shape the probe did not capture.
 * Where the two disagreed, the captured frame won.
 *
 * NORMALIZATION PHILOSOPHY (mirrors the Codex app-server layer): model the
 * frames cyboflow actually reads as strict discriminated unions, and funnel
 * everything else into ONE explicit `__unknown__` variant rather than widening a
 * discriminant to `string`. A widened discriminant would poison narrowing at
 * every consumer; the sentinel keeps `switch` exhaustive while guaranteeing an
 * unrecognized frame is carried, never thrown on. `__unknown__` follows the
 * existing repo spelling for a fail-soft variant (`TypedEventNarrowing` narrows
 * unmodeled SDK messages to `{kind:'__unknown__'}`).
 */

// ---------------------------------------------------------------------------
// Protocol constants.
// ---------------------------------------------------------------------------

/**
 * The protocol version cyboflow requires. The ready frame advertises
 * `protocolVersion: 1` and `supportedProtocolVersions: [1, 2]`; a server whose
 * supported set excludes 1 is refused at the handshake (proposal §3.4).
 */
export const OMP_RPC_PROTOCOL_VERSION = 1;

/** The opt-in lossless framing version, negotiated via `negotiate_protocol` (rpc.md:48-52). */
export const OMP_RPC_PROTOCOL_VERSION_V2 = 2;

/** Max UTF-8 bytes of one physical NDJSON frame, including the newline (rpc-frame.ts:6). */
export const OMP_MAX_FRAME_BYTES = 1024 * 1024;

/** Max UTF-8 bytes of one logical frame reassembled from v2 chunks (rpc-frame.ts:8). */
export const OMP_MAX_REASSEMBLED_FRAME_BYTES = 64 * 1024 * 1024;

/** Payload bytes OMP puts in each v2 chunk before base64 (rpc-frame.ts:10). */
export const OMP_RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

/** The argv prefix that puts `omp` into RPC mode (rpc.md:19). */
export const OMP_RPC_MODE_ARGS = ['--mode', 'rpc'] as const;

/**
 * The argv prefix for the UI-BEARING RPC mode — the same NDJSON protocol, plus
 * OMP's own dialogs delivered as `extension_ui_request` frames the host answers
 * (README.md:541).
 *
 * LOAD-BEARING for any session that runs tools under an approval mode below
 * `yolo`, and the reason is not cosmetic. `--mode rpc` leaves the tool layer's
 * UI context unset (`main.ts:1765` passes `setToolUIContext` only for `rpc-ui`)
 * and `sessionOptions.hasUI = isInteractive || mode === "rpc-ui"` (`main.ts:1570`)
 * therefore resolves FALSE. `always-ask` caps auto-approval at the `read` tier
 * (`tools/approval.ts:36-40`, `APPROVAL_MODE_MAX_TIER`), so every write/exec-tier
 * call resolves `policy: 'prompt'` — and with no UI the wrapper does not prompt,
 * it THROWS `Tool "<name>" requires approval but no interactive UI available`
 * (`extensibility/extensions/wrapper.ts:308-317`). A plain-`rpc` always-ask
 * session can therefore only ever read. Under `rpc-ui` the same call raises
 * `select("Allow tool: …", ["Approve","Deny"])` (`wrapper.ts:325`) over RPC,
 * which is exactly what `ompApprovalBridge` answers.
 */
export const OMP_RPC_UI_MODE_ARGS = ['--mode', 'rpc-ui'] as const;

/**
 * The sentinel discriminant for a frame/block/message shape this contract does
 * not model. Never produced by OMP itself, so it cannot collide.
 */
export const OMP_UNKNOWN = '__unknown__';

/** Thinking levels `set_thinking_level` accepts (rpc.md:144, rpc.md:251). */
export const OMP_THINKING_LEVELS = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type OmpThinkingLevel = (typeof OMP_THINKING_LEVELS)[number];

/** Queue policy for a `prompt` issued while the session is already streaming (rpc.md:113, 559-564). */
export type OmpStreamingBehavior = 'steer' | 'followUp';

// ---------------------------------------------------------------------------
// Message content blocks.
//
// OMP's blocks are Claude-shaped but NOT Claude-named: thinking carries its text
// under `thinking` (not `text`), and a tool call carries `arguments` (not
// `input`). Sources: packages/ai/src/types.ts:686 (TextContent), :692
// (ThinkingContent), :699 (RedactedThinkingContent), :740 (ImageContent), :796
// (ToolCall), and the assistant `content` array captured by the probe.
// ---------------------------------------------------------------------------

export interface OmpTextContent {
  readonly type: 'text';
  readonly text: string;
}

export interface OmpThinkingContent {
  readonly type: 'thinking';
  readonly thinking: string;
}

export interface OmpRedactedThinkingContent {
  readonly type: 'redactedThinking';
  readonly data: string;
}

export interface OmpImageContent {
  readonly type: 'image';
  readonly mimeType: string;
}

export interface OmpToolCallContent {
  readonly type: 'toolCall';
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * Any content block this contract does not model — OMP also emits `fallback`
 * (packages/ai/src/types.ts:717) and Anthropic server-tool blocks, and may add
 * more. Carried verbatim so a projector can surface it instead of dropping it.
 */
export interface OmpUnknownContent {
  readonly type: typeof OMP_UNKNOWN;
  readonly block: Record<string, unknown>;
}

export type OmpContentBlock =
  | OmpTextContent
  | OmpThinkingContent
  | OmpRedactedThinkingContent
  | OmpImageContent
  | OmpToolCallContent
  | OmpUnknownContent;

// ---------------------------------------------------------------------------
// Usage.
//
// Probe-verified per-assistant-message shape. `input`/`output`/`cacheRead`/
// `cacheWrite` are DISJOINT (3 + 4 + 0 + 23316 === totalTokens 23323), unlike
// Codex's `inputTokens`, which is inclusive of its cached count — so the
// accumulator maps them straight across with no subtraction.
// ---------------------------------------------------------------------------

export interface OmpUsageCost {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

export interface OmpUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost?: OmpUsageCost;
}

// ---------------------------------------------------------------------------
// Messages.
// ---------------------------------------------------------------------------

export interface OmpUserMessage {
  readonly role: 'user';
  readonly content: readonly OmpContentBlock[];
  readonly attribution?: string;
  readonly timestamp?: number;
}

export interface OmpAssistantMessage {
  readonly role: 'assistant';
  readonly content: readonly OmpContentBlock[];
  readonly model?: string;
  readonly provider?: string;
  readonly api?: string;
  readonly usage?: OmpUsage;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly responseId?: string;
  readonly timestamp?: number;
}

/** packages/ai/src/types.ts:941 — a tool result is its own message role in OMP. */
export interface OmpToolResultMessage {
  readonly role: 'toolResult';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: readonly OmpContentBlock[];
  readonly isError: boolean;
  readonly timestamp?: number;
}

/** A message whose `role` this contract does not model (e.g. `developer`). */
export interface OmpUnknownMessage {
  readonly role: typeof OMP_UNKNOWN;
  readonly message: Record<string, unknown>;
}

export type OmpMessage =
  | OmpUserMessage
  | OmpAssistantMessage
  | OmpToolResultMessage
  | OmpUnknownMessage;

// ---------------------------------------------------------------------------
// Transport frames.
// ---------------------------------------------------------------------------

/** The first frame on stdout (rpc.md:38-46); probe-verified verbatim. */
export interface OmpReadyFrame {
  readonly type: 'ready';
  readonly protocolVersion: number;
  readonly supportedProtocolVersions: readonly number[];
  readonly maxFrameBytes: number;
  readonly maxReassembledFrameBytes: number;
}

/** One physical slice of an oversized logical frame under protocol v2 (rpc.md:56-65). */
export interface OmpRpcChunkFrame {
  readonly type: 'rpc_chunk';
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: string;
}

/**
 * A command response (rpc.md:204-205).
 *
 * `id` is OPTIONAL on the wire even when the request carried one: an unknown
 * command answers with `id` ABSENT (rpc-mode.ts:1447, live-verified), and a
 * parse failure answers `command: "parse"` with no id (rpc-mode.ts:383). Both
 * are correlation hazards the client resolves by command name — see
 * `ompRpcClient`.
 */
export interface OmpRpcResponseSuccess {
  readonly type: 'response';
  readonly id?: string;
  readonly command: string;
  readonly success: true;
  readonly data?: unknown;
}

export interface OmpRpcResponseFailure {
  readonly type: 'response';
  readonly id?: string;
  readonly command: string;
  readonly success: false;
  readonly error: string;
  readonly code?: string;
}

export type OmpRpcResponse = OmpRpcResponseSuccess | OmpRpcResponseFailure;

// ---------------------------------------------------------------------------
// Commands (stdin).
//
// The command NAME IS the `type` field — probe-verified. A wrapped
// `{type:'command', command:...}` envelope is rejected with
// "Unknown command: command".
// ---------------------------------------------------------------------------

export type OmpRpcCommand =
  // Prompting (rpc.md:113-118)
  | { readonly type: 'prompt'; readonly id?: string; readonly message: string;
      readonly streamingBehavior?: OmpStreamingBehavior }
  | { readonly type: 'steer'; readonly id?: string; readonly message: string }
  | { readonly type: 'follow_up'; readonly id?: string; readonly message: string }
  | { readonly type: 'abort'; readonly id?: string }
  | { readonly type: 'new_session'; readonly id?: string; readonly parentSession?: string }
  // Protocol (rpc.md:122)
  | { readonly type: 'negotiate_protocol'; readonly id?: string; readonly protocolVersion: number }
  // State (rpc.md:126)
  | { readonly type: 'get_state'; readonly id?: string }
  // Model (rpc.md:138-140) — set_model takes provider + modelId SEPARATELY,
  // not one `provider/model` string.
  | { readonly type: 'set_model'; readonly id?: string; readonly provider: string;
      readonly modelId: string }
  | { readonly type: 'get_available_models'; readonly id?: string }
  // Thinking (rpc.md:144)
  | { readonly type: 'set_thinking_level'; readonly id?: string; readonly level: OmpThinkingLevel }
  // Session (rpc.md:177-182)
  | { readonly type: 'get_session_stats'; readonly id?: string }
  | { readonly type: 'switch_session'; readonly id?: string; readonly sessionPath: string }
  | { readonly type: 'get_last_assistant_text'; readonly id?: string };

export type OmpRpcCommandType = OmpRpcCommand['type'];

// ---------------------------------------------------------------------------
// Command response payloads.
// ---------------------------------------------------------------------------

/** One row of `get_available_models` (rpc-types.ts:273). Probe-verified: `id` is
 *  BARE and the OMP-side provider is a separate field, so cyboflow's canonical
 *  `<provider>/<id>` form is composed at the catalog projection, not here. */
export interface OmpModel {
  readonly id: string;
  readonly name?: string;
  readonly api?: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface OmpAvailableModels {
  readonly models: readonly OmpModel[];
}

/** `get_state` payload (rpc.md:248-292). Everything but `model` is optional
 *  because `--no-session` omits `sessionFile`/`sessionName` outright (probe). */
export interface OmpSessionState {
  readonly model?: OmpModel;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly isCompacting?: boolean;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly messageCount?: number;
  readonly queuedMessageCount?: number;
}

/**
 * `get_session_stats` payload (rpc-types.ts:306). CUMULATIVE for the whole
 * session — never the basis for a per-turn number. `cost` is a FLAT rollup here,
 * unlike the per-message `usage.cost` breakdown.
 */
export interface OmpSessionStats {
  readonly sessionId?: string;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly totalMessages: number;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost: number;
}

/** `prompt` ack payload (rpc.md:213-223). `agentInvoked: false` means the prompt
 *  resolved locally and NO agent turn (and so no `agent_end`) will follow. */
export interface OmpPromptAck {
  readonly agentInvoked?: boolean;
}

/** `get_last_assistant_text` payload. The probe returned `{}` on an empty
 *  session — the `text` key is ABSENT, not `null` as rpc.md:320 implies. */
export interface OmpLastAssistantText {
  readonly text?: string | null;
}

// ---------------------------------------------------------------------------
// Events (stdout).
// ---------------------------------------------------------------------------

export interface OmpAgentStartEvent {
  readonly type: 'agent_start';
}

export interface OmpTurnStartEvent {
  readonly type: 'turn_start';
}

export interface OmpTurnEndEvent {
  readonly type: 'turn_end';
  readonly message?: OmpMessage;
}

export interface OmpMessageStartEvent {
  readonly type: 'message_start';
  readonly message: OmpMessage;
}

/** Streaming deltas (packages/ai/src/types.ts:1243-1265). cyboflow drops these
 *  in v1 (codex-parity refetch model, proposal §5.1), so only the discriminant
 *  is modeled. */
export interface OmpMessageUpdateEvent {
  readonly type: 'message_update';
  readonly assistantMessageEvent?: { readonly type: string };
}

export interface OmpMessageEndEvent {
  readonly type: 'message_end';
  readonly message: OmpMessage;
}

/**
 * Run completion (rpc.md:502-515).
 *
 * `isTerminal: false` means maintenance or async delivery scheduled more work
 * and the session will resume, so a turn ends only at `isTerminal !== false`.
 * The field is optional because older runtimes omit it and must stay
 * terminal-compatible; the live v17.3.2 RPC path always stamps it explicitly
 * (agent-session.ts:2739 `isTerminal: !options?.willContinue`).
 */
export interface OmpAgentEndEvent {
  readonly type: 'agent_end';
  readonly messages?: readonly OmpMessage[];
  readonly isTerminal?: boolean;
}

/** packages/agent/src/types.ts:883-885. */
export interface OmpToolExecutionStartEvent {
  readonly type: 'tool_execution_start';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly intent?: string;
}

export interface OmpToolExecutionUpdateEvent {
  readonly type: 'tool_execution_update';
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface OmpToolExecutionEndEvent {
  readonly type: 'tool_execution_end';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly result?: unknown;
  readonly isError?: boolean;
}

/** rpc.md:80, 517-522. Large and frequent; transport-level, never projected. */
export interface OmpAvailableCommandsUpdateEvent {
  readonly type: 'available_commands_update';
  readonly commands: readonly Record<string, unknown>[];
}

/**
 * rpc.md:589-594. Arrives even under `--no-extensions` (built-ins emit
 * `setWidget`), so it MUST be tolerated. Blocking kinds (`select`, `confirm`,
 * `input`, `editor`) expect an {@link OmpExtensionUiResponse}; answering them is
 * `ompApprovalBridge` / `ompQuestionBridge`'s job, not this transport's.
 *
 * `title` / `message` / `options` are the three payload fields the bridge reads:
 * `select` carries `title` + `options` (rpc-types.ts:373), `confirm` carries
 * `title` + `message` (:374), `input`/`editor` carry `title` (:375-390). Every
 * one is optional because the same discriminant also covers the fire-and-forget
 * methods (`notify`, `setStatus`, `setWidget`, …) that carry none of them.
 */
export interface OmpExtensionUiRequestEvent {
  readonly type: 'extension_ui_request';
  readonly id: string;
  readonly method: string;
  readonly title?: string;
  readonly message?: string;
  readonly options?: readonly string[];
}

/**
 * The host's answer to a BLOCKING `extension_ui_request` (rpc.md:617-621,
 * rpc-types.ts:535-538).
 *
 * NOT a command: OMP dispatches this as a side-channel control frame
 * (`dispatchRpcControlFrame`, rpc-mode.ts:278-284) and never writes a `response`
 * frame back, which is why {@link OmpRpcClient.respondToExtensionUi} writes it
 * directly instead of going through `send`.
 */
export type OmpExtensionUiResponse =
  | { readonly type: 'extension_ui_response'; readonly id: string; readonly value: string }
  | { readonly type: 'extension_ui_response'; readonly id: string; readonly confirmed: boolean }
  | {
      readonly type: 'extension_ui_response';
      readonly id: string;
      readonly cancelled: true;
      readonly timedOut?: boolean;
    };

/** rpc.md:79, 491-498. */
export interface OmpExtensionErrorEvent {
  readonly type: 'extension_error';
  readonly extensionPath?: string;
  readonly error?: string;
}

/** rpc.md:225-229 — a prompt accepted immediately that later resolves as
 *  local-only, i.e. a turn that will never produce `agent_end`. */
export interface OmpPromptResultEvent {
  readonly type: 'prompt_result';
  readonly id?: string;
  readonly agentInvoked: boolean;
}

/** Any stdout frame this contract does not model, carried verbatim. */
export interface OmpUnknownEvent {
  readonly type: typeof OMP_UNKNOWN;
  readonly frame: Record<string, unknown>;
}

export type OmpRpcEvent =
  | OmpAgentStartEvent
  | OmpTurnStartEvent
  | OmpTurnEndEvent
  | OmpMessageStartEvent
  | OmpMessageUpdateEvent
  | OmpMessageEndEvent
  | OmpAgentEndEvent
  | OmpToolExecutionStartEvent
  | OmpToolExecutionUpdateEvent
  | OmpToolExecutionEndEvent
  | OmpAvailableCommandsUpdateEvent
  | OmpExtensionUiRequestEvent
  | OmpExtensionErrorEvent
  | OmpPromptResultEvent
  | OmpUnknownEvent;

// ---------------------------------------------------------------------------
// Frame classification + normalization.
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function isOmpReadyFrame(value: unknown): value is OmpReadyFrame {
  return isRecord(value)
    && value.type === 'ready'
    && typeof value.protocolVersion === 'number'
    && Array.isArray(value.supportedProtocolVersions)
    && value.supportedProtocolVersions.every((entry) => typeof entry === 'number');
}

export function isOmpRpcChunkFrame(value: unknown): value is OmpRpcChunkFrame {
  return isRecord(value) && value.type === 'rpc_chunk';
}

export function isOmpRpcResponse(value: unknown): value is OmpRpcResponse {
  if (!isRecord(value) || value.type !== 'response') return false;
  if (typeof value.command !== 'string') return false;
  if (typeof value.success !== 'boolean') return false;
  return value.success || typeof value.error === 'string';
}

function normalizeContentBlock(value: unknown): OmpContentBlock {
  if (!isRecord(value)) return { type: OMP_UNKNOWN, block: {} };
  switch (value.type) {
    case 'text':
      if (typeof value.text === 'string') return { type: 'text', text: value.text };
      break;
    case 'thinking':
      if (typeof value.thinking === 'string') return { type: 'thinking', thinking: value.thinking };
      break;
    case 'redactedThinking':
      if (typeof value.data === 'string') return { type: 'redactedThinking', data: value.data };
      break;
    case 'image':
      if (typeof value.mimeType === 'string') return { type: 'image', mimeType: value.mimeType };
      break;
    case 'toolCall':
      if (typeof value.id === 'string' && typeof value.name === 'string') {
        return {
          type: 'toolCall',
          id: value.id,
          name: value.name,
          arguments: isRecord(value.arguments) ? value.arguments : {},
        };
      }
      break;
    default:
      break;
  }
  return { type: OMP_UNKNOWN, block: value };
}

function normalizeContent(value: unknown): readonly OmpContentBlock[] {
  // OMP's user/developer messages allow a bare string `content`
  // (packages/ai/src/types.ts:834); normalize it to a single text block.
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return [];
  return value.map(normalizeContentBlock);
}

function normalizeUsage(value: unknown): OmpUsage | undefined {
  if (!isRecord(value)) return undefined;
  const cost = isRecord(value.cost)
    ? {
        input: finiteNumber(value.cost.input),
        output: finiteNumber(value.cost.output),
        cacheRead: finiteNumber(value.cost.cacheRead),
        cacheWrite: finiteNumber(value.cost.cacheWrite),
        total: finiteNumber(value.cost.total),
      }
    : undefined;
  return {
    input: finiteNumber(value.input),
    output: finiteNumber(value.output),
    cacheRead: finiteNumber(value.cacheRead),
    cacheWrite: finiteNumber(value.cacheWrite),
    totalTokens: finiteNumber(value.totalTokens),
    ...(cost !== undefined ? { cost } : {}),
  };
}

export function normalizeOmpMessage(value: unknown): OmpMessage {
  if (!isRecord(value)) return { role: OMP_UNKNOWN, message: {} };
  switch (value.role) {
    case 'user':
      return {
        role: 'user',
        content: normalizeContent(value.content),
        ...(optionalString(value.attribution) !== undefined
          ? { attribution: optionalString(value.attribution) }
          : {}),
        ...(optionalNumber(value.timestamp) !== undefined
          ? { timestamp: optionalNumber(value.timestamp) }
          : {}),
      };
    case 'assistant': {
      const usage = normalizeUsage(value.usage);
      return {
        role: 'assistant',
        content: normalizeContent(value.content),
        ...(optionalString(value.model) !== undefined ? { model: optionalString(value.model) } : {}),
        ...(optionalString(value.provider) !== undefined
          ? { provider: optionalString(value.provider) }
          : {}),
        ...(optionalString(value.api) !== undefined ? { api: optionalString(value.api) } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(optionalString(value.stopReason) !== undefined
          ? { stopReason: optionalString(value.stopReason) }
          : {}),
        ...(optionalString(value.errorMessage) !== undefined
          ? { errorMessage: optionalString(value.errorMessage) }
          : {}),
        ...(optionalString(value.responseId) !== undefined
          ? { responseId: optionalString(value.responseId) }
          : {}),
        ...(optionalNumber(value.timestamp) !== undefined
          ? { timestamp: optionalNumber(value.timestamp) }
          : {}),
      };
    }
    case 'toolResult':
      if (typeof value.toolCallId === 'string' && typeof value.toolName === 'string') {
        return {
          role: 'toolResult',
          toolCallId: value.toolCallId,
          toolName: value.toolName,
          content: normalizeContent(value.content),
          isError: value.isError === true,
          ...(optionalNumber(value.timestamp) !== undefined
            ? { timestamp: optionalNumber(value.timestamp) }
            : {}),
        };
      }
      break;
    default:
      break;
  }
  return { role: OMP_UNKNOWN, message: value };
}

function normalizeMessages(value: unknown): readonly OmpMessage[] | undefined {
  return Array.isArray(value) ? value.map(normalizeOmpMessage) : undefined;
}

/**
 * Turn a raw stdout frame into a typed event. Never throws and never returns
 * `undefined`: an unrecognized or malformed frame becomes `OmpUnknownEvent`, so
 * the unsolicited `available_commands_update` / `extension_ui_request` traffic
 * (and anything a future OMP adds) flows through instead of killing the stream.
 */
export function normalizeOmpEvent(frame: Record<string, unknown>): OmpRpcEvent {
  switch (frame.type) {
    case 'agent_start':
      return { type: 'agent_start' };
    case 'turn_start':
      return { type: 'turn_start' };
    case 'turn_end':
      return {
        type: 'turn_end',
        ...(frame.message !== undefined ? { message: normalizeOmpMessage(frame.message) } : {}),
      };
    case 'message_start':
      return { type: 'message_start', message: normalizeOmpMessage(frame.message) };
    case 'message_update': {
      const inner = frame.assistantMessageEvent;
      return {
        type: 'message_update',
        ...(isRecord(inner) && typeof inner.type === 'string'
          ? { assistantMessageEvent: { type: inner.type } }
          : {}),
      };
    }
    case 'message_end':
      return { type: 'message_end', message: normalizeOmpMessage(frame.message) };
    case 'agent_end': {
      const messages = normalizeMessages(frame.messages);
      return {
        type: 'agent_end',
        ...(messages !== undefined ? { messages } : {}),
        ...(typeof frame.isTerminal === 'boolean' ? { isTerminal: frame.isTerminal } : {}),
      };
    }
    case 'tool_execution_start':
      if (typeof frame.toolCallId === 'string' && typeof frame.toolName === 'string') {
        return {
          type: 'tool_execution_start',
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          ...(frame.args !== undefined ? { args: frame.args } : {}),
          ...(optionalString(frame.intent) !== undefined
            ? { intent: optionalString(frame.intent) }
            : {}),
        };
      }
      break;
    case 'tool_execution_update':
      if (typeof frame.toolCallId === 'string' && typeof frame.toolName === 'string') {
        return {
          type: 'tool_execution_update',
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
        };
      }
      break;
    case 'tool_execution_end':
      if (typeof frame.toolCallId === 'string' && typeof frame.toolName === 'string') {
        return {
          type: 'tool_execution_end',
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          ...(frame.result !== undefined ? { result: frame.result } : {}),
          ...(typeof frame.isError === 'boolean' ? { isError: frame.isError } : {}),
        };
      }
      break;
    case 'available_commands_update':
      return {
        type: 'available_commands_update',
        commands: Array.isArray(frame.commands) ? frame.commands.filter(isRecord) : [],
      };
    case 'extension_ui_request':
      if (typeof frame.id === 'string' && typeof frame.method === 'string') {
        return {
          type: 'extension_ui_request',
          id: frame.id,
          method: frame.method,
          ...(optionalString(frame.title) !== undefined ? { title: optionalString(frame.title) } : {}),
          ...(optionalString(frame.message) !== undefined
            ? { message: optionalString(frame.message) }
            : {}),
          ...(Array.isArray(frame.options)
            ? { options: frame.options.filter((option): option is string => typeof option === 'string') }
            : {}),
        };
      }
      break;
    case 'extension_error':
      return {
        type: 'extension_error',
        ...(optionalString(frame.extensionPath) !== undefined
          ? { extensionPath: optionalString(frame.extensionPath) }
          : {}),
        ...(optionalString(frame.error) !== undefined ? { error: optionalString(frame.error) } : {}),
      };
    case 'prompt_result':
      return {
        type: 'prompt_result',
        agentInvoked: frame.agentInvoked === true,
        ...(optionalString(frame.id) !== undefined ? { id: optionalString(frame.id) } : {}),
      };
    default:
      break;
  }
  return { type: OMP_UNKNOWN, frame };
}

/**
 * Whether an `agent_end` closes the logical turn. `isTerminal: false` is the
 * ONLY non-terminal signal — an absent field is terminal (rpc.md:513-515).
 */
export function isTerminalAgentEnd(event: OmpAgentEndEvent): boolean {
  return event.isTerminal !== false;
}
