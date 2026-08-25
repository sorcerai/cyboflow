/**
 * The `loadSdkQuery` usage tee.
 *
 * This wrapper sits on EVERY Claude SDK call in the app, so the tests here are
 * mostly about what it must not break:
 *   - the `Query` object's control methods (the model catalogue feature-detects
 *     `supportedModels` / `initializationResult`; a plain-generator wrapper would
 *     silently return an empty catalogue forever);
 *   - `for await` finalization on an early `break` (managers and judges both
 *     abandon the loop on abort/deadline, and swallowing that regresses
 *     subprocess teardown);
 *   - the SYNCHRONOUS provider-guard throw.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: (...args: unknown[]) => queryMock(...args) }));

import { loadSdkQuery } from '../lazyAgentSdk';
import {
  _resetProviderUsageStoreForTesting,
  initProviderUsageStore,
} from '../../services/providerUsage/providerUsageStore';
import { setAgentProviderAccessResolver } from '../../services/agentProviderGuard';

const RATE_LIMIT_MESSAGE = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1784995200,
    rateLimitType: 'seven_day',
    utilization: 0.91,
  },
  uuid: 'u',
  session_id: 's',
};

const NOW = 1784_000_000_000;

/** A stand-in Query: an async generator that also carries a control method. */
function makeQuery(messages: unknown[], onReturn?: () => void) {
  const gen = (async function* () {
    try {
      for (const m of messages) yield m;
    } finally {
      onReturn?.();
    }
  })();
  return Object.assign(gen, {
    supportedModels: async () => [{ id: 'claude-opus-5' }],
    interrupt: async () => undefined,
  });
}

function prefs() {
  const map = new Map<string, string>();
  return {
    getUserPreference: (k: string) => map.get(k) ?? null,
    setUserPreference: (k: string, v: string) => { map.set(k, v); },
  };
}

beforeEach(() => {
  queryMock.mockReset();
  _resetProviderUsageStoreForTesting();
});

afterEach(() => {
  _resetProviderUsageStoreForTesting();
  setAgentProviderAccessResolver(() => true);
});

describe('loadSdkQuery usage tee', () => {
  it('routes a rate_limit_event into the provider usage store', async () => {
    const store = initProviderUsageStore(prefs());
    queryMock.mockReturnValue(makeQuery([{ type: 'assistant' }, RATE_LIMIT_MESSAGE]));

    const query = await loadSdkQuery();
    const seen: unknown[] = [];
    for await (const msg of query({ prompt: 'x' } as never)) seen.push(msg);

    // The caller still sees every message unchanged.
    expect(seen).toHaveLength(2);
    const window = store.getState(NOW).claude?.windows[0];
    expect(window?.kind).toBe('claude_seven_day');
    expect(window?.usedPercent).toBeCloseTo(91);
  });

  it('preserves control methods that callers feature-detect', async () => {
    queryMock.mockReturnValue(makeQuery([]));
    const query = await loadSdkQuery();
    const q = query({ prompt: 'x' } as never);

    // claudeModelCatalogService branches on exactly this check.
    expect(typeof (q as unknown as { supportedModels?: unknown }).supportedModels).toBe('function');
    await expect((q as unknown as { supportedModels: () => Promise<unknown> }).supportedModels())
      .resolves.toEqual([{ id: 'claude-opus-5' }]);
    expect(typeof (q as unknown as { interrupt?: unknown }).interrupt).toBe('function');
  });

  it('propagates finalization when the caller breaks out early', async () => {
    const finalized = vi.fn();
    queryMock.mockReturnValue(makeQuery([{ type: 'a' }, { type: 'b' }, { type: 'c' }], finalized));

    const query = await loadSdkQuery();
    for await (const _msg of query({ prompt: 'x' } as never)) break;

    // Managers break on abort; if the underlying generator is never finalized the
    // subprocess is left running.
    expect(finalized).toHaveBeenCalledTimes(1);
  });

  it('does not break the turn when the store throws', async () => {
    const store = initProviderUsageStore(prefs());
    vi.spyOn(store, 'recordClaudeRateLimit').mockImplementation(() => {
      throw new Error('store exploded');
    });
    queryMock.mockReturnValue(makeQuery([RATE_LIMIT_MESSAGE, { type: 'result' }]));

    const query = await loadSdkQuery();
    const seen: unknown[] = [];
    for await (const msg of query({ prompt: 'x' } as never)) seen.push(msg);
    expect(seen).toHaveLength(2);
  });

  it('works with no store initialised at all', async () => {
    queryMock.mockReturnValue(makeQuery([RATE_LIMIT_MESSAGE]));
    const query = await loadSdkQuery();
    const seen: unknown[] = [];
    for await (const msg of query({ prompt: 'x' } as never)) seen.push(msg);
    expect(seen).toHaveLength(1);
  });

  it('still refuses SYNCHRONOUSLY while Claude is switched off', () => {
    setAgentProviderAccessResolver((p) => p !== 'claude');
    // Not a rejected promise — callers rely on refusal before any side effect.
    expect(() => loadSdkQuery()).toThrow();
  });
});
