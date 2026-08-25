/**
 * providerUsageSlice — the Claude/Codex subscription quota behind the usage
 * meters at the top of the Human review queue.
 *
 * GLOBAL, not project-scoped (unlike {@link useReviewItemsSlice}): a
 * subscription quota belongs to the logged-in account, so it does not re-wire
 * when the active project changes.
 *
 * ## Subscribe BEFORE the seed query
 *
 * Per `docs/CODE-PATTERNS.md` → "tRPC seed-query + subscription race policy",
 * and for a concrete reason here: a reading that lands between the query being
 * issued and the subscription attaching would otherwise be overwritten by the
 * older seed when it resolves. The seed is additionally skipped outright once a
 * push has already arrived — a push is by definition never staler than the seed
 * that preceded it.
 *
 * Every event carries the WHOLE state, so there is no delta reducer and a
 * dropped event costs freshness only.
 */
import { create } from 'zustand';
import { trpc } from '../trpc/client';
import type { ProviderUsageState } from '../../../shared/types/providerUsage';

export type ProviderUsageConnectionStatus = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface ProviderUsageSliceState {
  usage: ProviderUsageState;
  connectionStatus: ProviderUsageConnectionStatus;
  replaceUsage: (usage: ProviderUsageState) => void;
  setConnectionStatus: (status: ProviderUsageConnectionStatus) => void;
  /**
   * Wire the feed. Refcounted: co-mounted consumers share ONE subscription and
   * it is torn down only when the last one releases. Returns a release fn;
   * calling it twice is a no-op.
   */
  init: () => (() => void);
  /**
   * Ask the providers directly. Rate-limited and single-flight in the main
   * process, so callers may invoke it on mount and on a timer without care.
   * Never rejects — a provider that is signed out or absent leaves the previous
   * reading in place.
   */
  refresh: () => Promise<void>;
  /** Tear the wiring down unconditionally. Test-only. */
  _resetForTesting: () => void;
}

export const useProviderUsageSlice = create<ProviderUsageSliceState>((set, get) => {
  let subscriptionTeardown: (() => void) | null = null;
  let refCount = 0;
  let generation = 0;
  /** Set once a push has landed, so a late seed cannot overwrite newer state. */
  let pushReceived = false;

  const makeRelease = (myGeneration: number): (() => void) => {
    let released = false;
    return () => {
      if (released || generation !== myGeneration) return;
      released = true;
      refCount -= 1;
      if (refCount > 0) return;
      subscriptionTeardown?.();
      subscriptionTeardown = null;
      generation += 1;
    };
  };

  return {
    usage: {},
    connectionStatus: 'idle',

    replaceUsage: (usage) => set({ usage }),
    setConnectionStatus: (connectionStatus) => set({ connectionStatus }),

    init: () => {
      if (subscriptionTeardown !== null) {
        refCount += 1;
        return makeRelease(generation);
      }

      generation += 1;
      const myGeneration = generation;
      refCount = 1;
      pushReceived = false;
      set({ connectionStatus: 'connecting' });

      const { setConnectionStatus } = get();

      // The whole wiring is guarded: these meters are an ACCESSORY to the review
      // queue, and a telemetry feed that cannot connect must degrade to "no
      // cards", never take the queue down with it.
      try {
        wire(myGeneration);
      } catch (err: unknown) {
        console.error('[providerUsageSlice] failed to wire the usage feed:', err);
        setConnectionStatus('disconnected');
        subscriptionTeardown = null;
        refCount = 0;
        generation += 1;
      }

      return makeRelease(myGeneration);
    },

    refresh: async () => {
      try {
        await trpc.cyboflow.providerUsage.refresh.mutate();
      } catch (err: unknown) {
        // These meters are an accessory; a failed poll must never surface as an
        // error in the review queue.
        console.error('[providerUsageSlice] usage refresh failed:', err);
      }
    },

    _resetForTesting: () => {
      subscriptionTeardown?.();
      subscriptionTeardown = null;
      refCount = 0;
      generation += 1;
      pushReceived = false;
      set({ usage: {}, connectionStatus: 'idle' });
    },
  };

  function wire(myGeneration: number): void {
    const { replaceUsage, setConnectionStatus } = get();

    // 1. Subscribe FIRST — see the module docstring.
    const subscription = trpc.cyboflow.providerUsage.onChanged.subscribe(undefined, {
      onData: (usage) => {
        if (generation !== myGeneration) return;
        pushReceived = true;
        replaceUsage(usage);
        setConnectionStatus('connected');
      },
      onError: (err: unknown) => {
        if (generation !== myGeneration) return;
        console.error('[providerUsageSlice] onChanged subscription error:', err);
        setConnectionStatus('disconnected');
        subscription.unsubscribe();
        subscriptionTeardown = null;
        refCount = 0;
        generation += 1;
      },
    });
    subscriptionTeardown = () => { subscription.unsubscribe(); };

    // 2. Then seed, discarding the result if it lost the race.
    trpc.cyboflow.providerUsage.get
      .query()
      .then((usage) => {
        if (generation !== myGeneration || pushReceived) return;
        replaceUsage(usage);
        setConnectionStatus('connected');
      })
      .catch((err: unknown) => {
        if (generation !== myGeneration) return;
        console.error('[providerUsageSlice] seed query failed:', err);
      });
  }
});
