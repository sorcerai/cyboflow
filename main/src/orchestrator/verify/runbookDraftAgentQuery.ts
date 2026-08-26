/**
 * runbookDraftAgentQuery — the SDK boundary for the READ-ONLY runbook-drafting
 * agent (docs/proposals/lane-runbook-bootstrap.md §8).
 *
 * Mirrors `verificationAgentQuery` exactly, and for the same reason: this is the
 * only `@anthropic-ai/claude-agent-sdk` caller on this path (value-loaded lazily
 * through `utils/lazyAgentSdk` so app boot never parses the SDK), which keeps the
 * bootstrap runner itself SDK-free, standalone-typecheckable, and fully fakeable
 * in tests — inject a query fn that returns a canned object and the entire
 * draft→validate→commit→prove sequence runs with no subprocess.
 *
 * THE SANDBOX IS BAKED HERE, NOT PASSED IN. Hermetic settings (`settingSources:
 * []`, `strictMcpConfig: true`, `mcpServers: {}`), the read-only tool ceiling,
 * and the read-only Bash guard all live in this file, so an edited agent prompt
 * cannot widen any of them. That matters more here than on the verification
 * path: this agent surveys the LIVE run worktree that five sibling lanes are
 * writing to, so its ceiling is the only thing standing between a survey and a
 * write.
 *
 * NO Write, NO Edit, NO NotebookEdit — not merely unapproved but ABSENT from
 * `Options.tools`, so they do not exist for this session. §8's whole inversion
 * is that this agent proposes and the controller writes; a tool ceiling that
 * merely discouraged writing would leave the old trust direction intact.
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call).
 */
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { loadSdkQuery } from '../../utils/lazyAgentSdk';
import { resolveClaudeExecutablePath } from '../../services/panels/claude/claudeExecutablePath';
import type { LoggerLike } from '../types';
import { readOnlyCommandDenyMessage, readOnlyCommandRejection } from './readOnlyCommandGuard';
import { RUNG1_OPERATION_KINDS } from './runbookDraft';
import { VERIFY_RUNBOOK_MODALITIES } from '../../../../shared/types/verifyRunbook';

/**
 * The drafting agent's tool ceiling. Read-only by construction — see the module
 * doc on why this is `Options.tools` and not merely `allowedTools`.
 */
export const RUNBOOK_DRAFT_ALLOWED_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'Bash'];

/**
 * Deadline for one drafting deployment. Shorter than a verification's, because
 * this agent only reads: no build, no serve, no driving. The owning lane is
 * parked for the whole bootstrap, so every minute here is a minute a sprint lane
 * is not progressing.
 */
export const RUNBOOK_DRAFT_TIMEOUT_MS = 5 * 60 * 1000;

/** Turn budget: a survey plus the structured answer. */
const RUNBOOK_DRAFT_MAX_TURNS = 40;

/**
 * The JSON schema the SDK enforces on the agent's structured output. It nudges
 * the model toward the §8 contract; `parseRunbookDraftResult` re-validates
 * strictly afterwards and NEVER trusts this schema alone — a schema can require
 * a key, it cannot check that a runbook declares the modality it was asked for
 * or that a command names a script this project has.
 */
export const RUNBOOK_DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true,
  required: ['decision'],
  properties: {
    decision: { type: 'string', enum: ['runbook', 'not-possible'] },
    // Required in prose (and enforced by the parser) on a not-possible draft;
    // not listed in `required` here because the schema cannot express "required
    // only when decision is not-possible".
    reason: { type: 'string' },
    modality: { type: 'string', enum: [...VERIFY_RUNBOOK_MODALITIES] },
    notes: { type: 'string' },
    runbook: {
      type: 'object',
      additionalProperties: true,
      required: ['version', 'modalities'],
      properties: {
        version: { type: 'integer', enum: [1] },
        modalities: { type: 'object', additionalProperties: true },
        levers: { type: 'object', additionalProperties: true },
      },
    },
    operation: {
      type: 'object',
      additionalProperties: true,
      required: ['kind'],
      properties: {
        kind: { type: 'string', enum: [...RUNG1_OPERATION_KINDS] },
        scriptName: { type: 'string' },
        command: { type: 'string' },
        file: { type: 'string' },
        port: { type: 'integer' },
        envVar: { type: 'string' },
        setting: { type: 'string' },
      },
    },
  },
};

