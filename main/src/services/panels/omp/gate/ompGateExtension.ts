/**
 * ompGateExtension — cyboflow's SOLE policy engine for OMP (oh-my-pi) tool calls.
 *
 * Loaded INSIDE the spawned `omp` process by its Bun runtime via
 * `-e <path>` (see `ompGatePath.ts` for how the path is resolved). It registers
 * a `tool_call` handler that applies cyboflow's permission predicate and, for
 * anything it cannot decide locally, blocks on the orchestrator socket for a
 * human verdict — the interactive-Claude shell-hook pattern
 * (`main/src/orchestrator/shellHooks/preToolUseShellHook.ts`) ported to OMP's
 * extension API, reusing that hook's wire protocol verbatim.
 *
 * WHY THIS EXISTS AT ALL (docs/proposals/omp-provider-integration.md §5.3):
 * OMP's own tool tiers are NEVER cyboflow's trust boundary. OMP's `write`
 * approval mode auto-approves every write-tier tool and classifies ALL MCP
 * tools as write-tier — far wider than cyboflow's `acceptEdits` allowance. So
 * cyboflow spawns OMP with `--approval-mode always-ask` and decides here.
 *
 * ===========================================================================
 * FAIL-CLOSED CONTRACT
 * ===========================================================================
 * Three independent layers, all verified in OMP v17.3.3 source (citations in
 * `ompGateTypes.ts`):
 *
 *  1. A handler THROW blocks the call. `ExtensionRunner.emitToolCall` runs each
 *     handler through `#runHandlerWithTimeout` with an `onFailure` that
 *     synthesizes `{ block: true, reason: 'Extension <path> failed: <message>' }`
 *     (runner.ts:1235-1270, 1099-1110). So every `throw` below is a BLOCK whose
 *     text reaches the model — never a silent pass.
 *  2. A `{ block: true }` return short-circuits the remaining handlers AND is
 *     evaluated BEFORE OMP's own approval prompt (wrapper.ts:201-235 precedes
 *     wrapper.ts:237-339; the model-issued path blocks even earlier, in
 *     agent-session.ts:3300-3333). A block therefore SUPPRESSES the prompt.
 *  3. If this module fails to load at all, OMP records the error and continues
 *     WITHOUT the gate (loader.ts:437-443 — load errors are collected, not
 *     fatal). That is why the load sentinel exists: no sentinel file ⇒ the
 *     manager refuses the session. Never infer "gate active" from a live
 *     process.
 *
 * ===========================================================================
 * !! OMP CAPS EVERY tool_call HANDLER AT 30 SECONDS !!
 * ===========================================================================
 * `EXTENSION_HANDLER_TIMEOUT_MS = 30_000` (runner.ts:84) is raced against the
 * handler by `raceHandlerWithTimeout` (runner.ts:192-227) and applied to
 * `tool_call` at runner.ts:1237. On expiry the handler is ABORTED and converted
 * to `{ block: true, reason: 'Extension <path> timed out after 30000ms' }`.
 * There is no env var, setting, or CLI flag that changes it — the only mutator
 * is `testSetExtensionHandlerTimeoutMs` (runner.ts:91-93), a test-only export
 * with no production callsite.
 *
 * MEASURED against omp v17.3.2: with a stub orchestrator that accepts the
 * approval connection and never answers, the turn ended 31.1s after the request
 * with exactly that block text. The model then RETRIED the tool call, paying a
 * second full 30s — so an unanswerable gate costs 30s per attempt, not once.
 *
 * CONSEQUENCE: a human approval that takes longer than 30s is auto-BLOCKED by
 * OMP. That is fail-closed (safe), but it means the blocking human gate this
 * module implements is only usable for sub-30s decisions. We deliberately do
 * NOT add a timeout of our own (a shorter deadline would only deny sooner, and
 * "human is slow" must never be confused with "orchestrator is down" — the
 * shell-hook lesson). Resolving this needs a change OUTSIDE this file: either
 * an upstream OMP knob for the tool_call budget, or a non-blocking gate shape
 * (block immediately with a "pending approval" reason and let the model retry
 * once the verdict lands). Recorded for the manager step.
 *
 * WHAT WE DO ABOUT IT: {@link HUMAN_DECISION_BUDGET_MS} — a 25s budget on the
 * socket wait, 5s inside OMP's cap. Expiring the budget ourselves buys three
 * things OMP's own expiry cannot: the orchestrator sees a real disconnect
 * instead of a zombie socket, the model gets an actionable sentence instead of
 * "Extension <path> timed out", and the run's logs distinguish "nobody answered
 * in time" from "the gate crashed". Budget expiry is a BLOCK, not a throw —
 * socket-liveness failures keep throwing, so the two stay distinguishable.
 *
 * SOCKET LEAK GUARD: any socket still in flight when the session ends (a
 * handler OMP abandoned before our budget fired) is tracked and destroyed on
 * `session_shutdown`, so the leak is bounded by the session, not the app.
 *
 * ===========================================================================
 * RUNTIME CONSTRAINTS
 * ===========================================================================
 * This file executes in OMP's Bun process. It therefore:
 *  - imports NOTHING from cyboflow's source tree (the sibling `ompGateTypes`
 *    import is `import type`, which erases at compile time);
 *  - uses only `node:`-namespace APIs Bun implements (`node:net`, `node:fs`);
 *  - avoids every Bun-only API, so the same module runs under plain Node in the
 *    unit tests.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';

import type {
  OmpExtensionApi,
  OmpGateApprovalResponse,
  OmpGateConfig,
  OmpGatePermissionMode,
  OmpGateSentinel,
  OmpToolCallEvent,
  OmpToolCallEventResult,
} from './ompGateTypes';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Env var carrying the run the decisions are keyed by (workflow_runs.id). */
export const ENV_RUN_ID = 'CYBOFLOW_RUN_ID';
/** Env var carrying the orchestrator's Unix socket path. */
export const ENV_ORCH_SOCKET = 'CYBOFLOW_ORCH_SOCKET';
/** Env var carrying the JSON gate config (see {@link OmpGateConfig}). */
export const ENV_GATE_CONFIG = 'CYBOFLOW_OMP_GATE_CONFIG';
/** Env var carrying the load-sentinel file path. */
export const ENV_GATE_SENTINEL = 'CYBOFLOW_OMP_GATE_SENTINEL';

/**
 * OMP's subagent-dispatch tool (`tools/builtin-names.ts:19`).
 *
 * Was denied in every mode while hook scope inside OMP subagents was unverified.
 * It is verified now — the handler and its config reach a subagent at depth 2,
 * measured; see `ompGateConfigBuilder.ts` for the probe and for why the
 * "OMP's docs say subagents run forced-yolo" claim this comment used to carry
 * was an assumption rather than a citation. `denyTaskTool` still exists and
 * still blocks at rule 2 whenever it is set, which is what the fail-closed
 * defaults rely on.
 */
export const OMP_TASK_TOOL_NAME = 'task';

/**
 * OMP's shell tool (`tools/builtin-names.ts:2`). Matched EXACTLY wherever a
 * command is classified — a differently-cased name is one this gate has not
 * verified, and falling through to the human is the fail-closed direction for
 * every auto-allow path.
 */
export const OMP_BASH_TOOL_NAME = 'bash';

/**
 * OMP's peer-messaging / job-supervision tool (`tools/hub/index.ts`, summary
 * "Message peer agents, control background jobs, and supervise long-running
 * processes").
 *
 * ONE NAME, TWO VERY DIFFERENT POWERS — which is why this gate classifies it by
 * ARGUMENT and never by name. Its `op` spans pure coordination (message a peer,
 * wait for a reply, read an inbox) and full process control: `start` takes an
 * `application` + `args` + `env` + `cwd` and runs it. That last one is
 * arbitrary execution wearing a different key name — it carries no `command`
 * string, so the bash classifier never sees it — and before this rung existed
 * `auto` mode auto-allowed it by name, since `hub` is not in
 * {@link AUTO_MODE_HAZARD_TOOLS}.
 */
export const OMP_HUB_TOOL_NAME = 'hub';

/**
 * `hub` operations that only move MESSAGES or READ state — no process is
 * created, signalled, or destroyed by any of them:
 *
 *   wait / inbox   receive or peek at peer messages, or await a job's lifecycle
 *   list / jobs    enumerate peer agents and running jobs
 *   ps / describe  inspect a job
 *   logs           read a job's captured output (`grep`/`lines` narrow it)
 *
 * `send` is DELIBERATELY ABSENT from this set even though it is the archetypal
 * coordination op, because it is overloaded — see {@link isCoordinationHubCall}.
 *
 * `start`, `stop`, `restart` and `cancel` are absent because they are process
 * lifecycle: launching, killing, and re-launching real processes on the user's
 * machine. Those reach the human in every mode.
 */
const OMP_HUB_COORDINATION_OPS: ReadonlySet<string> = new Set([
  'wait',
  'inbox',
  'list',
  'jobs',
  'ps',
  'describe',
  'logs',
]);

/**
 * The `send` arguments that turn a peer message into PROCESS INPUT.
 *
 * `hub {op:'send'}` means one of two unrelated things depending on whether it
 * addresses an agent (`to`) or a running job (`name`):
 *
 *   to:   "deliver this text to another agent"            — coordination
 *   name: "write `text` to that process's stdin, append   — remote control of a
 *          Enter, send terminal `keys`, deliver `signal`"    live PTY
 *
 * The second form can type any command into an interactive shell the agent
 * started earlier, or SIGKILL it. Presence of ANY of these keys therefore
 * disqualifies the coordination shortcut, regardless of what else the call
 * carries — a `send` that names both a recipient and a process is exactly the
 * ambiguity to refuse rather than resolve.
 */
const OMP_HUB_PROCESS_INPUT_KEYS: readonly string[] = ['name', 'text', 'keys', 'signal'];

/**
 * True when a `hub` call is provably coordination-only, and therefore safe to
 * auto-allow at the same tier as `read`/`glob`: it touches nothing outside the
 * agent group's own message bus and job table.
 *
 * Fail-closed in every uncertain direction — a missing `op`, a non-string `op`,
 * an unrecognized `op` (a future OMP addition), or a `send` that carries any
 * process-input key all answer `false` and reach the human.
 */
export function isCoordinationHubCall(input: Record<string, unknown>): boolean {
  const op = input['op'];
  if (typeof op !== 'string') return false;
  const normalized = op.trim().toLowerCase();

  if (normalized === 'send') {
    if (OMP_HUB_PROCESS_INPUT_KEYS.some((key) => input[key] !== undefined)) return false;
    // A peer send must actually name a peer. Without `to` the op is
    // underspecified, and guessing what OMP would do with it is not this gate's
    // job.
    return typeof input['to'] === 'string' && input['to'].trim().length > 0;
  }

  return OMP_HUB_COORDINATION_OPS.has(normalized);
}

