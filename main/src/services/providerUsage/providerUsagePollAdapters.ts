/**
 * The concrete provider calls behind {@link ProviderUsagePoller}.
 *
 * Split from the poller so the scheduling logic (single-flight, rate limiting,
 * per-provider isolation) is testable without spawning a CLI, and so the poller
 * itself stays free of SDK and app-server imports.
 *
 * Neither call runs a model turn, and neither spends subscription quota.
 */
import os from 'os';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { loadSdkQuery } from '../../utils/lazyAgentSdk';
import { resolveClaudeExecutablePath } from '../panels/claude/claudeExecutablePath';
import {
  CODEX_EXECUTABLE_VERSION,
  prependCodexPathToEnvironment,
  resolveCodexExecutablePath,
} from '../panels/codex/codexExecutablePath';
import { CodexAppServerClient } from '../panels/codex/appServer/client';
import type { ClaudeUsagePoll } from './providerUsageStore';

const CLAUDE_PROBE_TIMEOUT_MS = 15_000;
const CODEX_REQUEST_TIMEOUT_MS = 15_000;

/** The codex JSON-RPC method that answers with the account's live quota. */
export const CODEX_RATE_LIMITS_READ_METHOD = 'account/rateLimits/read';

/**
 * A prompt that never yields, so the CLI initialises into streaming-input mode
 * and then simply waits. Control requests need streaming mode; a turn is never
 * started. Mirrors `claudeModelCatalogService`'s `supportedModels` probe.
 */
// eslint-disable-next-line require-yield -- by design: a held-open prompt that emits no user turn
async function* heldOpenPrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage, void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/** The experimental control method, as the SDK currently names it. */
type UsageCapableQuery = {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: () => Promise<unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow the `/usage` control response. Returns null when the payload is not
 * recognisably the usage shape — the SDK method is explicitly experimental, so a
 * changed shape must degrade to "no poll", not to a wrong number.
 */
export function parseClaudeUsageResponse(value: unknown): ClaudeUsagePoll | null {
  if (!isRecord(value)) return null;
  if (typeof value.rate_limits_available !== 'boolean') return null;
  const rateLimits = value.rate_limits;
  return {
    subscriptionType: typeof value.subscription_type === 'string' ? value.subscription_type : null,
    rateLimitsAvailable: value.rate_limits_available,
    rateLimits: isRecord(rateLimits) ? (rateLimits as ClaudeUsagePoll['rateLimits']) : null,
  };
}

/**
 * Ask Claude for the data behind `/usage`.
 *
 * Returns null — not an error — when the experimental control request is absent.
 * That is a supported outcome: the `rate_limit_event` tap keeps feeding the
 * store, and the UI marks what it produced as possibly stale.
 */
export async function pollClaudeUsage(): Promise<ClaudeUsagePoll | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLAUDE_PROBE_TIMEOUT_MS);
  timer.unref?.();
  try {
    const query = await loadSdkQuery();
    const q = query({
      prompt: heldOpenPrompt(controller.signal),
      options: {
        cwd: os.tmpdir(),
        // Hermetic: no project settings, no MCP — this is a pure account read.
        settingSources: [],
        strictMcpConfig: true,
        mcpServers: {},
        pathToClaudeCodeExecutable: resolveClaudeExecutablePath(),
        abortController: controller,
      },
    });
    const usageMethod = (q as unknown as UsageCapableQuery)
      .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof usageMethod !== 'function') return null;
    return parseClaudeUsageResponse(await usageMethod.call(q));
  } finally {
    clearTimeout(timer);
    // Always tear the held-open session down; the prompt only resolves on abort.
    controller.abort();
  }
}

/**
 * Ask Codex for the account's live rate limits.
 *
 * Spawns a short-lived app-server exactly as the onboarding account probe does,
 * sends one request, and closes. The result carries the same `rateLimits` object
 * the push notification does, so the existing parser reads it unchanged.
 */
export async function pollCodexRateLimits(clientVersion: string): Promise<unknown> {
  const executable = resolveCodexExecutablePath();
  const client = new CodexAppServerClient({
    command: executable.executablePath,
    env: prependCodexPathToEnvironment(process.env, executable.pathDir),
    // A usage poll must be silent about a provider that is merely not signed in.
    onStderr: () => {},
  });

  try {
    client.start();
    const initialized = await client.initialize({
      clientInfo: { name: 'cyboflow', title: 'Cyboflow', version: clientVersion },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    if (!initialized.userAgent.includes(CODEX_EXECUTABLE_VERSION)) {
      throw new Error(
        `Codex app-server protocol mismatch: expected ${CODEX_EXECUTABLE_VERSION}, got ${initialized.userAgent}`,
      );
    }
    return await client.sendRequest<unknown, Record<string, never>>(
      CODEX_RATE_LIMITS_READ_METHOD,
      {},
    );
  } finally {
    await client.stop().catch(() => {
      // Best-effort teardown: a poll must never leave the caller with an error
      // about a process it no longer needs.
    });
  }
}

export { CODEX_REQUEST_TIMEOUT_MS };
