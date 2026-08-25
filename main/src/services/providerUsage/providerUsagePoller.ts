/**
 * ProviderUsagePoller — ASKS each provider for its current quota, rather than
 * waiting for a turn to mention it.
 *
 * ## Why polling is the primary source
 *
 * The event taps (`loadSdkQuery`'s rate_limit_event tee, the codex
 * `account/rateLimits/updated` forward) only refresh when a turn happens to be
 * running, so what they report can silently describe a world that has moved on.
 * Worse for Claude: the streamed event withholds `utilization` entirely until
 * the account crosses a warning threshold, so below ~75% there is no number at
 * all. A poll answers with every window, at full precision, on demand.
 *
 * Neither poll spends subscription quota. Codex answers a plain JSON-RPC request
 * on a freshly-spawned app-server; Claude answers a CONTROL request on an SDK
 * session — no model turn in either case.
 *
 * ## Both paths are best-effort
 *
 * Claude's method is named
 * `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, and it means it:
 * the method can change shape or vanish on an SDK bump. It is therefore
 * FEATURE-DETECTED, never assumed, and a miss is silent — the event tap remains
 * as the fallback, which is precisely why that tap was kept rather than replaced.
 */
import type { ProviderUsageStore, ClaudeUsagePoll, ProviderUsageLogger } from './providerUsageStore';
import { parseCodexRateLimitsNotification } from '../panels/codex/appServer/rateLimits';

/** A poll spawns a process; a slow provider must not wedge the refresh. */
const POLL_TIMEOUT_MS = 20_000;

/** Floor between refreshes. The UI may ask on every mount; the provider needn't hear it. */
export const POLL_MIN_INTERVAL_MS = 60_000;

/** The narrow surfaces the poller needs, injected so this module stays testable. */
export interface ProviderUsagePollDeps {
  /** Resolve the Claude `/usage` control response, or null when unavailable. */
  pollClaude?: () => Promise<ClaudeUsagePoll | null>;
  /** Resolve the raw codex `account/rateLimits/read` result, or null. */
  pollCodex?: () => Promise<unknown>;
  /** Provider enablement — a switched-off provider is never spawned. */
  isProviderEnabled?: (provider: 'claude' | 'codex') => boolean;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

export class ProviderUsagePoller {
  private inFlight: Promise<void> | null = null;
  private lastPollStartedAtMs = 0;

  constructor(
    private readonly store: ProviderUsageStore,
    private readonly deps: ProviderUsagePollDeps = {},
    private readonly logger?: ProviderUsageLogger,
  ) {}

  /**
   * Refresh both providers.
   *
   * SINGLE-FLIGHT and rate-limited: the review queue asks on mount and on a
   * timer, and every ask would otherwise spawn two processes. A caller within
   * {@link POLL_MIN_INTERVAL_MS} of the last poll joins the previous result
   * instead (or returns immediately if that one already finished).
   */
  async refresh(nowMs: number = Date.now(), force = false): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    if (!force && nowMs - this.lastPollStartedAtMs < POLL_MIN_INTERVAL_MS) return;

    this.lastPollStartedAtMs = nowMs;
    this.inFlight = this.runBothProviders()
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  /** Both providers are polled CONCURRENTLY and independently: one being signed
   *  out, disabled, or missing must not suppress the other's reading. */
  private async runBothProviders(): Promise<void> {
    await Promise.allSettled([this.refreshClaude(), this.refreshCodex()]);
  }

  private async refreshClaude(): Promise<void> {
    if (this.deps.isProviderEnabled?.('claude') === false) return;
    if (this.deps.pollClaude === undefined) return;
    try {
      const usage = await withTimeout(this.deps.pollClaude(), POLL_TIMEOUT_MS, 'Claude usage poll');
      // null = the experimental control request is gone or unsupported. The
      // event tap keeps feeding the store; leave what is already there alone.
      if (usage === null) return;
      this.store.recordClaudeUsagePoll(usage);
    } catch (error) {
      this.warn('claude', error);
    }
  }

  private async refreshCodex(): Promise<void> {
    if (this.deps.isProviderEnabled?.('codex') === false) return;
    if (this.deps.pollCodex === undefined) return;
    try {
      const result = await withTimeout(this.deps.pollCodex(), POLL_TIMEOUT_MS, 'Codex rate-limits poll');
      // `account/rateLimits/read` returns the same rateLimits object the
      // notification carries, so the notification parser reads it verbatim.
      const rateLimits = parseCodexRateLimitsNotification(result);
      if (rateLimits === null) return;
      this.store.recordCodexRateLimits(rateLimits, Date.now(), 'poll');
    } catch (error) {
      this.warn('codex', error);
    }
  }

  private warn(provider: string, error: unknown): void {
    // A provider that is signed out, disabled, or simply absent is an ordinary
    // outcome here, not an incident — the meters degrade to whatever the event
    // tap last saw.
    this.logger?.warn(
      `[ProviderUsagePoller] ${provider} poll failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