/**
 * A URI scheme sitting at a token boundary inside a tool argument: `ssh://`,
 * `file://`, `http://`, `ftp://`, anything of that shape.
 *
 * WHY THE GATE CARES (the hole this closes): OMP's read-tier tools ESCALATE
 * THEMSELVES on a remote target. `tools/read.ts:401` and `tools/grep.ts:906`
 * reclassify a call to `exec` tier when the path is `ssh://`, because the tool
 * then runs a remote operation over the user's own SSH credentials. cyboflow's
 * auto-allow sets are name lists — `read` is `read` — so without this scan a
 * `default`-mode session would auto-allow a remote read with no human anywhere
 * in the loop, and the manager's approval bridge would auto-approve OMP's own
 * redundant prompt behind it.
 *
 * NOT `^`-anchored, deliberately: a target reached through a flag-shaped
 * argument (`--file=ssh://host/x`) or embedded mid-string would evade a
 * start-anchor, and a false negative here is a silent bypass. The boundary
 * class in front makes this a strict superset of "the argument IS a URI".
 *
 * `file://` is caught deliberately too — it is path indirection, and the point
 * is that the gate stops guessing about argument semantics it cannot verify.
 *
 * Deliberately un-`g`-flagged: a `g` regex carries `lastIndex` between `.test`
 * calls, which would make this predicate answer differently on repeat inputs.
 */
const URI_SCHEME_TARGET = /(?:^|[^a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Tool arguments that carry AUTHORED FILE TEXT rather than a target, keyed by
 * the tool that carries them.
 *
 * WHY THIS EXCLUSION EXISTS (the defect it closes): {@link URI_SCHEME_TARGET}
 * disqualifies every auto-allow rung when a scheme appears ANYWHERE in the
 * arguments, and {@link scanForUriScheme} recurses into every value. For a
 * write-tier tool that means it reads the FILE BODY. A local write of a README,
 * an HTML page, a JSON report, or any source file with a link in a comment
 * therefore fell through to the human — observed live on 2026-08-19, where an
 * `auto`-mode session could not write its own report because the report's text
 * contained `https://example.com`. The file's CARGO is not its DESTINATION, and
 * the escalation the scan defends against (`read.ts:401`, `grep.ts:906`) is a
 * property of the target only.
 *
 * EXCLUSION, NOT AN ALLOWLIST OF TARGET KEYS, and the asymmetry is the reason:
 * a target hiding under `content` / `new_string` / `out` would require OMP to
 * put a path in a field whose entire purpose is text the model authored, while
 * a FUTURE OMP version adding a new target key to `write` is ordinary version
 * drift. Naming the body keys fails safe against the drift that can actually
 * happen; naming the target keys would not.
 *
 * Scoped per tool, exact-name matched, for the same reason every other rung in
 * this file is: a tool this gate has not verified gets the unnarrowed scan.
 *
 *   write     `content`                     (`tools/write.ts`; target: `path`)
 *   edit      `old_string` / `new_string`   (`edit/index.ts:382975`; target: `path`)
 *   ast_edit  `pat` / `out` inside `ops`    (`tools/ast-edit.ts:569362`; target: `paths`)
 */
const FILE_BODY_KEYS_BY_TOOL: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['write', new Set(['content'])],
  ['edit', new Set(['old_string', 'new_string'])],
  ['ast_edit', new Set(['pat', 'out'])],
  // `message` is text bound for another agent, `pattern`/`grep` are regexes
  // filtering a job's output. All three are cargo. `hub`'s real target keys —
  // `application` and `cwd` — occur only on `start`, which this gate never
  // auto-allows, so excluding the cargo keys cannot widen anything.
  ['hub', new Set(['message', 'pattern', 'grep'])],
]);

/**
 * The body keys to skip when scanning `toolName`'s arguments — empty for every
 * tool that does not carry a file body, which is the unnarrowed scan.
 */
function fileBodyKeysFor(toolName: string): ReadonlySet<string> | undefined {
  return FILE_BODY_KEYS_BY_TOOL.get(toolName);
}

/**
 * How long we wait for a human verdict before giving up ourselves.
 *
 * OMP caps every `tool_call` handler at 30s
 * (`extensibility/extensions/runner.ts:84`, `EXTENSION_HANDLER_TIMEOUT_MS`,
 * raced at `runner.ts:192-227` — measured at 31.1s wall clock against omp
 * v17.3.2). If we simply waited, OMP would abort us at its own deadline and
 * report `Extension <path> timed out after 30000ms` to the model, leaving the
 * orchestrator holding a socket nobody will ever read.
 *
 * 25s leaves a 5s margin for the block to travel back through
 * `emitToolCall` before OMP's cap fires, so OUR reason is what the model sees.
 *
 * NO LONGER THE WHOLE STORY, as of omp 17.3.5. The cap became the setting
 * `extensionHandlers.toolCallTimeoutMs` ("Made extension tool-call timeouts
 * configurable and paused them during user dialogs"), with no upper clamp, and
 * cyboflow now raises it per spawn via a config overlay
 * (`ompHandlerTimeoutOverlay.ts`) and passes the matching budget down as
 * {@link OmpGateConfig.humanDecisionBudgetMs}.
 *
 * So this constant is the FLOOR, not the policy: it is what the gate uses when
 * the host sent no budget — an OMP older than 17.3.5, a spawn whose overlay
 * could not be written, or a damaged config. Raising THIS number is still inert
 * on those paths, because the un-raised OMP cap would simply win.
 */
export const HUMAN_DECISION_BUDGET_MS = 25_000;

/**
 * The most restrictive config: gate everything, allow nothing, deny subagents.
 * A missing or unparseable `CYBOFLOW_OMP_GATE_CONFIG` resolves to exactly this
 * — the gate never fails open.
 */
export const MOST_RESTRICTIVE_GATE_CONFIG: OmpGateConfig = {
  permissionMode: 'default',
  disallowedTools: [],
  autoAllowTools: [],
  editTools: [],
  allowRules: [],
  denyTaskTool: true,
  // Empty = "no MCP tool is pre-cleared". Rule 3 is exact-membership only, so an
  // empty list auto-allows NOTHING and every MCP call falls to the human gate —
  // which is the correct degradation for a config this damaged.
  cyboflowMcpToolNames: [],
};

const PERMISSION_MODES: readonly OmpGatePermissionMode[] = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
];

/** Shell control operators that separate independently-evaluated commands. */
const SHELL_SEPARATORS = ['&&', '||', ';', '|'] as const;

/**
 * Newline separators, kept apart from {@link SHELL_SEPARATORS} because that
 * tuple is indexed positionally below. Port of `permissionRules.ts`'s
 * `SHELL_NEWLINE_SEPARATORS`.
 */
const SHELL_NEWLINE_SEPARATORS: readonly string[] = ['\n', '\r'];

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/**
 * Diagnostics sink. Deliberately NOT OMP's `pi.logger`: binding to that would
 * pin one more upstream shape for no benefit. stderr of the `omp --mode rpc`
 * child is captured by the manager, and stdout is reserved for the NDJSON
 * protocol, so stderr is the correct channel.
 */