/** What the runner hands one deployment. */
export interface RunbookDraftQueryArgs {
  prompt: string;
  systemPrompt: string;
  /** The run's live worktree — the tree being surveyed. */
  cwd: string;
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The injectable seam: raw structured output, or null when the stream drained without one. */
export type RunbookDraftQueryFn = (args: RunbookDraftQueryArgs) => Promise<unknown>;

/**
 * The read-only `canUseTool` handler.
 *
 * DEFAULT-DENY for anything outside {@link RUNBOOK_DRAFT_ALLOWED_TOOLS}, and the
 * allowlist guard for `Bash`. The `updatedInput` echo on the allow branch is
 * MANDATORY — the CLI Zod-validates the can_use_tool control response and a bare
 * `{ behavior: 'allow' }` fails as `invalid_union`, reaching the model as an
 * error tool_result rather than an approval (the same footgun documented on
 * `makeDependencyCommandCanUseTool`).
 *
 * `interrupt` is deliberately NOT set on deny: a denied command should leave the
 * agent surveying by other means, or concluding `NOT-POSSIBLE`, rather than
 * ending the deployment.
 */
export function makeRunbookDraftCanUseTool(logger?: LoggerLike): CanUseTool {
  return async (toolName, input) => {
    if (!RUNBOOK_DRAFT_ALLOWED_TOOLS.includes(toolName)) {
      logger?.warn('[runbookDraftAgentQuery] denied a tool outside the read-only set', { toolName });
      return {
        behavior: 'deny',
        message:
          `The '${toolName}' tool is not available to the runbook-drafting agent. Use only: ` +
          `${RUNBOOK_DRAFT_ALLOWED_TOOLS.join(', ')}. You SURVEY this project and return a proposal; ` +
          'the harness writes every file.',
      };
    }
    if (toolName !== 'Bash') return { behavior: 'allow', updatedInput: input };

    const command = input.command;
    if (typeof command !== 'string') return { behavior: 'allow', updatedInput: input };
    const rejection = readOnlyCommandRejection(command);
    if (rejection !== null) {
      logger?.debug('[runbookDraftAgentQuery] denied a non-read-only Bash command', { command, rejection });
      return { behavior: 'deny', message: readOnlyCommandDenyMessage(command, rejection) };
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

/**
 * Build the production `RunbookDraftQueryFn`. Deploys ONE structured session and
 * returns the last `structured_output`.
 *
 * Errors and timeouts resolve to `null` rather than throwing: the runner treats
 * an unusable draft as a decline, and there is nothing a throw would let it do
 * that a null does not — while a throw crossing the enqueue seam is exactly what
 * that seam's never-throws contract forbids.
 */
export function makeRunbookDraftQuery(
  logger?: LoggerLike,
  timeoutMs: number = RUNBOOK_DRAFT_TIMEOUT_MS,
): RunbookDraftQueryFn {
  return async ({ prompt, systemPrompt, cwd, model, timeoutMs: requestTimeoutMs, signal }) => {
    const effectiveTimeoutMs = requestTimeoutMs ?? timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, effectiveTimeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    const onAbort = (): void => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const query = await loadSdkQuery();
      const q = query({
        prompt,
        options: {
          cwd,
          ...(model ? { model } : {}),
          systemPrompt,
          maxTurns: RUNBOOK_DRAFT_MAX_TURNS,
          // HARD availability ceiling — Write/Edit do not exist for this session.
          tools: [...RUNBOOK_DRAFT_ALLOWED_TOOLS],
          // Auto-approve the read tools; 'Bash' is EXCLUDED so every shell call
          // routes through the guard (an allowedTools entry is auto-approved
          // WITHOUT consulting canUseTool — SDK contract).
          allowedTools: RUNBOOK_DRAFT_ALLOWED_TOOLS.filter((t) => t !== 'Bash'),
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          canUseTool: makeRunbookDraftCanUseTool(logger),
          pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
          outputFormat: { type: 'json_schema', schema: RUNBOOK_DRAFT_JSON_SCHEMA },
          abortController: controller,
        },
      });

      let structured: unknown = null;
      for await (const msg of q) {
        if (msg.type === 'result' && msg.subtype === 'success') {
          structured = msg.structured_output ?? null;
        }
      }
      if (timedOut) {
        logger?.warn('[runbookDraftAgentQuery] drafting agent timed out', { timeoutMs: effectiveTimeoutMs });
        return null;
      }
      return structured;
    } catch (err) {
      logger?.warn('[runbookDraftAgentQuery] drafting query failed', {
        error: timedOut ? `timed out after ${effectiveTimeoutMs}ms` : err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}
