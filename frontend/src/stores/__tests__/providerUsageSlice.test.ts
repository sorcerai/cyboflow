/**
 * providerUsageSlice — the seed-query / subscription race and refcounting.
 *
 * The race is the reason this slice exists in its current shape: a reading that
 * lands between issuing the seed query and attaching the subscription would be
 * overwritten by the older seed when it resolves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ProviderUsageState } from '../../../../shared/types/providerUsage';

const subscribe = vi.fn();
const query = vi.fn();
const refreshMutate = vi.fn();

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      providerUsage: {
        get: { query: (...args: unknown[]) => query(...args) },
        refresh: { mutate: (...args: unknown[]) => refreshMutate(...args) },
        onChanged: { subscribe: (...args: unknown[]) => subscribe(...args) },
      },
    },
  },
}));

import { useProviderUsageSlice } from '../providerUsageSlice';

function state(percent: number): ProviderUsageState {
  return {
    codex: {
      provider: 'codex',
      planType: 'prolite',
      observedAtMs: 1,
      windows: [{
        kind: 'codex_primary',
        label: 'Weekly',
        status: 'ok',
        usedPercent: percent,
        percentSource: 'poll',
        percentObservedAtMs: 1,
        resetsAtMs: 2,
        windowMinutes: 10080,
        observedAtMs: 1,
      }],
    },
  };
}

const unsubscribe = vi.fn();

beforeEach(() => {
  subscribe.mockReset();
  query.mockReset();
  refreshMutate.mockReset();
  refreshMutate.mockResolvedValue(undefined);
  unsubscribe.mockReset();
  subscribe.mockReturnValue({ unsubscribe });
  query.mockReturnValue(new Promise(() => {})); // pending unless a test resolves it
  useProviderUsageSlice.getState()._resetForTesting();
  unsubscribe.mockReset();
});

describe('providerUsageSlice.refresh', () => {
  it('drives the refresh mutation', async () => {
    await useProviderUsageSlice.getState().refresh();
    expect(refreshMutate).toHaveBeenCalledTimes(1);
  });

  it('swallows a failed poll rather than surfacing it in the review queue', async () => {
    refreshMutate.mockRejectedValue(new Error('codex signed out'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(useProviderUsageSlice.getState().refresh()).resolves.toBeUndefined();
  });
});

describe('providerUsageSlice.init', () => {
  it('subscribes BEFORE issuing the seed query', () => {
    const order: string[] = [];
    subscribe.mockImplementation(() => { order.push('subscribe'); return { unsubscribe }; });
    query.mockImplementation(() => { order.push('query'); return new Promise(() => {}); });

    useProviderUsageSlice.getState().init();
    expect(order).toEqual(['subscribe', 'query']);
  });

  it('does NOT let a late seed overwrite a push that already arrived', async () => {
    let resolveSeed: (v: ProviderUsageState) => void = () => {};
    query.mockReturnValue(new Promise<ProviderUsageState>((r) => { resolveSeed = r; }));

    useProviderUsageSlice.getState().init();
    const onData = subscribe.mock.calls[0][1].onData as (u: ProviderUsageState) => void;

    onData(state(90));            // fresh push
    resolveSeed(state(10));       // stale seed resolves afterwards
    await Promise.resolve();
    await Promise.resolve();

    expect(useProviderUsageSlice.getState().usage.codex?.windows[0]?.usedPercent).toBe(90);
  });

  it('applies the seed when no push has arrived', async () => {
    query.mockResolvedValue(state(10));
    useProviderUsageSlice.getState().init();
    await Promise.resolve();
    await Promise.resolve();
    expect(useProviderUsageSlice.getState().usage.codex?.windows[0]?.usedPercent).toBe(10);
    expect(useProviderUsageSlice.getState().connectionStatus).toBe('connected');
  });

  it('shares ONE subscription across co-mounted consumers', () => {
    const releaseA = useProviderUsageSlice.getState().init();
    const releaseB = useProviderUsageSlice.getState().init();
    expect(subscribe).toHaveBeenCalledTimes(1);

    releaseA();
    expect(unsubscribe).not.toHaveBeenCalled();
    releaseB();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('ignores a double release', () => {
    const release = useProviderUsageSlice.getState().init();
    release();
    release();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('degrades to disconnected when the feed cannot be wired at all', () => {
    // These meters are an accessory to the review queue; a telemetry feed that
    // throws on subscribe must not take the whole view down with it.
    subscribe.mockImplementation(() => { throw new Error('no such procedure'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => useProviderUsageSlice.getState().init()).not.toThrow();
    expect(useProviderUsageSlice.getState().connectionStatus).toBe('disconnected');
  });

  it('marks the feed disconnected on a subscription error', () => {
    useProviderUsageSlice.getState().init();
    const onError = subscribe.mock.calls[0][1].onError as (e: unknown) => void;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    onError(new Error('socket died'));
    expect(useProviderUsageSlice.getState().connectionStatus).toBe('disconnected');
  });
});