export interface OmpGateLogger {
  debug(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Per-process instance counter, used to tell one loaded gate from another.
 *
 * OMP's extension API hands the factory nothing that identifies WHO it is
 * gating — no session id, no agent name, only `on` and `setLabel`. That is
 * survivable while one process means one agent, and stops being survivable the
 * moment subagents enter the picture: the binary initializes an extension
 * runner per task, so several gates can be live in one pid at once and every
 * line they write is indistinguishable. A pid plus an ordinal is the most
 * identity available here, and it is enough to answer the question that
 * actually matters when reading a log — did THIS agent's call reach a gate, or
 * did no gate see it at all.
 */
let gateInstanceSeq = 0;

function makeStderrLogger(tag: string): OmpGateLogger {
  const write = (m: string): void => void process.stderr.write(`[cyboflow-omp-gate ${tag}] ${m}\n`);
  return { debug: write, warn: write, error: write };
}

/** Untagged sink for tests and for {@link resolveGateRuntime}'s default. */
const stderrLogger: OmpGateLogger = makeStderrLogger('-');

// ---------------------------------------------------------------------------
// Config parsing — defensive, never fails open
// ---------------------------------------------------------------------------

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((v): v is string => typeof v === 'string');
}

function permissionMode(value: unknown): OmpGatePermissionMode | undefined {
  return typeof value === 'string' &&
    (PERMISSION_MODES as readonly string[]).includes(value)
    ? (value as OmpGatePermissionMode)
    : undefined;
}

/**
 * Parse `CYBOFLOW_OMP_GATE_CONFIG`.
 *
 * Missing, non-JSON, or non-object input yields {@link MOST_RESTRICTIVE_GATE_CONFIG}.
 * A parseable object with an individually malformed field falls back to the
 * restrictive default FOR THAT FIELD ONLY, so one bad key cannot quietly widen
 * (or needlessly narrow) the rest of the policy.
 */
export function parseGateConfig(raw: string | undefined, logger: OmpGateLogger): OmpGateConfig {
  if (raw === undefined || raw.trim().length === 0) {
    logger.warn(`${ENV_GATE_CONFIG} is unset — falling back to the most restrictive policy`);
    return { ...MOST_RESTRICTIVE_GATE_CONFIG };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(
      `${ENV_GATE_CONFIG} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — ` +
        'falling back to the most restrictive policy',
    );
    return { ...MOST_RESTRICTIVE_GATE_CONFIG };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.error(`${ENV_GATE_CONFIG} is not a JSON object — falling back to the most restrictive policy`);
    return { ...MOST_RESTRICTIVE_GATE_CONFIG };
  }

  const obj = parsed as Record<string, unknown>;
  return {
    permissionMode: permissionMode(obj['permissionMode']) ?? MOST_RESTRICTIVE_GATE_CONFIG.permissionMode,
    disallowedTools: stringArray(obj['disallowedTools']) ?? [],
    autoAllowTools: stringArray(obj['autoAllowTools']) ?? [],
    editTools: stringArray(obj['editTools']) ?? [],
    allowRules: stringArray(obj['allowRules']) ?? [],
    // Anything that is not an explicit `false` denies the subagent tool.
    denyTaskTool: obj['denyTaskTool'] === false ? false : true,
    cyboflowMcpToolNames: stringArray(obj['cyboflowMcpToolNames']) ?? [],
    // A budget is honored only as a POSITIVE FINITE number. Anything else —
    // absent, a string, NaN, zero, negative — leaves the field unset, and an
    // unset field means the built-in ~25s budget. That asymmetry is deliberate:
    // the damage from wrongly believing OMP will wait 30 minutes is a lost
    // error message and a stranded socket, while the damage from wrongly
    // keeping 25s is only a retry the deferred-approval path already handles.
    ...(positiveBudget(obj['humanDecisionBudgetMs']) !== undefined
      ? { humanDecisionBudgetMs: positiveBudget(obj['humanDecisionBudgetMs']) }
      : {}),
  };
}

/**
 * A `humanDecisionBudgetMs` value we are willing to act on: a finite number
 * strictly greater than zero. `typeof x === 'number'` alone would admit NaN
 * and Infinity, either of which turns `setTimeout` into "never fire".
 */
function positiveBudget(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

// ---------------------------------------------------------------------------
// Permission-rule matching (the honored subset of cyboflow's rule grammar)
// ---------------------------------------------------------------------------

/** A parsed permission rule: `ToolName` or `ToolName(content)`. */
export interface ParsedGateRule {
  toolName: string;
  content?: string;
}

/**
 * Parse a raw rule string into `{ toolName, content }` — a verbatim port of
 * `main/src/orchestrator/permissionRules.ts:67-81` (it cannot be imported:
 * this module must not reach into cyboflow's source tree).
 */
export function parsePermissionRule(rule: string): ParsedGateRule | null {
  const trimmed = rule.trim();
  if (trimmed.length === 0) return null;

  const open = trimmed.indexOf('(');
  if (open === -1) return { toolName: trimmed };
  if (!trimmed.endsWith(')')) return null;

  const toolName = trimmed.slice(0, open).trim();
  const content = trimmed.slice(open + 1, -1).trim();
  if (toolName.length === 0) return null;
  return content.length === 0 ? { toolName } : { toolName, content };
}

/**
 * Split a command on unquoted shell separators — `&&`, `||`, `;`, `|`, and a raw
 * newline. Port of permissionRules.ts's `splitShellSegments`.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote !== null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === SHELL_SEPARATORS[0] || two === SHELL_SEPARATORS[1]) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (
      ch === SHELL_SEPARATORS[2] ||
      ch === SHELL_SEPARATORS[3] ||
      SHELL_NEWLINE_SEPARATORS.includes(ch)
    ) {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** True if a command segment contains command substitution we refuse to trust. */
export function hasCommandSubstitution(segment: string): boolean {
  return segment.includes('$(') || segment.includes('`');
}

/** `git add:*` → prefix match; `done` → exact match. Port of permissionRules.ts:138-146. */
function matchBashSpecifier(content: string, segment: string): boolean {
  if (content.endsWith(':*')) {
    const prefix = content.slice(0, -2).trim();
    if (prefix.length === 0) return false; // refuse to match-all
    return segment === prefix || segment.startsWith(prefix + ' ');
  }
  return segment === content;
}

/**
 * True if the `(toolName, input)` pair matches at least one allow rule.
 *
 * HONORED SUBSET, and the two deliberate divergences from
 * `permissionRules.ts:177-208`:
 *
 *  1. Tool names are compared CASE-INSENSITIVELY. cyboflow's rules are written
 *     against Claude's PascalCase tool names (`Bash`, `Read`, `Write`) while
 *     OMP's canonical names are lowercase (`bash`, `read`, `write`,
 *     `tools/builtin-names.ts:1-31`). Without this, no rule would ever match an
 *     OMP call and `auto` mode would silently degrade to `default`.
 *  2. `WebFetch(domain:X)` is NOT honored. OMP has no `WebFetch` tool (it ships
 *     `fetch` and `web_search`), and inventing a URL-field mapping would be
 *     policy we cannot cite. It falls into the conservative default below.
 *
 * Everything else mirrors the original: a bare tool-name rule grants the whole
 * tool; `Bash(...)` specifiers must match EVERY segment of a compound command
 * and any segment with command substitution fails; every other specifier kind
 * (path globs in particular) does NOT auto-allow.
 */
export function matchesAllowRules(
  toolName: string,
  input: Record<string, unknown>,
  rules: readonly string[],
): boolean {
  const lowered = toolName.toLowerCase();
  const forTool = rules
    .map(parsePermissionRule)
    .filter((r): r is ParsedGateRule => r !== null)
    .filter((r) => r.toolName.toLowerCase() === lowered);

  if (forTool.length === 0) return false;

  // A bare tool-name rule grants the whole tool.
  if (forTool.some((r) => r.content === undefined)) return true;

  if (lowered === 'bash') {
    const command = typeof input['command'] === 'string' ? input['command'].trim() : '';
    if (command.length === 0) return false;
    const contents = forTool.map((r) => r.content).filter((c): c is string => c !== undefined);
    const segments = splitShellSegments(command);
    if (segments.length === 0) return false;
    return segments.every(
      (segment) =>
        !hasCommandSubstitution(segment) &&
        contents.some((content) => matchBashSpecifier(content, segment)),
    );
  }

  // Unsupported specifier kind (path globs, domain:) — never auto-allow.
  return false;
}

// ---------------------------------------------------------------------------
// Bash classification — the `safe-bash` rung
// ---------------------------------------------------------------------------

/**
 * A DELIBERATE DUPLICATE of `main/src/orchestrator/safeCommandClassifier.ts`,
 * tables and structural refusals mirrored line for line — NOT an import of it.
 *
 * WHY DUPLICATED: this module is loaded by OMP's Bun runtime from a single
 * standalone file (`-e <path>`) and may import nothing from cyboflow's source
 * tree; the classifier in turn imports `./permissionRules`, which is main-process
 * code. Same precedent, same reasoning as the `UnreffableTimer` interface
 * duplicated between `orchestrator/mcpServer/parentWatchdog.ts` and
 * `services/mcpOrphanTripwire.ts`. Drift is pinned mechanically: the parity test
 * (`__tests__/ompGateSafeBash.test.ts`) imports BOTH implementations — tests are
 * not shipped to Bun, so they may reach across — and asserts the read-only tier
 * agrees verdict-for-verdict on a shared fixture table.
 *
 * WHY THE RUNG EXISTS AT ALL: without it, every `bash` call under `acceptEdits`
 * or `auto` fell to rule 6 and blocked on the orchestrator socket for a human.
 * In an autonomous workflow lane there IS no human, so the 25s budget expired
 * and even `git status` was denied — measured on a live sprint, whose implement
 * agent could not commit its own work.
 */

/**
 * git subcommands that are read-only in EVERY invocation regardless of flags or
 * positionals. (Notably absent: branch/tag/remote/config/stash — dual-use,
 * handled below — and every mutating subcommand.)
 */
const ALWAYS_READONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'shortlog',
  'reflog',
  'rev-parse',
  'rev-list',
  'describe',
  'ls-files',
  'ls-tree',
  'cat-file',
  'grep',
  'show-branch',
  'whatchanged',
  'name-rev',
  'merge-base',
  'count-objects',
  'verify-commit',
  'verify-tag',
  'var',
]);

/**
 * Mutating `git branch` flags. `git branch` with only NON-mutating flags (and no
 * positional, which would name a new branch) lists branches → read-only.
 */
const MUTATING_BRANCH_FLAGS: ReadonlySet<string> = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '--delete',
  '--move',
  '--copy',
  '--force',
  '--edit-description',
  '--set-upstream-to',
  '-u',
  '--unset-upstream',
]);

/**
 * Read-only shell utilities. Deliberately excludes anything that can mutate or
 * execute a sub-program without a shell metacharacter we already reject:
 * `sed` (-i edits in place), `find` (-delete/-exec), `env`/`xargs`/`nohup`/
 * `timeout` (run arbitrary programs), `awk` (system()/print-to-file).
 */
const SAFE_READONLY_SHELL_PROGRAMS: ReadonlySet<string> = new Set([
  'ls',
  'pwd',
  'cat',
  'head',
  'tail',
  'wc',
  'echo',
  'printf',
  'which',
  'whoami',
  'id',
  'date',
  'hostname',
  'uname',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'tree',
  'stat',
  'file',
  'du',
  'df',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'sort',
  'uniq',
  'cut',
  'column',
  'nl',
  'diff',
  'cmp',
  'comm',
]);

/**
 * git subcommands that write ONLY inside the repository the agent is already
 * working in — the index, the working tree, and local refs. This tier has NO
 * counterpart in `safeCommandClassifier.ts`: it is a gate-only widening, and it
 * is what lets an autonomous lane agent commit the work it just wrote.
 *
 * WHY IT IS THE SAME TRUST DOMAIN as the write/edit tools this mode already
 * auto-allows:
 *  - Nothing here reaches the network. Every subcommand that publishes or
 *    fetches (push, pull, fetch, clone, remote add, submodule) is absent, so the
 *    blast radius stays inside the worktree.
 *  - `git commit` can run repo-local hooks — and the agent can already WRITE
 *    those hook files with the auto-allowed `write` tool. Denying the commit
 *    while allowing the hook to be authored buys nothing.
 *  - Path escape is enforced by git, not by parsing: `git add`/`rm`/`mv`/
 *    `restore` refuse a pathspec outside the repository, so this tier cannot be
 *    steered at `/etc` the way a raw `rm` could.
 *
 * Deliberately NOT here: checkout/switch/reset/clean/stash/merge/rebase/
 * cherry-pick/revert/apply — each can destroy uncommitted work that a human or
 * a sibling lane owns, which is a different question from "may this agent
 * record its own edits".
 */
const LOCAL_ONLY_GIT_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add',
  'commit',
  'restore',
  'rm',
  'mv',
]);

