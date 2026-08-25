/**
 * The codex notification observer.
 *
 * The dominant requirement is that it cannot throw: every caller is a
 * `CodexAppServerClient` notification handler, and an escaping exception there
 * reaches `fail()`, which SIGTERMs the app-server's whole process group.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { observeCodexNotification } from '../codexUsageObserver';
import {
  initProviderUsageStore,
  _resetProviderUsageStoreForTesting,
} from '../providerUsageStore';

const CAPTURED_PARAMS = JSON.parse(
  '{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":59,'
  + '"windowDurationMins":10080,"resetsAt":1787236263},"secondary":null,'
  + '"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},'
  + '"individualLimit":null,"planType":"prolite","rateLimitReachedType":null}}',
) as unknown;

const NOW = 1784_000_000_000;

function prefs() {
  const map = new Map<string, string>();
  return {
    getUserPreference: (k: string) => map.get(k) ?? null,
    setUserPreference: (k: string, v: string) => { map.set(k, v); },
  };
}

beforeEach(() => { _resetProviderUsageStoreForTesting(); });
afterEach(() => { _resetProviderUsageStoreForTesting(); });

describe('observeCodexNotification', () => {
  it('records a captured rate-limits push', () => {
    const store = initProviderUsageStore(prefs());
    observeCodexNotification('account/rateLimits/updated', CAPTURED_PARAMS);
    expect(store.getState(NOW).codex?.windows[0]?.usedPercent).toBe(59);
  });

  it('ignores every other notification method', () => {
    const store = initProviderUsageStore(prefs());
    observeCodexNotification('item/agentMessage/delta', CAPTURED_PARAMS);
    observeCodexNotification('thread/tokenUsage/updated', CAPTURED_PARAMS);
    expect(store.getState(NOW).codex).toBeUndefined();
  });

  it('never throws, whatever arrives', () => {
    initProviderUsageStore(prefs());
    for (const params of [undefined, null, 'x', 0, {}, { rateLimits: 'no' }, []]) {
      expect(() => observeCodexNotification('account/rateLimits/updated', params)).not.toThrow();
    }
  });

  it('never throws when the store itself throws', () => {
    const store = initProviderUsageStore(prefs());
    vi.spyOn(store, 'recordCodexRateLimits').mockImplementation(() => {
      throw new Error('store exploded');
    });
    expect(() => observeCodexNotification('account/rateLimits/updated', CAPTURED_PARAMS))
      .not.toThrow();
  });

  it('is a no-op before the store is initialised', () => {
    expect(() => observeCodexNotification('account/rateLimits/updated', CAPTURED_PARAMS))
      .not.toThrow();
  });
});
