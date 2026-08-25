/**
 * cyboflow.providerUsage router.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import {
  providerUsageRouter,
  setProviderUsageSource,
  _resetProviderUsageSourceForTesting,
} from '../routers/providerUsage';
import type { ProviderUsageState } from '../../../../../shared/types/providerUsage';

const CTX = { userId: 'local' as const, setDockBadge: () => {}, getForcedSubstrate: () => null };

const STATE: ProviderUsageState = {
  codex: {
    provider: 'codex',
    planType: 'prolite',
    observedAtMs: 1784_000_000_000,
    windows: [{
      kind: 'codex_primary',
      label: 'Weekly',
      status: 'warning',
      usedPercent: 59,
      percentSource: 'poll',
      percentObservedAtMs: 1784_000_000_000,
      resetsAtMs: 1787236263000,
      windowMinutes: 10080,
      observedAtMs: 1784_000_000_000,
    }],
  },
};

afterEach(() => { _resetProviderUsageSourceForTesting(); });

describe('providerUsage.get', () => {
  it('returns an empty state before the store is injected', async () => {
    const caller = providerUsageRouter.createCaller(CTX as never);
    // Early boot must be an honest empty answer, not an error.
    await expect(caller.get()).resolves.toEqual({});
  });

  it('returns the injected store state', async () => {
    setProviderUsageSource({ getState: () => STATE, events: new EventEmitter(), refresh: async () => {} });
    const caller = providerUsageRouter.createCaller(CTX as never);
    await expect(caller.get()).resolves.toEqual(STATE);
  });
});

describe('providerUsage.refresh', () => {
  it('drives the poller', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    setProviderUsageSource({ getState: () => STATE, events: new EventEmitter(), refresh });
    await providerUsageRouter.createCaller(CTX as never).refresh();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('is a no-op before the store is injected', async () => {
    await expect(providerUsageRouter.createCaller(CTX as never).refresh()).resolves.toBeUndefined();
  });
});

describe('providerUsage.onChanged', () => {
  it('yields whole-state pushes from the source emitter', async () => {
    const events = new EventEmitter();
    setProviderUsageSource({ getState: () => STATE, events, refresh: async () => {} });

    const controller = new AbortController();
    const caller = providerUsageRouter.createCaller({ ...CTX, signal: controller.signal } as never);
    const iterator = (await caller.onChanged())[Symbol.asyncIterator]();

    const next = iterator.next();
    // The emit must land after the subscription has attached its listener.
    await new Promise((r) => setImmediate(r));
    events.emit('changed', STATE);

    await expect(next).resolves.toEqual({ value: STATE, done: false });
    controller.abort();
  });

  it('completes immediately when no source is injected', async () => {
    const controller = new AbortController();
    const caller = providerUsageRouter.createCaller({ ...CTX, signal: controller.signal } as never);
    const iterator = (await caller.onChanged())[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