/** Tokenize a single shell segment on whitespace (segments are pre-split). */
function tokenizeSegment(segment: string): string[] {
  return segment
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Strip a trailing `=value` so `--set-upstream-to=origin/x` matches its flag. */
function flagName(token: string): string {
  const eq = token.indexOf('=');
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * Structural refusals shared by BOTH tiers. Command substitution hides an
 * unknowable command; redirection (`>`/`<`) writes or reads files the tables
 * never vetted; `&` backgrounds or chains outside the segment model
 * {@link splitShellSegments} gives us.
 */
function hasStructuralRefusal(segment: string): boolean {
  return hasCommandSubstitution(segment) || /[<>&]/.test(segment);
}

/**
 * True if a `git <args>` invocation (args = tokens AFTER `git`) is read-only.
 * The subcommand must be the FIRST token — a leading global option (`-C path`,
 * `-c k=v`, …) is refused rather than parsed, keeping the common
 * `git <subcommand>` form fast and the exotic forms safely prompted.
 */
function isSafeReadOnlyGitInvocation(args: string[]): boolean {
  const sub = args[0];
  if (sub === undefined || sub.startsWith('-')) return false;
  const subArgs = args.slice(1);

  if (ALWAYS_READONLY_GIT_SUBCOMMANDS.has(sub)) return true;

  switch (sub) {
    case 'branch':
      // List form only: no positional (would name a new branch) and no mutating
      // flag. `git branch`, `git branch -a -v` pass; `git branch -d foo` refuses.
      return (
        subArgs.every((t) => t.startsWith('-')) &&
        !subArgs.some((t) => MUTATING_BRANCH_FLAGS.has(flagName(t)))
      );
    case 'tag':
      // List form only: any positional would create/delete a tag.
      return subArgs.every((t) => t.startsWith('-'));
    case 'remote':
      // `git remote`, `git remote -v`, `git remote show [name]`,
      // `git remote get-url [name]` read; add/remove/rename/prune/set-url mutate.
      return (
        subArgs.length === 0 || ['-v', '--verbose', 'show', 'get-url'].includes(subArgs[0]!)
      );
    case 'config':
      // Read forms only; a bare `git config k v` writes.
      return (
        subArgs.length > 0 &&
        ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(subArgs[0]!)
      );
    case 'stash':
      // `git stash list` / `git stash show` read; bare `git stash` and
      // pop/drop/apply/push/clear mutate the working tree or stash list.
      return subArgs.length > 0 && ['list', 'show'].includes(subArgs[0]!);
    default:
      return false;
  }
}

/** True if one shell segment is a provably read-only command. */
function isSafeReadOnlySegment(segment: string): boolean {
  if (hasStructuralRefusal(segment)) return false;

  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return false;
  const program = tokens[0]!;

  if (program === 'git') return isSafeReadOnlyGitInvocation(tokens.slice(1));
  return SAFE_READONLY_SHELL_PROGRAMS.has(program);
}

/**
 * True if one shell segment is a local-only git write —
 * {@link LOCAL_ONLY_GIT_WRITE_SUBCOMMANDS} named as the FIRST token after `git`,
 * under the same structural refusals as the read-only tier. A leading git global
 * option (`git -C /elsewhere commit …`) is refused rather than parsed, which is
 * also what keeps the tier from being pointed at another repository.
 */
function isLocalOnlyGitWriteSegment(segment: string): boolean {
  if (hasStructuralRefusal(segment)) return false;

  const tokens = tokenizeSegment(segment);
  if (tokens.length < 2 || tokens[0] !== 'git') return false;
  const sub = tokens[1]!;
  if (sub.startsWith('-')) return false;
  return LOCAL_ONLY_GIT_WRITE_SUBCOMMANDS.has(sub);
}

/**
 * True if a bash `command` string is a provably read-only invocation. EVERY
 * quote-aware segment must classify safe, so `git status && rm -rf .` refuses.
 *
 * The mirrored half of the classifier — the parity test pins this against
 * `isSafeReadOnlyBashCommand` in `main/src/orchestrator/safeCommandClassifier.ts`.
 */
export function isSafeReadOnlyBashCommand(rawCommand: string): boolean {
  const command = rawCommand.trim();
  if (command.length === 0) return false;
  if (/[\r\n]/.test(command)) return false;
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every(isSafeReadOnlySegment);
}

/**
 * True if EVERY segment of a bash `command` is a local-only git write. Exported
 * so the tier can be pinned on its own: it is the gate-only widening, so "which
 * forms exactly" has to be assertable without going through the whole rung.
 */
export function isLocalOnlyGitWriteCommand(rawCommand: string): boolean {
  const command = rawCommand.trim();
  if (command.length === 0) return false;
  if (/[\r\n]/.test(command)) return false;
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every(isLocalOnlyGitWriteSegment);
}

/**
 * The `safe-bash` rung's predicate: every quote-aware segment is EITHER provably
 * read-only OR a local-only git write. Mixing the tiers within one command is
 * fine — `git status && git add -A && git commit -m x` is the shape a lane agent
 * actually runs.
 *
 * The raw-newline refusal is now belt AND braces. {@link splitShellSegments}
 * splits on a newline like any other separator, so `git status\nrm -rf ~`
 * arrives as two segments and the `rm` one fails the tables. The blunt refusal
 * stays on top because a newline INSIDE quotes survives the split, and because
 * the mirrored classifier refuses identically — the parity test pins the two
 * together. A multi-line command simply reaches the human instead of being
 * auto-run.
 *
 * It did not always work this way: the splitter originally ignored newlines
 * "to stay byte-identical to cyboflow's rule grammar", which left that same
 * grammar (and the acceptEdits classifier) auto-approving the command above.
 * Splitting is strictly more conservative for both — an unmatched segment falls
 * through to the human — so the sync was restored in the safe direction.
 */
export function isGateSafeBashCommand(rawCommand: string): boolean {
  const command = rawCommand.trim();
  if (command.length === 0) return false;
  if (/[\r\n]/.test(command)) return false;
  const segments = splitShellSegments(command);
  if (segments.length === 0) return false;
  return segments.every(
    (segment) => isSafeReadOnlySegment(segment) || isLocalOnlyGitWriteSegment(segment),
  );
}

// ---------------------------------------------------------------------------
// `auto` mode — the allow-unless-hazardous tier
// ---------------------------------------------------------------------------

/**
 * `auto` INVERTS the gate's default posture, and only `auto`.
 *
 * `default` and `acceptEdits` are prove-it-safe: a call is auto-allowed only if
 * it matches a vetted name list or a provably-read-only command, and everything
 * else reaches a human. `auto` is allow-unless-hazardous: a call is auto-allowed
 * unless it trips one of the tables below.
 *
 * WHY THE ASYMMETRY IS THE POINT. On Claude, `auto` installs NO PreToolUse hook
 * at all — the native classifier owns gating (`orchestrator/permissionModeMapper.ts`,
 * the `case 'auto': return undefined` arm). OMP ships no such classifier, so the
 * original mapping (proposal §5.3) defined OMP's `auto` as "acceptEdits plus the
 * merged allow-rules". That is strictly NARROWER than what the same word means
 * one runtime over: measured on a live session, `pnpm test`, `mkdir -p`, `node
 * scripts/x.mjs` and every other ordinary build command fell through to rule 6
 * and blocked on a human, which is not what a user selecting "Auto" is asking
 * for. This tier is the classifier's stand-in: a hand-written hazard list rather
 * than a model, but the same posture.
 *
 * THE TRUST BOUNDARY THIS DOES NOT CROSS. Rules 1-3 of {@link decideToolCall}
 * still apply first and are untouched — `disallowedTools` still refuses, the
 * `task` subagent tool is still denied, and the URI-scheme narrowing
 * ({@link hasUriSchemeTarget}) still disqualifies EVERY shortcut below, so
 * anything naming a remote target still reaches a human. This is a deliberate
 * widening of `auto` alone, chosen by the user; `default` and `acceptEdits` are
 * byte-identical to before.
 *
 * THE KNOWN COST. An OMP builtin this file has never heard of is auto-allowed
 * in `auto` (it is absent from the hazard set). That is inherent to
 * allow-unless-hazardous and is why the inversion is scoped to one mode. Foreign
 * MCP tools are the deliberate exception — see {@link isAutoModeAllowedTool}.
 */

/**
 * OMP builtins `auto` refuses to auto-allow. Each reaches outside the agent's
 * own worktree-and-model loop:
 *
 *   computer  — native desktop capture AND INPUT (keystrokes/clicks on the
 *               user's real machine, outside any sandbox this gate can reason about)
 *   browser   — drives the user's own Chrome over the CDP relay, with their
 *               live cookies and logged-in sessions
 *   github    — authenticated writes to real repositories/issues/PRs
 *   eval      — executes code the tables never vetted, which is the whole
 *               premise of a hazard list
 *   debug     — attaches a debugger to a live process
 *
 * `task` is absent because it is already refused unconditionally, in every mode,
 * by rule 2 — listing it here would imply the deny is mode-scoped.
 */
const AUTO_MODE_HAZARD_TOOLS: readonly string[] = [
  'computer',
  'browser',
  'github',
  'eval',
  'debug',
];

/** OMP's MCP tool-name prefix (`mcp/tool-bridge.ts` composes `mcp__<server>_<tool>`). */
const OMP_MCP_TOOL_PREFIX = 'mcp__';

/**
 * Whether `auto` may auto-allow a NON-bash tool by name (bash has its own
 * argument-aware rung — {@link isAutoModeAllowedBashCommand}).
 *
 * Foreign MCP tools are excluded even though they are not in the hazard list,
 * and the reason is the same one {@link isCyboflowMcpTool} is exact-name
 * matched: OMP auto-imports the user's own MCP configs, so `mcp__*` names an
 * arbitrary third-party server whose semantics this gate cannot know. Allowing
 * a whole category on the strength of "we have no reason to think it is
 * dangerous" is precisely the reasoning that does not hold for code we have
 * never seen. Cyboflow's own MCP tools never reach here — rule 3 allows them
 * first, by exact composed name.
 */
export function isAutoModeAllowedTool(toolName: string): boolean {
  const name = toolName.toLowerCase();
  if (name.startsWith(OMP_MCP_TOOL_PREFIX)) return false;
  return !AUTO_MODE_HAZARD_TOOLS.includes(name);
}

/** Programs that run as, or become, another user. */
const PRIVILEGE_ESCALATION_PROGRAMS: ReadonlySet<string> = new Set([
  'sudo',
  'su',
  'doas',
  'pkexec',
]);

/**
 * Programs that execute code this classifier never sees — a shell, an inline
 * evaluator, or a wrapper that runs whatever it is handed.
 *
 * The shells are what the tail of a `curl … | sh` tokenizes to:
 * {@link splitShellSegments} splits on `|`, so that pipeline arrives here as a
 * segment whose program is `sh`, and refusing the shells refuses the pipeline.
 */
const CODE_EXECUTING_PROGRAMS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'dash',
  'eval',
  'exec',
  'source',
  '.',
  'env',
  'xargs',
  'nohup',
  'osascript',
]);

/**
 * Programs that destroy data outright. Always hazardous, with no path analysis:
 * `rm -rf node_modules` asking for a confirmation is a small cost, and the
 * alternative — deciding from a pathspec whether a delete stays inside the
 * worktree — is exactly the kind of parse this file refuses to trust elsewhere.
 */
const DESTRUCTIVE_PROGRAMS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'shred',
  'srm',
  'dd',
  'mkfs',
  'fdisk',
  'diskutil',
  'mount',
  'umount',
  'chmod',
  'chown',
  'chgrp',
  'chflags',
  'kill',
  'killall',
  'pkill',
  'reboot',
  'shutdown',
  'halt',
  'launchctl',
  'systemctl',
  'crontab',
  'defaults',
  'csrutil',
  'spctl',
  'security',
  'passwd',
  'visudo',
]);

/**
 * Programs that move bytes to, or execute on, another host. `curl`/`wget` are
 * deliberately ABSENT: they are ubiquitous in a build loop, and the URI-scheme
 * narrowing already forces any invocation carrying a `scheme://` target to a
 * human before this classifier is consulted at all.
 */
const REMOTE_TRANSPORT_PROGRAMS: ReadonlySet<string> = new Set([
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ftp',
  'tftp',
]);

/**
 * Interpreters that are ordinary programs with a script argument (`node
 * scripts/build.mjs`) but arbitrary-code evaluators with an inline flag. Keyed
 * by program → the flags that make it the latter, so the common form stays
 * auto-allowed and only the evaluator form asks.
 */
const INLINE_CODE_FLAGS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['node', new Set(['-e', '--eval', '-p', '--print'])],
  ['bun', new Set(['-e', '--eval', '-p', '--print'])],
  ['deno', new Set(['eval'])],
  ['python', new Set(['-c'])],
  ['python3', new Set(['-c'])],
  ['perl', new Set(['-e', '-E'])],
  ['ruby', new Set(['-e'])],
  ['php', new Set(['-r'])],
]);

/** `find` flags that turn a search into an execution or a delete. */
const FIND_EXECUTING_FLAGS: ReadonlySet<string> = new Set([
  '-exec',
  '-execdir',
  '-delete',
  '-ok',
  '-okdir',
]);

/**
 * git subcommands `auto` refuses. Two groups, one rationale each:
 *
 *  - PUBLISHES OR FETCHES (push, pull, fetch, clone, remote, submodule): leaves
 *    the machine, using the user's own credentials.
 *  - DESTROYS UNCOMMITTED OR SHARED WORK (reset, checkout, switch, clean,
 *    stash, rebase, merge, cherry-pick, revert, apply, am, filter-branch,
 *    worktree, gc, prune, config): a human or a sibling sprint lane may own the
 *    state being discarded. This is the same line
 *    {@link LOCAL_ONLY_GIT_WRITE_SUBCOMMANDS} already draws for `acceptEdits`,
 *    kept in `auto` rather than relaxed — "may this agent record its own edits"
 *    and "may it discard someone else's" stay different questions.
 *
 * `add`/`commit`/`restore`/`rm`/`mv` are absent, so they auto-allow — they
 * already do under `acceptEdits` via the local-only-write tier.
 */
const AUTO_MODE_HAZARD_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'push',
  'pull',
  'fetch',
  'clone',
  'remote',
  'submodule',
  'reset',
  'checkout',
  'switch',
  'clean',
  'stash',
  'rebase',
  'merge',
  'cherry-pick',
  'revert',
  'apply',
  'am',
  'filter-branch',
  'worktree',
  'gc',
  'prune',
  'config',
]);

/** Programs whose hazard depends on whether an argument escapes the worktree. */
const PATH_ESCAPE_SENSITIVE_PROGRAMS: ReadonlySet<string> = new Set([
  'cp',
  'mv',
  'ln',
  'install',
]);

