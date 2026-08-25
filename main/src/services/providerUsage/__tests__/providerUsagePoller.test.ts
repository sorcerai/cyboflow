/**
 * ProviderUsagePoller — scheduling and isolation.
 *
 * The provider calls themselves are injected, so this exercises the parts that
 * would otherwise only fail in production: rate limiting (the UI asks on every
 * mount), single-flight, and the rule that one provider failing must not
 * suppress the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ProviderUsagePoller, POLL_MIN_INTERVAL_MS } from '../providerUsagePoller';
import { ProviderUsageStore, type ClaudeUsagePoll } from '../providerUsageStore';

const NOW = 1784_000_000_000;

const CLAUDE_USAGE: ClaudeUsagePoll = {
  subscriptionType: 'max',
  rateLimitsAvailable: true,
  rateLimits: {
    five_hour: { utilization: 42, resets_at: '2026-08-24T20:00:00.000Z' },
    seven_day: { utilization: 71, resets_at: '2026-08-28T00:00:00.000Z' },
  },
};

const CODEX_RESULT = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 1788195448 },
    secondary: null,
    planType: 'prolite',
  },
};

let store: ProviderUsageStore;
beforeEach(() => { store = new ProviderUsageStore(); });

describe('ProviderUsagePoller', () => {
  it('records both providers from a single refresh', async () => {
    const poller = new ProviderUsagePoller(store, {
      pollClaude: async () => CLAUDE_USAGE,
      pollCodex: async () => CODEX_RESULT,
    });
    await poller.refresh(NOW);

    const state = store.getState(NOW);
    expect(state.claude?.windows.map((w) => w.kind).sort())
      .toEqual(['claude_five_hour', 'claude_seven_day']);
    expect(state.codex?.windows[0]?.usedPercent).toBe(2);
  });

  it('marks polled percentages as poll-sourced, so the UI does not flag them stale', async () => {
    const poller = new ProviderUsagePoller(store, {
      pollClaude: async () => CLAUDE_USAGE,
      pollCodex: async () => CODEX_RESULT,
    });
    await poller.refresh(NOW);

    for (const provider of ['claude', 'codex'] as const) {
      for (const window of store.getState(NOW)[provider]?.windows ?? []) {
        expect(window.percentSource).toBe('poll');
      }
    }
  });

  it('rate-limits repeat refreshes', async () => {
    const pollCodex = vi.fn().mockResolvedValue(CODEX_RESULT);
    const poller = new ProviderUsagePoller(store, { pollCodex });

    await poller.refresh(NOW);
    // The review queue asks on every mount; the provider must not hear each one.
    await poller.refresh(NOW + 1_000);
    await poller.refresh(NOW + POLL_MIN_INTERVAL_MS - 1);
    expect(pollCodex).toHaveBeenCalledTimes(1);

    await poller.refresh(NOW + POLL_MIN_INTERVAL_MS);
    expect(pollCodex).toHaveBeenCalledTimes(2);
  });

  it('honours force, bypassing the rate limit', async () => {
    const pollCodex = vi.fn().mockResolvedValue(CODEX_RESULT);
    const poller = new ProviderUsagePoller(store, { pollCodex });
    await poller.refresh(NOW);
    await poller.refresh(NOW + 1, true);
    expect(pollCodex).toHaveBeenCalledTimes(2);
  });

  it('is single-flight — concurrent callers join one poll', async () => {
    let release: () => void = () => {};
    const pollCodex = vi.fn().mockImplementation(
      () => new Promise((r) => { release = () => r(CODEX_RESULT); }),
    );
    const poller = new ProviderUsagePoller(store, { pollCodex });

    const a = poller.refresh(NOW);
    const b = poller.refresh(NOW, true);
    release();
    await Promise.all([a, b]);
    expect(pollCodex).toHaveBeenCalledTimes(1);
  });

  it('records codex even when the claude poll throws', async () => {
    const poller = new ProviderUsagePoller(store, {
      pollClaude: async () => { throw new Error('claude signed out'); },
      pollCodex: async () => CODEX_RESULT,
    });
    await expect(poller.refresh(NOW)).resolves.toBeUndefined();
    expect(store.getState(NOW).codex?.windows[0]?.usedPercent).toBe(2);
  });

  it('leaves the previous reading alone when the experimental method is absent', async () => {
    // pollClaude resolving null = the control request is gone on this SDK. The
    // event tap's reading must survive rather than being wiped.
    store.recordClaudeRateLimit(
      { status: 'allowed_warning', resetsAt: 1787339400, rateLimitType: 'five_hour', utilization: 0.9 },
      NOW,
    );
    const poller = new ProviderUsagePoller(store, { pollClaude: async () => null });
    await poller.refresh(NOW);
    expect(store.getState(NOW).claude?.windows[0]?.usedPercent).toBeCloseTo(90);
  });

  it('skips a provider switched off in settings', async () => {
    const pollClaude = vi.fn().mockResolvedValue(CLAUDE_USAGE);
    const pollCodex = vi.fn().mockResolvedValue(CODEX_RESULT);
    const poller = new ProviderUsagePoller(store, {
      pollClaude,
      pollCodex,
      isProviderEnabled: (p) => p !== 'claude',
    });
    await poller.refresh(NOW);
    expect(pollClaude).not.toHaveBeenCalled();
    expect(pollCodex).toHaveBeenCalledTimes(1);
  });
});

describe('ProviderUsageStore.recordClaudeUsagePoll', () => {
  it('drops the provider when plan limits do not apply', () => {
    store.recordClaudeUsagePoll(CLAUDE_USAGE, NOW);
    expect(store.getState(NOW).claude).toBeDefined();

    // API key / Bedrock / Vertex sessions have no plan quota to show.
    store.recordClaudeUsagePoll(
      { subscriptionType: null, rateLimitsAvailable: false, rateLimits: null },
      NOW,
    );
    expect(store.getState(NOW).claude).toBeUndefined();
  });

  it('is authoritative — a window the poll omits is deleted', () => {
    store.recordClaudeUsagePoll(CLAUDE_USAGE, NOW);
    expect(store.getState(NOW).claude?.windows).toHaveLength(2);

    store.recordClaudeUsagePoll(
      { ...CLAUDE_USAGE, rateLimits: { five_hour: { utilization: 42, resets_at: null } } },
      NOW,
    );
    expect(store.getState(NOW).claude?.windows.map((w) => w.kind)).toEqual(['claude_five_hour']);
  });

  it('parses the ISO reset into ms', () => {
    store.recordClaudeUsagePoll(CLAUDE_USAGE, NOW);
    const five = store.getState(NOW).claude?.windows.find((w) => w.kind === 'claude_five_hour');
    expect(five?.resetsAtMs).toBe(Date.parse('2026-08-24T20:00:00.000Z'));
  });

  it('records the plan as the subscription type', () => {
    store.recordClaudeUsagePoll(CLAUDE_USAGE, NOW);
    expect(store.getState(NOW).claude?.planType).toBe('max');
  });

  it('parses the MICROSECOND-precision offset timestamp the API actually sends', () => {
    // Captured verbatim from a live /usage response — the SDK's own docs say
    // "ISO 8601" but the wire carries 6 fractional digits and a +00:00 offset.
    store.recordClaudeUsagePoll(
      {
        subscriptionType: 'max',
        rateLimitsAvailable: true,
        rateLimits: {
          five_hour: { utilization: 42, resets_at: '2026-08-24T19:00:00.951640+00:00' },
        },
      },
      NOW,
    );
    const five = store.getState(NOW).claude?.windows[0];
    expect(five?.resetsAtMs).toBe(1787598000951);
    // A NaN here would prune the window instantly and empty the card forever.
    expect(Number.isFinite(five?.resetsAtMs ?? NaN)).toBe(true);
  });

  it('IGNORES undocumented windows rather than rendering them', () => {
    // A live response carries keys the typings do not mention — seven_day_cowork,
    // tangelo, nimbus_quill, extra_usage (a different shape entirely). Showing an
    // unlabelled internal codename as a quota meter would be worse than useless.
    store.recordClaudeUsagePoll(
      {
        subscriptionType: 'max',
        rateLimitsAvailable: true,
        rateLimits: {
          five_hour: { utilization: 42, resets_at: null },
          nimbus_quill: { utilization: 0, resets_at: null },
          tangelo: null,
          extra_usage: { utilization: 100, resets_at: null },
        } as unknown as NonNullable<ClaudeUsagePoll['rateLimits']>,
      },
      NOW,
    );
    expect(store.getState(NOW).claude?.windows.map((w) => w.kind)).toEqual(['claude_five_hour']);
  });
});

describe('ProviderUsageStore — percentage provenance', () => {
  it('keeps a POLLED percentage marked as polled when a later stream event omits it', () => {
    store.recordClaudeUsagePoll(CLAUDE_USAGE, NOW);
    const resetsAtMs = Date.parse('2026-08-24T20:00:00.000Z');

    // Same window, arriving via the event stream with no utilization. The
    // retained number is still the polled one, so it must NOT be flagged stale
    // on the strength of the event that merely touched the record.
    store.recordClaudeRateLimit(
      { status: 'allowed', resetsAt: Math.floor(resetsAtMs / 1000), rateLimitType: 'five_hour' },
      NOW + 1_000,
    );
    const five = store.getState(NOW).claude?.windows.find((w) => w.kind === 'claude_five_hour');
    expect(five?.usedPercent).toBe(42);
    expect(five?.percentSource).toBe('poll');
    expect(five?.percentObservedAtMs).toBe(NOW);
    // The record itself is fresh even though the number in it is not.
    expect(five?.observedAtMs).toBe(NOW + 1_000);
  });

  it('marks a stream-reported percentage as stream-sourced', () => {
    store.recordClaudeRateLimit(
      { status: 'allowed_warning', resetsAt: 1787339400, rateLimitType: 'five_hour', utilization: 0.9 },
      NOW,
    );
    expect(store.getState(NOW).claude?.windows[0]?.percentSource).toBe('stream');
  });
});
