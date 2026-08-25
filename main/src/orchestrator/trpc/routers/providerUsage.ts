/**
 * tRPC `cyboflow.providerUsage` — the Claude/Codex subscription quota shown by
 * the usage meters at the top of the Human review queue.
 *
 * NOT project-scoped: a subscription quota belongs to the machine's logged-in
 * account, not to whichever project happens to be open.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. The concrete ProviderUsageStore lives under
 * main/src/services, so this module depends only on the STRUCTURAL
 * {@link ProviderUsageSource} below and on shared/ types — the same shape
 * reviewItems.ts uses for its run probe. index.ts injects the real store at boot.
 */
import type { EventEmitter } from 'events';
import { router, publicProcedure, protectedProcedure } from '../trpc';
import type { ProviderUsageState } from '../../../../../shared/types/providerUsage';
import { eventToAsyncIterable } from './events';
import { throttleAsyncIterator } from '../throttle';

/** The narrow surface this router needs from the provider-usage layer. */
export interface ProviderUsageSource {
  getState(): ProviderUsageState;
  readonly events: EventEmitter;
  /**
   * Ask both providers for their current quota. Single-flight and rate-limited
   * on the far side, so a caller may invoke it freely — on mount, on a timer.
   */
  refresh(): Promise<void>;
}

/** Emitted on the source's EventEmitter after every accepted reading. */
export const PROVIDER_USAGE_CHANGED_EVENT = 'changed';

/**
 * A busy sprint can emit a reading per turn per lane, and each one carries the
 * whole (small) state, so coalescing to 1 Hz costs the UI nothing.
 */
const PROVIDER_USAGE_HZ = 1;

let _source: ProviderUsageSource | null = null;

/** Inject the store. Called from the boot wiring before the server serves. */
export function setProviderUsageSource(source: ProviderUsageSource): void {
  _source = source;
}

export function _resetProviderUsageSourceForTesting(): void {
  _source = null;
}

export const providerUsageRouter = router({
  /**
   * A point-in-time snapshot. Returns `{}` before injection (early boot) and
   * whenever no provider has reported a live window — an empty state is the
   * honest answer, not an error.
   */
  get: publicProcedure.query((): ProviderUsageState => _source?.getState() ?? {}),

  /**
   * Ask the providers directly, rather than waiting for a turn to mention their
   * quota. Resolves once the poll settles; the fresh state arrives over
   * `onChanged` like any other reading, so the caller need not use the return.
   *
   * Never rejects on a provider being signed out, disabled, or absent — those
   * are ordinary outcomes that leave the previous reading in place.
   */
  refresh: protectedProcedure.mutation(async (): Promise<void> => {
    await _source?.refresh();
  }),

  /**
   * Whole-state pushes. Each event carries the complete state, so a dropped
   * event costs freshness only — the consumer needs no delta reducer.
   */
  onChanged: protectedProcedure
    .subscription(async function* ({ signal }): AsyncGenerator<ProviderUsageState> {
      const source = _source;
      if (source === null) return;
      const abortSignal = signal ?? new AbortController().signal;
      const events = eventToAsyncIterable<ProviderUsageState>(
        source.events,
        PROVIDER_USAGE_CHANGED_EVENT,
        abortSignal,
      );
      yield* throttleAsyncIterator(events, PROVIDER_USAGE_HZ, abortSignal);
    }),
});