/**
 * True if a token names a location outside the current directory tree — an
 * absolute path, a `~` expansion, or any `..` component. Deliberately crude and
 * over-eager: it is only consulted to REFUSE, so a false positive costs one
 * human prompt while a false negative would let `cp .env /tmp/x` through.
 */
function escapesWorkingTree(token: string): boolean {
  if (token.startsWith('-')) return false;
  if (token.startsWith('/') || token.startsWith('~')) return true;
  return token === '..' || token.startsWith('../') || token.includes('/../') || token.endsWith('/..');
}

/**
 * The name a hazard table should be consulted with, given the program token as
 * written.
 *
 * Every table below is keyed by a BARE program name (`rm`, `zsh`, `sudo`), so
 * matching the token verbatim let an absolute or relative path walk past all of
 * them: `/bin/rm -rf ~`, `/bin/zsh -lc '…'` and `/usr/bin/sudo rm -rf /` were
 * each auto-allowed because `/bin/rm` is not the string `rm`. Taking the
 * basename closes that, and it is the whole fix — a path is not a different
 * program, and `zsh` reached by any route runs code this classifier cannot see.
 *
 * Deliberately NOT resolved further: no symlink following, no `$PATH` lookup,
 * no argv[0] rewriting. Those need a filesystem this pure function does not
 * touch, and the tier is allow-unless-hazardous, so the honest statement is
 * that this closes the literal-path bypass and nothing more.
 *
 * The prove-it-safe tiers need no equivalent: they are allowlists, so an
 * unrecognized `/bin/cat` already fails closed there.
 */
function programName(token: string): string {
  const slash = token.lastIndexOf('/');
  return slash === -1 ? token : token.slice(slash + 1);
}

/** A `NAME=value` token: sets a variable, executes nothing. */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Tokens that stand in FRONT of the real program without being it.
 *
 * The hazard tables classify `tokens[0]`, so anything occupying that slot
 * without being the command shadows the command entirely. Three shapes did:
 *
 *     FOO=1 sudo rm -rf /            assignment prefix
 *     for i in 1; do rm -rf ~; done  the `do` segment's keyword
 *     time rm -rf ~ / nice rm -rf ~  a wrapper that runs its argument
 *
 * Every one of those was auto-allowed, because `FOO=1`, `do` and `time` are in
 * no table. Skipping past them puts the actual program back in the slot the
 * tables read.
 *
 * `exec`, `source`, `nohup`, `xargs`, `env` and the shells are deliberately
 * ABSENT: they are already CODE_EXECUTING_PROGRAMS, and skipping past one would
 * turn a refusal into an inspection of its argument — the opposite of the point.
 */
const TRANSPARENT_PREFIX_TOKENS: ReadonlySet<string> = new Set([
  'if', 'then', 'else', 'elif', 'fi',
  'for', 'while', 'until', 'do', 'done',
  'case', 'esac', 'select', 'function',
  'time', 'command', 'builtin', 'nice',
  '{', '}', '(', ')', '!',
]);

/**
 * The program a segment actually runs, or `null` when it runs nothing (a bare
 * assignment, a lone `done`).
 *
 * Returns `'-'`-leading tokens as-is so the caller can refuse them: landing on
 * a flag means a prefix consumed an option this function does not model
 * (`nice -n 5 rm …`), and an unreadable form is refused rather than parsed —
 * the same discipline `git -C …` already gets.
 */
function resolveProgramToken(tokens: readonly string[]): string | null {
  for (const token of tokens) {
    if (ASSIGNMENT_PREFIX.test(token)) continue;
    if (TRANSPARENT_PREFIX_TOKENS.has(token)) continue;
    return token;
  }
  return null;
}

/** True if ONE segment trips a hazard table. */
function isAutoModeHazardousSegment(segment: string): boolean {
  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return true;
  const programToken = resolveProgramToken(tokens);
  // Nothing is executed (a bare `FOO=1`, a lone `done`) — benign.
  if (programToken === null) return false;
  // A prefix consumed an option this function does not model. Refuse.
  if (programToken.startsWith('-')) return true;
  // A VARIABLE decides what runs (`$X -rf ~`, `${CMD} …`, `"$TOOL" …`), so the
  // token names nothing this classifier can look up. Refusing is the only
  // readable answer: `X=rm; $X -rf ~` otherwise reaches no table at all.
  if (programToken.includes('$')) return true;
  const program = programName(programToken);
  const args = tokens.slice(tokens.indexOf(programToken) + 1);

  if (PRIVILEGE_ESCALATION_PROGRAMS.has(program)) return true;
  // `env` is code-executing because `env FOO=1 cmd` RUNS cmd. With no operand
  // it runs nothing — it prints the environment, and `env | grep …` is one of
  // the most common probes an agent makes (2 of the 12 escalations on the 0.2.5
  // release smoke). An operand is anything that is not a flag, so `env FOO=1 rm`
  // and `env -i sh` both stay hazardous; `env -u FOO` does too, conservatively,
  // since this does not model which flags take a value.
  const isEnvPrinter = program === 'env' && args.every((token) => token.startsWith('-'));
  if (!isEnvPrinter && CODE_EXECUTING_PROGRAMS.has(program)) return true;
  if (DESTRUCTIVE_PROGRAMS.has(program)) return true;
  if (REMOTE_TRANSPORT_PROGRAMS.has(program)) return true;

  const inlineFlags = INLINE_CODE_FLAGS.get(program);
  if (inlineFlags !== undefined && args.some((token) => inlineFlags.has(flagName(token)))) {
    return true;
  }

  if (program === 'find' && args.some((token) => FIND_EXECUTING_FLAGS.has(token))) return true;

  if (program === 'git') {
    const sub = args[0];
    // A leading global option (`git -C /elsewhere …`) is refused rather than
    // parsed, exactly as the read-only tier refuses it — that is what keeps the
    // tier from being pointed at another repository.
    if (sub === undefined || sub.startsWith('-')) return true;
    return AUTO_MODE_HAZARD_GIT_SUBCOMMANDS.has(sub);
  }

  if (PATH_ESCAPE_SENSITIVE_PROGRAMS.has(program) && args.some(escapesWorkingTree)) return true;

  return false;
}

/**
 * Redirections that can neither write a file nor read one: a discard
 * (`2>/dev/null`, `>/dev/null`, `&>/dev/null`) or a descriptor duplication
 * (`2>&1`). The `/dev/null` target must END the token, so `>/dev/nullx` and
 * `>/dev/null/../etc/passwd` are NOT matched.
 */
const BENIGN_REDIRECT = /(?:&>>?|[0-9]*>>?)\s*(?:\/dev\/null|&[0-9])(?=\s|$)/g;

/**
 * The measured reason `auto` was still escalating roughly half of OMP's bash
 * calls: `hasStructuralRefusal` refuses any `<`, `>` or `&`, and `2>/dev/null`
 * is the single most common thing an agent appends to a probe. On the 0.2.5
 * release smoke it accounted for 8 of the 12 escalations.
 *
 * Stripping only these two forms keeps the refusal's actual purpose intact —
 * they name no file to write and open no file to read, so there is nothing the
 * hazard tables failed to vet. Every other redirection still refuses, which is
 * why the strip happens BEFORE {@link hasStructuralRefusal} rather than
 * weakening it: `cat secrets > /tmp/exfil` and `echo hi > important.txt` are
 * untouched, and so is the `&` that backgrounds.
 */
/**
 * A redirect target this gate is willing to read as a PLAIN LOCAL PATH: a
 * quoted or bare token of path characters, optionally carrying a variable
 * expansion (`> "$OUT"`, `> "$SMOKE_DIR/x.json"` — an agent writing a computed
 * path is ordinary, and a variable can only ever name a destination, never run
 * anything).
 *
 * Deliberately EXCLUDES `(`, `)` and a backtick, so process substitution
 * (`> >(sh)`, `< <(curl …)`) never matches and stays refused, and excludes `<`
 * so a heredoc's `<<DELIM` never looks like a target.
 */
const PLAIN_REDIRECT_TARGET = /^(?:'[^']*'|"[^"`]*"|[A-Za-z0-9_./~@+%:${}-]+)$/;

/**
 * Redirect targets that are NOT files however plain they look.
 *
 * `/dev/tcp/host/port` and `/dev/udp/…` are bash's NETWORK redirects — a
 * `cat < /dev/tcp/evil/80` opens a socket, which is the one thing a "this is
 * just a file path" argument cannot cover. The substitution placeholder is
 * refused for the same class of reason: a target decided by a command
 * substitution is not a path this gate has read.
 */
function isRedirectTargetSafe(rawTarget: string): boolean {
  const target = rawTarget.replace(/^["']|["']$/g, '');
  if (target.includes(SUBSTITUTION_PLACEHOLDER)) return false;
  if (/^\/dev\/(?:tcp|udp)(?:\/|$)/.test(target)) return false;
  // Scoped to the working tree, via the same crude, over-eager test the
  // path-sensitive programs use. The parity argument reaches "a file the agent
  // may already write with the `write` tool"; it does NOT reach `> /etc/hosts`,
  // and the fact that the `edit-tool` rung applies no path check of its own is
  // a hole to close there rather than a licence to open a second one here.
  //
  // KNOWN LIMIT: a variable target (`> "$OUT"`) is unresolvable in a pure
  // function, so it passes — the same statement already true of `cp "$X" "$Y"`
  // under PATH_ESCAPE_SENSITIVE_PROGRAMS.
  if (escapesWorkingTree(target)) return false;
  return PLAIN_REDIRECT_TARGET.test(rawTarget);
}

/**
 * A redirect operator plus its target, for the parity strip below.
 * `<<` (heredoc) is excluded by requiring the `<` form to be a SINGLE `<`.
 */
const REDIRECT_WITH_TARGET =
  /(?:&>>?|[0-9]*>>?|[0-9]*<(?!<))\s*('[^']*'|"[^"`]*"|\S+)(?=\s|$)/g;

/**
 * Strip the redirects `auto` has no reason to refuse.
 *
 * THE PARITY ARGUMENT (the defect this closes). In `auto`, the `write`/`edit`
 * tools are auto-allowed by the `edit-tool` rung and `read` by
 * `autoAllowTools` — so the agent may already write and read any local path
 * without a human. Refusing `echo x > report.json` while allowing
 * `write({path:'report.json'})` gates the CAPABILITY differently depending on
 * which tool spells it, which is an inconsistency rather than a boundary. On
 * the 2026-08-23 OMP smoke, redirects accounted for 8 of the 9 remaining bash
 * escalations, every one of them a probe writing its own output file.
 *
 * What still refuses, and why the strip cannot launder it: only a redirect
 * whose target reads as a plain local path is removed
 * ({@link isRedirectTargetSafe}). Process substitution keeps its parentheses,
 * a heredoc keeps its second `<`, a network redirect is rejected by target, and
 * a bare `&` (backgrounding) is never a redirect at all — so each of those
 * survives into {@link hasStructuralRefusal} and still reaches the human.
 */
function stripBenignRedirects(segment: string): string {
  return segment
    .replace(BENIGN_REDIRECT, ' ')
    .replace(REDIRECT_WITH_TARGET, (whole, target: string) =>
      isRedirectTargetSafe(target) ? ' ' : whole,
    );
}

/**
 * Stands in for a `$(...)` whose body has been lifted out and judged separately.
 *
 * Contains NO whitespace, so it stays ONE token through {@link tokenizeSegment}
 * and cannot split `DIR="$(pwd)/x"` in two - which would strand the assignment
 * and leave the placeholder sitting in program position. NUL cannot occur in a
 * real command line, so a literal collision is impossible; were one contrived it
 * could only force a refusal, never an allow.
 */
const SUBSTITUTION_PLACEHOLDER = '\u0000sub\u0000';

/** Bounds the innermost-out rewrite below; a command this nested is refused. */
const MAX_SUBSTITUTIONS = 32;

/**
 * Lift every `$(…)` body out innermost-first, leaving a placeholder behind.
 *
 * Returns `null` when the command cannot be read this way at all — a backtick
 * (whose nesting this does not model) or an unbalanced/arithmetic `$((…))`
 * form. `null` means refuse, which is the pre-existing behavior for all of them.
 */
function liftSubstitutions(command: string): { outer: string; bodies: string[] } | null {
  if (command.includes('`')) return null;
  const bodies: string[] = [];
  let outer = command;
  for (let i = 0; i < MAX_SUBSTITUTIONS && outer.includes('$('); i += 1) {
    const match = /\$\(([^()]*)\)/.exec(outer);
    if (match === null) return null; // `$((…))` or unbalanced — unreadable.
    bodies.push(match[1]!);
    outer = outer.slice(0, match.index) + SUBSTITUTION_PLACEHOLDER + outer.slice(match.index + match[0].length);
  }
  return outer.includes('$(') ? null : { outer, bodies };
}

/**
 * The `auto-bash` rung: a bash command every segment of which is free of the
 * hazard tables above.
 *
 * The raw-newline refusal is carried over from the prove-it-safe tier and stays
 * absolute: a newline inside quotes survives the splitter, and under
 * allow-unless-hazardous an unread line is a full bypass of every table above
 * rather than merely a missed allow.
 *
 * {@link hasStructuralRefusal}'s two halves are now handled separately, because
 * measurement showed they were refusing for very different reasons:
 *
 *  - REDIRECTION was refusing overwhelmingly on `2>/dev/null`, which vets
 *    nothing. {@link stripBenignRedirects} removes exactly the discard and
 *    duplication forms; every real redirection still refuses.
 *  - COMMAND SUBSTITUTION was refused because it "hides a command no table can
 *    see". That premise holds only while the command stays hidden — so instead
 *    of refusing the shape, each `$(…)` body is lifted out and put through THIS
 *    SAME function recursively. A body that clears every hazard table is not
 *    hidden, and one that cannot be read (a backtick, `$((…))`) still refuses.
 *
 * The load-bearing guard on that second relaxation: a substitution in PROGRAM
 * position still refuses unconditionally. `$(echo rm) -rf ~` runs whatever the
 * substitution returns, so judging the body says nothing about what executes —
 * only a substitution used as a VALUE is judged by its body.
 */
export function isAutoModeAllowedBashCommand(rawCommand: string): boolean {
  const command = rawCommand.trim();
  if (command.length === 0) return false;
  if (/[\r\n]/.test(command)) return false;

  const lifted = liftSubstitutions(command);
  if (lifted === null) return false;

  const segments = splitShellSegments(lifted.outer);
  if (segments.length === 0) return false;

  const segmentAllowed = (segment: string): boolean => {
    const readable = stripBenignRedirects(segment);
    if (hasStructuralRefusal(readable)) return false;
    // A substitution that decides WHAT RUNS is never judged by its body.
    const programToken = resolveProgramToken(tokenizeSegment(readable));
    if (programToken !== null && programToken.includes(SUBSTITUTION_PLACEHOLDER)) return false;
    return !isAutoModeHazardousSegment(readable);
  };

  if (!segments.every(segmentAllowed)) return false;
  // Every lifted body must clear the same bar on its own.
  return lifted.bodies.every((body) => isAutoModeAllowedBashCommand(body));
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/** Why a call was allowed locally — carried for the debug log, not the model. */
export type OmpGateAllowRule =
  | 'cyboflow-mcp'
  | 'dont-ask'
  | 'auto-allow-tool'
  /** `hub` proven coordination-only by its arguments ({@link isCoordinationHubCall}). */
  | 'hub-coordination'
  | 'edit-tool'
  | 'safe-bash'
  | 'allow-rule'
  /** `auto` mode's allow-unless-hazardous tool tier. */
  | 'auto-tool'
  /** `auto` mode's allow-unless-hazardous bash tier. */
  | 'auto-bash'
  /** OMP's `xd://mcp__*` dispatch wrapper, decided by its target ({@link xdMcpDispatchTarget}). */
  | 'xd-mcp-dispatch';

export type OmpGateDecision =
  | { kind: 'allow'; rule: OmpGateAllowRule }
  | { kind: 'block'; reason: string }
  | { kind: 'ask' };

/**
 * True when the tool is served by cyboflow's own MCP server.
 *
 * EXACT MEMBERSHIP IS THE ONLY AUTO-ALLOW PATH. There is deliberately no
 * `mcp__cyboflow_` prefix heuristic: OMP auto-imports the user's foreign MCP
 * configs, and a server named `cyboflow-extra` sanitizes to `cyboflow_extra`
 * (`mcp/tool-bridge.ts:335-343`), so its tools arrive as `mcp__cyboflow_extra_*`
 * — names a prefix test accepts. Since this gate is the sole policy engine and
 * the manager's bridge auto-approves OMP's redundant prompt for anything the
 * gate passes, a prefix match is a full auto-approval of a foreign server's
 * tools with no human in the loop.
 *
 * So an absent, empty, or malformed `exactNames` auto-allows NO MCP tool. That
 * is not a breakage: an undecidable MCP call simply falls through to the
 * ordinary decision ladder and reaches the human like any other tool.
 *
 * @param exactNames the composed names from `cyboflowMcpToolNames`. Required
 *   (though it may be `undefined`) so no callsite can forget the list and
 *   silently reopen a name-shaped allowance.
 */
export function isCyboflowMcpTool(
  toolName: string,
  exactNames: readonly string[] | undefined,
): boolean {
  return exactNames !== undefined && exactNames.includes(toolName);
}

/**
 * True when any string anywhere in a tool call's arguments names a URI-scheme
 * target — see {@link URI_SCHEME_TARGET} for why the gate treats that as
 * disqualifying.
 *
 * Recursive over arrays and nested objects, because a target can arrive one
 * level down (`{ files: [{ path: 'ssh://host/x' }] }`) and a top-level-only scan
 * would miss it. Object identity is tracked so a cyclic input (which JSON cannot
 * produce, but a foreign runtime could hand us) terminates instead of hanging
 * the handler inside OMP's 30s cap.
 *
 * `skipKeys` names the argument keys whose VALUE is authored file text rather
 * than a target — see {@link FILE_BODY_KEYS_BY_TOOL}. It is matched at every
 * depth (`ast_edit`'s live inside an `ops` array) and only ever suppresses the
 * value: the key's siblings, including the tool's real target, still scan.
 */
export function hasUriSchemeTarget(
  input: Record<string, unknown>,
  skipKeys?: ReadonlySet<string>,
): boolean {
  return scanForUriScheme(input, new Set<object>(), skipKeys);
}

function scanForUriScheme(
  value: unknown,
  seen: Set<object>,
  skipKeys: ReadonlySet<string> | undefined,
): boolean {
  if (typeof value === 'string') return URI_SCHEME_TARGET.test(value);
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((member) => scanForUriScheme(member, seen, skipKeys));
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, member]) => skipKeys?.has(key) !== true && scanForUriScheme(member, seen, skipKeys),
  );
}

/**
 * OMP's internal tool-dispatch scheme.
 *
 * OMP does not call an MCP tool directly: it dispatches through a pseudo-path,
 * so `mcp__fal_ai_search_models({query})` arrives at this gate as
 * `write({ path: 'xd://mcp__fal_ai_search_models', content: '{"query":…}' })`
 * and the real call follows a beat later under its own name.
 */
const XD_DISPATCH_PREFIX = 'xd://';

/**
 * An `xd://` target that is EXACTLY one MCP tool name — no slash, dot, query or
 * fragment. A remainder of any other shape is not a shape this gate has
 * verified, so it gets today's behaviour (the scheme scan disqualifies it and it
 * reaches the human).
 */
const XD_MCP_TARGET = /^mcp__[A-Za-z0-9_]+$/;

/**
 * The MCP tool an `xd://` dispatch wrapper targets, or `null` when the call is
 * not one.
 *
 * WHY THE WRAPPER IS NOT THE DECISION POINT (the defect this closes). Every
 * auto-allow rung is narrowed by {@link hasUriSchemeTarget}, and `xd://` is a
 * URI scheme, so before this existed EVERY MCP call cost the human TWO
 * approvals: one for the wrapper (a `write` to an opaque URI, which is what the
 * review card showed) and one for the real call. Measured live on 2026-08-23 in
 * an `auto` session: 11 of 21 escalations were wrappers.
 *
 * Worse, the duplication defeated rule 3. A dispatch of cyboflow's OWN MCP tool
 * escalated, because at the wrapper the tool name is `write`, not
 * `mcp__cyboflow_*`. The same run's log carries both halves —
 * `allowed \`mcp__cyboflow_list_workflows\` (cyboflow-mcp)` next to a human
 * approval for the `write` that carried it.
 *
 * WHY ALLOWING THE WRAPPER COSTS NOTHING. The target is gated independently,
 * under its true name, with its real arguments — that is what the log line
 * above proves — so the wrapper decides nothing the target does not decide
 * again with full fidelity: `disallowedTools`, rule 3, and
 * {@link isAutoModeAllowedTool}'s blanket `mcp__*` refusal all still apply
 * there. What changes is only that the human is asked ONCE, at the gate that
 * can name the tool they are being asked about.
 *
 * SCOPED TO `mcp__` TARGETS, deliberately. Re-gating of the target is a
 * property this gate has OBSERVED for the MCP path and for no other. An
 * `xd://` dispatch of anything else keeps the unnarrowed behaviour, because
 * "we have no reason to think it is re-gated" is not evidence that it is.
 */
function xdMcpDispatchTarget(input: Record<string, unknown>): string | null {
  const target = input['path'];
  if (typeof target !== 'string' || !target.startsWith(XD_DISPATCH_PREFIX)) return null;
  const name = target.slice(XD_DISPATCH_PREFIX.length);
  return XD_MCP_TARGET.test(name) ? name : null;
}

/**
 * Apply cyboflow's predicate to one tool call. Pure — the socket round-trip
 * lives in {@link requestSocketDecision}, driven by an `'ask'` result.
 *
 * Rule order is load-bearing:
 *  1. `disallowedTools` — refused in EVERY mode, `dontAsk` included.
 *  2. OMP's `task` subagent tool when `denyTaskTool` — likewise mode-independent.
 *  3. cyboflow's own MCP tools, by EXACT name — always allowed (our tools, our
 *     server, reached through our own socket).
 *  4. `dontAsk` — allow (log-only), rules 1-2 having already applied.
 *  4b. OMP's `xd://mcp__*` dispatch wrapper — decided by the tool it targets,
 *     because the target is gated again under its own name
 *     ({@link xdMcpDispatchTarget}).
 *  5. the mode-scoped allowlists, each narrowed by {@link hasUriSchemeTarget}:
 *     `auto`'s allow-unless-hazardous tier ({@link isAutoModeAllowedTool} /
 *     {@link isAutoModeAllowedBashCommand}), then `autoAllowTools`, `editTools`,
 *     the argument-aware `safe-bash` rung ({@link isGateSafeBashCommand}), and
 *     `allowRules`.
 *  6. otherwise: ask the human.
 */
export function decideToolCall(
  event: Pick<OmpToolCallEvent, 'toolName' | 'input'>,
  config: OmpGateConfig,
): OmpGateDecision {
  const { toolName, input } = event;

  // 1. Explicitly disallowed — mode-independent.
  if (config.disallowedTools.includes(toolName)) {
    return {
      kind: 'block',
      reason:
        `cyboflow blocked \`${toolName}\`: it is listed in this run's disallowedTools. ` +
        'Use a different tool, or ask the user to change the run configuration.',
    };
  }

  // 2. Subagent dispatch — mode-independent while hook scope inside OMP
  //    subagents is unverified.
  if (toolName.toLowerCase() === OMP_TASK_TOOL_NAME && config.denyTaskTool) {
    return {
      kind: 'block',
      reason:
        `cyboflow blocked \`${toolName}\`: subagent hook scope is unverified, so cyboflow ` +
        'cannot gate tool calls made inside an OMP subagent. Do the work in this session.',
    };
  }

  // 3. cyboflow's own MCP tools.
  if (isCyboflowMcpTool(toolName, config.cyboflowMcpToolNames)) {
    return { kind: 'allow', rule: 'cyboflow-mcp' };
  }

  // 4. dontAsk — log-only.
  if (config.permissionMode === 'dontAsk') {
    return { kind: 'allow', rule: 'dont-ask' };
  }

  // 4b. An `xd://mcp__*` dispatch wrapper is not a decision point — the tool it
  //     targets is, and OMP gates that separately under its own name. Deciding
  //     the wrapper by the target collapses the double-approval, and keeps a
  //     BLOCK at the earliest gate so the model learns immediately instead of
  //     after a human has already approved the wrapper.
  //
  //     The recursion terminates in one step: the target's input is `{}`, which
  //     carries no `path`, so it cannot itself be a dispatch. `{}` is the honest
  //     input, too — the wrapper's `content` is the target's arguments in
  //     SERIALISED form, and a decision taken on a hand-parsed copy of them
  //     could disagree with the one taken on the real call. Nothing is lost by
  //     leaving them out: the only verdict consumed here is `block`, which no
  //     argument can produce.
  const dispatchTarget = xdMcpDispatchTarget(input);
  if (dispatchTarget !== null) {
    const targetDecision = decideToolCall({ toolName: dispatchTarget, input: {} }, config);
    if (targetDecision.kind === 'block') return targetDecision;
    return { kind: 'allow', rule: 'xd-mcp-dispatch' };
  }

  // 5. Mode-scoped allowlists — every one of them NARROWED by the argument scan.
  //
  // The invariant, stated once and applied without carve-outs: NO auto-allow
  // path passes a call whose arguments name a URI-scheme TARGET. All three
  // paths below decide on a tool NAME (or, for `allowRules`, on a name plus a
  // bash-command specifier), and a name cannot express that OMP's own `read` /
  // `grep` escalate themselves to remote exec-tier operations on an `ssh://`
  // path (read.ts:401, grep.ts:906). A scheme in the arguments therefore
  // disqualifies the shortcut and the call falls through to rule 6.
  //
  // TARGET is the load-bearing word, and it is not a carve-out: the scan skips
  // the argument keys that carry AUTHORED FILE TEXT
  // ({@link FILE_BODY_KEYS_BY_TOOL}), because a file's cargo is not its
  // destination and no escalation follows from it. Every target key — `path`,
  // `paths`, and anything a future OMP adds — still scans.
  //
  // This DOES reach `Bash(...)` allow rules whose command carries a URL — an
  // `auto`-mode rule like `Bash(curl https://api.example.com:*)` now asks the
  // human. That is the deliberate cost of a rule with no exceptions: a carve-out
  // for "argument-aware rules" is exactly where the next bypass would live, and
  // erring toward the human is the safe direction.
  //
  // Rules 1-4 are untouched: a disallowed tool and the `task` tool still block
  // first, `dontAsk` still allows first (log-only is log-only), and our own MCP
  // tools are not narrowed — they are exact-name matched, served by cyboflow's
  // own server, and routinely carry URLs in finding bodies and artifact payloads.
  const remoteTarget = hasUriSchemeTarget(input, fileBodyKeysFor(toolName));

  if (!remoteTarget) {
    if (config.autoAllowTools.includes(toolName)) {
      return { kind: 'allow', rule: 'auto-allow-tool' };
    }
    // The argument-aware `hub` rung, at the same tier as the read-safe names
    // above because a coordination op reaches less far than a file read does.
    // Name matched EXACTLY, like the bash rung: an unfamiliar casing is a tool
    // this gate has not verified.
    if (toolName === OMP_HUB_TOOL_NAME && isCoordinationHubCall(input)) {
      return { kind: 'allow', rule: 'hub-coordination' };
    }
    if (
      (config.permissionMode === 'acceptEdits' || config.permissionMode === 'auto') &&
      config.editTools.includes(toolName)
    ) {
      return { kind: 'allow', rule: 'edit-tool' };
    }
    // The argument-aware bash rung. Name matched EXACTLY ('bash' is OMP's
    // canonical name, `tools/builtin-names.ts:1-31`): a differently-cased name is
    // one this gate has not verified, and falling through to the human is the
    // fail-closed direction for an auto-allow path.
    if (
      (config.permissionMode === 'acceptEdits' || config.permissionMode === 'auto') &&
      toolName === OMP_BASH_TOOL_NAME &&
      typeof input['command'] === 'string' &&
      isGateSafeBashCommand(input['command'])
    ) {
      return { kind: 'allow', rule: 'safe-bash' };
    }
    if (config.permissionMode === 'auto' && matchesAllowRules(toolName, input, config.allowRules)) {
      return { kind: 'allow', rule: 'allow-rule' };
    }
    // `auto`'s allow-unless-hazardous tier, LAST among the allow paths so the
    // narrower rungs above keep their own rule labels — a call they already
    // vouch for should be logged as `safe-bash` or `edit-tool`, not as the
    // catch-all. What this adds is everything they cannot vouch for and that is
    // not on a hazard table: the ordinary build command (`pnpm test`, `mkdir -p`,
    // `node scripts/x.mjs`) and the ordinary OMP builtin. See the tier's doc block.
    if (config.permissionMode === 'auto') {
      // A tool carrying a `command` string RUNS something, so it is classified
      // as a command, never allowed by name. Only OMP's exact canonical `bash`
      // is classified: a differently-cased or unfamiliar runner (`Bash`,
      // `shell`) is one this gate has not verified — it may not even read
      // `command` the same way — so it falls through to the human, matching the
      // `safe-bash` rung's own exact-name discipline.
      const carriesCommand = typeof input['command'] === 'string';
      // `hub` is argument-classified, never name-classified — and the rung that
      // does it already ran above. Reaching here means the call was NOT
      // coordination-only, i.e. it is `start`/`stop`/`restart`/`cancel` or a
      // `send` that drives a process's stdin. Allowing that by name (which is
      // what happened before this branch existed, since `hub` is not a hazard
      // tool and carries no `command` key) would let `auto` launch an arbitrary
      // `application` without a human ever seeing it.
      if (toolName === OMP_HUB_TOOL_NAME) {
        return { kind: 'ask' };
      }
      if (toolName === OMP_BASH_TOOL_NAME) {
        if (carriesCommand && isAutoModeAllowedBashCommand(input['command'] as string)) {
          return { kind: 'allow', rule: 'auto-bash' };
        }
      } else if (!carriesCommand && isAutoModeAllowedTool(toolName)) {
        return { kind: 'allow', rule: 'auto-tool' };
      }
    }
  }

  // 6. Undecidable locally.
  return { kind: 'ask' };
}

// ---------------------------------------------------------------------------
// The orchestrator socket round-trip
// ---------------------------------------------------------------------------

/**
 * A verdict read off the orchestrator socket.
 *
 * `'timeout'` is NOT an error: the orchestrator was reachable and the request
 * was delivered, but no human answered inside {@link HUMAN_DECISION_BUDGET_MS}.
 * It resolves (as a block upstream) rather than rejecting, precisely so it stays
 * distinguishable from an orchestrator-down failure, which throws.
 */
export interface OmpGateSocketVerdict {
  decision: 'allow' | 'deny' | 'timeout';
  reason?: string;
}

/**
 * OMP's canonical tool names → Claude's, for the shell-approval frame ONLY.
 *
 * The server side of this socket is shared with the interactive-Claude shell
 * hook and matches CLAUDE-CASED names: `handleShellApprovalRequest`
 * (`main/src/orchestrator/mcpServer/mcpQueryHandler.ts`) feeds `msg.toolName`
 * to `isAcceptEditsAutoApprovable` (`orchestrator/permissionModeMapper.ts`) and
 * to `isToolAllowed` against the run's `permissions.allow` rules, both of which
 * compare against `Bash` / `Read` / `Write` / … Sending OMP's lowercase `bash`
 * means neither the acceptEdits fast-path nor any permission rule can EVER fire
 * for an OMP call, so every such call lands on a human.
 *
 * `fetch`/`web_search`/`todo` map to the Claude names with the same semantics
 * (`WebFetch`/`WebSearch`/`TodoWrite`) so a rule written once covers both
 * providers.
 */
const OMP_TO_CLAUDE_TOOL_NAMES: ReadonlyMap<string, string> = new Map([
  ['bash', 'Bash'],
  ['read', 'Read'],
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['glob', 'Glob'],
  ['grep', 'Grep'],
  ['fetch', 'WebFetch'],
  ['web_search', 'WebSearch'],
  ['todo', 'TodoWrite'],
]);

/**
 * Canonicalize an OMP tool name for the orchestrator frame.
 *
 * MCP names pass through untouched — `mcp__server_tool` is already the shared
 * cross-provider spelling, and rewriting one would break the server's own
 * matching. So does anything unmapped: an OMP-only tool has no Claude
 * counterpart, and inventing a name would be policy nobody can cite. Both
 * pass-throughs are conservative — an unrecognized name simply fails to match a
 * fast-path or a rule and reaches the human, which is where it started.
 */
export function canonicalToolNameForOrchestrator(toolName: string): string {
  if (toolName.startsWith('mcp__')) return toolName;
  return OMP_TO_CLAUDE_TOOL_NAMES.get(toolName) ?? toolName;
}

/** Socket factory, injectable so tests can drive a stub. */
export type OmpGateConnect = (socketPath: string) => net.Socket;

export interface OmpGateSocketOptions {
  socketPath: string;
  runId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  logger: OmpGateLogger;
  connect?: OmpGateConnect;
  /** Registry of live sockets, destroyed on `session_shutdown`. */
  inFlight?: Set<net.Socket>;
  /** Human-decision budget; defaults to {@link HUMAN_DECISION_BUDGET_MS}. */
  budgetMs?: number;
}

/**
 * Ask the orchestrator and block until it answers.
 *
 * The frame carries the CLAUDE-CASED tool name
 * ({@link canonicalToolNameForOrchestrator}); the server's acceptEdits fast-path
 * and permission-rule matching are name-cased and would otherwise never fire.
 *
 * REJECTS (which OMP converts into a block — see this file's header, layer 1)
 * on every LIVENESS failure: connection error, close before a verdict, an
 * `ok:false` frame, or a correlated frame carrying no recognizable decision.
 *
 * RESOLVES with `'timeout'` when the orchestrator stayed connected but no human
 * answered within the budget. The socket is DESTROYED rather than ended so the
 * orchestrator observes a disconnect and can settle its own pending approval,
 * instead of holding a socket whose reader is gone.
 *
 * The reject/resolve split is the whole point: "orchestrator is down" and
 * "nobody answered yet" are different failures and must stay separable — the
 * invariant preToolUseShellHook.ts:1-40 establishes. What has changed since
 * that hook is only that we can no longer wait forever, because OMP kills the
 * handler at 30s (see this file's header).
 */
export function requestSocketDecision(opts: OmpGateSocketOptions): Promise<OmpGateSocketVerdict> {
  const { socketPath, runId, toolName, toolInput, logger } = opts;
  const connect = opts.connect ?? ((p: string) => net.createConnection(p));

  const requestId = `omp-gate-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  return new Promise<OmpGateSocketVerdict>((resolve, reject) => {
    let settled = false;
    const socket = connect(socketPath);
    opts.inFlight?.add(socket);

    /**
     * @param close 'destroy' on budget expiry — an abrupt disconnect is the
     *   signal that tells the orchestrator to stop holding this approval open.
     *   'end' everywhere else, which is the graceful half-close.
     */
    const settle = (fn: () => void, close: 'end' | 'destroy' = 'end'): void => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      opts.inFlight?.delete(socket);
      try {
        if (close === 'destroy') socket.destroy();
        else socket.end();
      } catch {
        // best-effort close
      }
      fn();
    };

    const budgetMs = opts.budgetMs ?? HUMAN_DECISION_BUDGET_MS;
    const budgetTimer = setTimeout(() => {
      logger.warn(
        `no decision for \`${toolName}\` within ${budgetMs}ms — blocking (OMP would abort us at 30s regardless)`,
      );
      settle(() => resolve({ decision: 'timeout' }), 'destroy');
    }, budgetMs);
    // Never hold the process open on this timer alone.
    budgetTimer.unref?.();

    socket.on('connect', () => {
      logger.debug(`connected to the orchestrator for \`${toolName}\` (run ${runId})`);
      socket.write(
        JSON.stringify({
          type: 'shell-approval-request',
          requestId,
          runId,
          // Tells the server this is the OMP lane, where a socket that dies
          // before a verdict is a BUDGET EXPIRY, not a dead requester — see
          // `OmpGateApprovalRequest.substrate`.
          substrate: 'omp',
          // Claude-cased on the wire; the local logs keep OMP's own name so a
          // stderr line still matches what the model asked for.
          toolName: canonicalToolNameForOrchestrator(toolName),
          // Unchanged: OMP's bash input is `{ command: string }` — the same key
          // the server's classifiers and Bash(...) rules read.
          toolInput,
        }) + '\n',
      );
    });

    // Rolling receive buffer — a stream socket can split one JSON frame across
    // 'data' events or batch several into one.
    let recvBuffer = '';
    socket.on('data', (buf: Buffer) => {
      recvBuffer += buf.toString('utf8');
      let nl: number;
      while ((nl = recvBuffer.indexOf('\n')) !== -1) {
        const raw = recvBuffer.slice(0, nl).trim();
        recvBuffer = recvBuffer.slice(nl + 1);
        if (raw.length === 0) continue;

        let msg: OmpGateApprovalResponse;
        try {
          msg = JSON.parse(raw) as OmpGateApprovalResponse;
        } catch {
          // A stray unparseable frame must not kill the gate; keep reading.
          logger.warn('ignored an unparseable frame from the orchestrator');
          continue;
        }
        if (msg.requestId !== requestId) continue;

        const verdict = msg.ok === true ? msg.data?.permissionDecision : undefined;
        if (verdict === 'allow' || verdict === 'deny') {
          const reason = msg.data?.permissionDecisionReason;
          settle(() => resolve(reason === undefined ? { decision: verdict } : { decision: verdict, reason }));
          return;
        }
        settle(() =>
          reject(
            new Error(
              'cyboflow orchestrator returned a malformed approval verdict — failing closed',
            ),
          ),
        );
        return;
      }
    });

    socket.on('error', (err: Error) => {
      settle(() =>
        reject(new Error(`cyboflow orchestrator unreachable (${err.message}) — failing closed`)),
      );
    });
    socket.on('close', () => {
      settle(() =>
        reject(
          new Error('cyboflow orchestrator closed the connection before a decision — failing closed'),
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// The load sentinel
// ---------------------------------------------------------------------------

/**
 * Stamp the load sentinel — the manager's fail-closed handshake. Its ABSENCE is
 * the signal (no sentinel ⇒ the gate never loaded ⇒ refuse the session), so a
 * failed write must leave no file behind rather than write a partial one.
 *
 * @returns true when the sentinel now exists on disk.
 */
export function writeGateSentinel(
  sentinelPath: string | undefined,
  runId: string,
  logger: OmpGateLogger,
  writeFile: (p: string, data: string) => void = (p, data) => fs.writeFileSync(p, data, 'utf8'),
): boolean {
  if (sentinelPath === undefined || sentinelPath.trim().length === 0) {
    logger.warn(`${ENV_GATE_SENTINEL} is unset — the manager cannot confirm the gate loaded`);
    return false;
  }
  const sentinel: OmpGateSentinel = {
    loadedAt: new Date().toISOString(),
    runId,
    pid: process.pid,
  };
  try {
    writeFile(sentinelPath, JSON.stringify(sentinel));
    return true;
  } catch (err) {
    logger.error(
      `failed to write the load sentinel at ${sentinelPath} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
    return false;
  }
}

// ---------------------------------------------------------------------------
// Handler assembly
// ---------------------------------------------------------------------------

export interface OmpGateRuntime {
  config: OmpGateConfig;
  runId: string;
  socketPath: string | undefined;
  logger: OmpGateLogger;
  connect?: OmpGateConnect;
  inFlight: Set<net.Socket>;
  /** Human-decision budget override; production leaves it unset. */
  budgetMs?: number;
}

/**
 * Build the `tool_call` handler for a resolved runtime.
 *
 * Returning `undefined` means "no opinion" — OMP proceeds to its own approval
 * gate, which cyboflow's spawn keeps at `always-ask`; the `ompApprovalBridge`
 * auto-approves the now-redundant prompt for calls this gate passed
 * (docs/proposals §5.3). Returning `{ block, reason }` stops the call before
 * that prompt is ever raised.
 */
export function createToolCallHandler(
  runtime: OmpGateRuntime,
): (event: OmpToolCallEvent) => Promise<OmpToolCallEventResult | undefined> {
  return async (event: OmpToolCallEvent): Promise<OmpToolCallEventResult | undefined> => {
    const { config, logger } = runtime;
    const decision = decideToolCall(event, config);

    if (decision.kind === 'block') {
      logger.debug(`blocked \`${event.toolName}\`: ${decision.reason}`);
      return { block: true, reason: decision.reason };
    }
    if (decision.kind === 'allow') {
      logger.debug(`allowed \`${event.toolName}\` (${decision.rule})`);
      return undefined;
    }

    // Undecidable locally — ask the human. A missing socket path means cyboflow
    // never wired the gate; there is nobody to ask, so fail closed by throwing
    // (OMP turns the throw into a block, per this file's header).
    if (runtime.socketPath === undefined || runtime.socketPath.trim().length === 0) {
      throw new Error(
        `cyboflow cannot gate \`${event.toolName}\`: ${ENV_ORCH_SOCKET} is unset — failing closed`,
      );
    }

    const verdict = await requestSocketDecision({
      socketPath: runtime.socketPath,
      runId: runtime.runId,
      toolName: event.toolName,
      toolInput: event.input,
      logger,
      ...(runtime.connect ? { connect: runtime.connect } : {}),
      // Precedence: an explicit test override, then the host-configured budget,
      // then `HUMAN_DECISION_BUDGET_MS` inside requestSocketDecision.
      ...(runtime.budgetMs !== undefined
        ? { budgetMs: runtime.budgetMs }
        : config.humanDecisionBudgetMs !== undefined
          ? { budgetMs: config.humanDecisionBudgetMs }
          : {}),
      inFlight: runtime.inFlight,
    });

    if (verdict.decision === 'allow') {
      logger.debug(`allowed \`${event.toolName}\` (human approval)`);
      return undefined;
    }
    if (verdict.decision === 'timeout') {
      return {
        block: true,
        reason:
          `cyboflow surfaced \`${event.toolName}\` to the human for approval, but no decision ` +
          `arrived within ${Math.round(HUMAN_DECISION_BUDGET_MS / 1000)}s (OMP caps gate handlers ` +
          'at 30s, so cyboflow cannot wait longer). THE REQUEST IS STILL OPEN in the human\'s ' +
          'review queue — it was not denied. Retrying this exact call is how you collect their ' +
          'answer: the retry re-attaches to the same pending request, and once they decide it is ' +
          'allowed through immediately. Do other work first if you have any, then retry.',
      };
    }
    return {
      block: true,
      reason:
        verdict.reason !== undefined && verdict.reason.length > 0
          ? `cyboflow denied \`${event.toolName}\`: ${verdict.reason}`
          : `cyboflow denied \`${event.toolName}\`.`,
    };
  };
}

/** Resolve the runtime from a process environment. Exported for tests. */
export function resolveGateRuntime(
  env: NodeJS.ProcessEnv,
  logger: OmpGateLogger = stderrLogger,
): OmpGateRuntime {
  return {
    config: parseGateConfig(env[ENV_GATE_CONFIG], logger),
    runId: env[ENV_RUN_ID] ?? '',
    socketPath: env[ENV_ORCH_SOCKET],
    logger,
    inFlight: new Set<net.Socket>(),
  };
}

// ---------------------------------------------------------------------------
// The extension factory (OMP's default export contract)
// ---------------------------------------------------------------------------

/**
 * OMP's `-e` entry point: a default-exported factory run at import time
 * (`extensibility/extensions/loader.ts:55-59`).
 *
 * Handler registration happens FIRST and the sentinel is written second, so a
 * sentinel failure can never leave a loaded-but-ungated session: either the
 * gate is installed and the sentinel proves it, or the sentinel is missing and
 * the manager refuses the session.
 *
 * Only registration is legal during load — runtime action methods throw
 * `ExtensionRuntimeNotInitializedError` (`docs/extensions.md:62-66`). Writing a
 * file is not such an action.
 */
export default function cyboflowOmpGate(pi: OmpExtensionApi): void {
  // Stamped per LOAD, not per process: a second instance in the same pid means
  // a second agent (a subagent's extension runner), and without the ordinal the
  // two are unreadable in a shared stderr stream.
  gateInstanceSeq += 1;
  const logger = makeStderrLogger(`p${process.pid}#${gateInstanceSeq}`);
  const runtime = resolveGateRuntime(process.env, logger);

  pi.setLabel?.('cyboflow gate');
  pi.on('tool_call', createToolCallHandler(runtime));

  // Destroy any approval socket still blocked when the session ends. OMP may
  // have abandoned the handler at its 30s cap while the orchestrator still
  // holds the connection open; without this the socket outlives the session.
  pi.on('session_shutdown', () => {
    for (const socket of runtime.inFlight) {
      try {
        socket.destroy();
      } catch {
        // best-effort teardown
      }
    }
    runtime.inFlight.clear();
  });

  writeGateSentinel(process.env[ENV_GATE_SENTINEL], runtime.runId, logger);
}
