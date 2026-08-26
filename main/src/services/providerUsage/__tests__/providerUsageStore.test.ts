/**
 * ProviderUsageStore tests.
 *
 * Every Claude/Codex payload below is a VERBATIM production capture from
 * `raw_events` — the epoch-seconds timestamps in particular are real, because the
 * seconds→ms conversion is exactly the kind of bug that silently empties both
 * cards forever (an unconverted `1787339400` reads as "expired in 1970").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ProviderUsageStore,
  PROVIDER_USAGE_PREFERENCE_KEY,
  type ProviderUsagePreferences,
} from '../providerUsageStore';
import type { RateLimitEvent } from '../../../../../shared/types/claudeStream';

type ClaudeInfo = RateLimitEvent['rate_limit_info'];

/** Captured 2026-08 from a live session: `allowed`, five_hour, NO utilization. */
const CAPTURED_ALLOWED: ClaudeInfo = {
  status: 'allowed',
  resetsAt: 1787339400,
  rateLimitType: 'five_hour',
  overageStatus: 'rejected',
  overageDisabledReason: 'org_level_disabled_until',
  isUsingOverage: false,
};

/** Captured: `allowed_warning`, seven_day, WITH utilization 0.91. */
const CAPTURED_WARNING: ClaudeInfo = {
  status: 'allowed_warning',
  resetsAt: 1784995200,
  rateLimitType: 'seven_day',
  utilization: 0.91,
  isUsingOverage: false,
  surpassedThreshold: 0.75,
};

/** Captured codex frame with a populated primary window. */
const CAPTURED_CODEX = {
  limitId: 'codex',
  primary: { usedPercent: 59, windowDurationMins: 10080, resetsAt: 1787236263 },
  secondary: null,
  planType: 'prolite',
} as const;

/** A moment comfortably before every captured `resetsAt`. */
const NOW = 1784_000_000_000;

function makePrefs(): ProviderUsagePreferences & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getUserPreference: (key) => store.get(key) ?? null,
    setUserPreference: (key, value) => { store.set(key, value); },
  };
}

describe('ProviderUsageStore — Claude ingest', () => {
  let store: ProviderUsageStore;
  beforeEach(() => { store = new ProviderUsageStore(); });

  it('converts epoch SECONDS to ms so a captured reading is live, not expired', () => {
    store.recordClaudeRateLimit(CAPTURED_ALLOWED, NOW);
    const window = store.getState(NOW).claude?.windows[0];
    expect(window).toBeDefined();
    expect(window?.resetsAtMs).toBe(1787339400 * 1000);
  });

  it('records NO percentage when the reading carries no utilization', () => {
    store.recordClaudeRateLimit(CAPTURED_ALLOWED, NOW);
    // Null, never 0 — "the provider did not say" must not render as an empty meter.
    expect(store.getState(NOW).claude?.windows[0]?.usedPercent).toBeNull();
    expect(store.getState(NOW).claude?.windows[0]?.status).toBe('ok');
  });

  it('converts the 0-1 utilization fraction to a percentage', () => {
    store.recordClaudeRateLimit(CAPTURED_WARNING, NOW);
    const window = store.getState(NOW).claude?.windows[0];
    expect(window?.usedPercent).toBeCloseTo(91);
    expect(window?.status).toBe('critical');
  });

  it('keeps the five_hour and seven_day windows side by side', () => {
    store.recordClaudeRateLimit(CAPTURED_ALLOWED, NOW);
    store.recordClaudeRateLimit(CAPTURED_WARNING, NOW);
    const kinds = store.getState(NOW).claude?.windows.map((w) => w.kind).sort();
    expect(kinds).toEqual(['claude_five_hour', 'claude_seven_day']);
  });

  it('RETAINS a known percentage when a later reading for the same window omits it', () => {
    store.recordClaudeRateLimit(CAPTURED_WARNING, NOW);
    // The same window, now merely `allowed` and carrying no utilization. Blanking
    // the meter here would read as a recovery that never happened.
    store.recordClaudeRateLimit(
      { status: 'allowed', resetsAt: 1784995200, rateLimitType: 'seven_day' },
      NOW + 1000,
    );
    const window = store.getState(NOW).claude?.windows[0];
    expect(window?.usedPercent).toBeCloseTo(91);
    expect(window?.status).toBe('critical');
  });

  it('CLEARS the retained percentage once the window resets to a new period', () => {
    store.recordClaudeRateLimit(CAPTURED_WARNING, NOW);
    store.recordClaudeRateLimit(
      { status: 'allowed', resetsAt: 1785600000, rateLimitType: 'seven_day' },
      NOW + 1000,
    );
    expect(store.getState(NOW).claude?.windows[0]?.usedPercent).toBeNull();
  });

  it('accepts a utilization reported under a plain `allowed` status', () => {
    // The schema makes utilization optional INDEPENDENTLY of status; the
    // "only on allowed_warning" pattern is an observation, not an invariant.
    store.recordClaudeRateLimit(
      { status: 'allowed', resetsAt: 1787339400, rateLimitType: 'five_hour', utilization: 0.3 },
      NOW,
    );
    expect(store.getState(NOW).claude?.windows[0]?.usedPercent).toBeCloseTo(30);
    expect(store.getState(NOW).claude?.windows[0]?.status).toBe('ok');
  });

  it('marks a rejected reading exhausted even with no utilization', () => {
    store.recordClaudeRateLimit(
      { status: 'rejected', resetsAt: 1787339400, rateLimitType: 'five_hour' },
      NOW,
    );
    expect(store.getState(NOW).claude?.windows[0]?.status).toBe('exhausted');
  });

  it('REFUSES a reading that names no window', () => {
    // 4 production rows look like this: no rateLimitType, no utilization. There
    // is no window it could correctly update.
    store.recordClaudeRateLimit({ status: 'allowed' }, NOW);
    expect(store.getState(NOW).claude).toBeUndefined();
  });
});

describe('ProviderUsageStore — Codex ingest', () => {
  let store: ProviderUsageStore;
  beforeEach(() => { store = new ProviderUsageStore(); });

  it('records the primary window with its plan and converted reset', () => {
    store.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    const snapshot = store.getState(NOW).codex;
    expect(snapshot?.planType).toBe('prolite');
    expect(snapshot?.windows).toHaveLength(1);
    expect(snapshot?.windows[0]).toMatchObject({
      kind: 'codex_primary',
      label: 'Weekly',
      usedPercent: 59,
      windowMinutes: 10080,
      resetsAtMs: 1787236263 * 1000,
      status: 'warning',
    });
  });

  it('IGNORES a frame for a different limitId', () => {
    store.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    // A `premium`/credits frame describes another limit entirely; letting it
    // through would blank the codex card.
    store.recordCodexRateLimits(
      { limitId: 'premium', primary: null, secondary: null, planType: null },
      NOW + 1000,
    );
    expect(store.getState(NOW).codex?.windows).toHaveLength(1);
  });

  it('DELETES a window the provider stops reporting (each frame is authoritative)', () => {
    store.recordCodexRateLimits(
      {
        ...CAPTURED_CODEX,
        secondary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1787236263 },
      },
      NOW,
    );
    expect(store.getState(NOW).codex?.windows).toHaveLength(2);

    store.recordCodexRateLimits(CAPTURED_CODEX, NOW + 1000);
    expect(store.getState(NOW).codex?.windows.map((w) => w.kind)).toEqual(['codex_primary']);
  });

  it('drops the provider entirely when a frame reports no windows at all', () => {
    store.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    store.recordCodexRateLimits({ ...CAPTURED_CODEX, primary: null }, NOW + 1000);
    expect(store.getState(NOW).codex).toBeUndefined();
  });

  it('sorts the most-constrained window first', () => {
    store.recordCodexRateLimits(
      {
        limitId: 'codex',
        primary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1787236263 },
        secondary: { usedPercent: 88, windowDurationMins: 300, resetsAt: 1787236263 },
        planType: 'prolite',
      },
      NOW,
    );
    expect(store.getState(NOW).codex?.windows[0]?.usedPercent).toBe(88);
  });
});

describe('ProviderUsageStore — expiry', () => {
  it('prunes a window whose reset has passed', () => {
    const store = new ProviderUsageStore();
    store.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    expect(store.getState(1787236263 * 1000 - 1).codex).toBeDefined();
    // A window that has already reset no longer describes current usage.
    expect(store.getState(1787236263 * 1000 + 1).codex).toBeUndefined();
  });

  it('expires a reset-less window by age instead of leaving it immortal', () => {
    const store = new ProviderUsageStore();
    store.recordClaudeRateLimit({ status: 'allowed', rateLimitType: 'five_hour' }, NOW);
    expect(store.getState(NOW).claude).toBeDefined();
    expect(store.getState(NOW + 13 * 60 * 60 * 1000).claude).toBeUndefined();
  });
});

describe('ProviderUsageStore — persistence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces the synchronous preference write', () => {
    const prefs = makePrefs();
    const spy = vi.spyOn(prefs, 'setUserPreference');
    const store = new ProviderUsageStore(prefs);

    store.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    store.recordCodexRateLimits(CAPTURED_CODEX, NOW + 1);
    store.recordCodexRateLimits(CAPTURED_CODEX, NOW + 2);
    // A busy sprint emits a reading per turn per lane; this is a main-thread write.
    expect(spy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('flush() writes immediately for the quit path', () => {
    const prefs = makePrefs();
    const store = new ProviderUsageStore(prefs);
    store.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    store.flush(NOW);
    expect(prefs.store.get(PROVIDER_USAGE_PREFERENCE_KEY)).toContain('codex_primary');
  });

  it('round-trips through hydrate', () => {
    const prefs = makePrefs();
    const first = new ProviderUsageStore(prefs);
    first.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    first.flush(NOW);

    const second = new ProviderUsageStore(prefs);
    second.hydrate(NOW);
    expect(second.getState(NOW).codex?.windows[0]?.usedPercent).toBe(59);
  });

  it('hydrate prunes windows that expired while the app was closed', () => {
    const prefs = makePrefs();
    const first = new ProviderUsageStore(prefs);
    first.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    first.flush(NOW);

    const second = new ProviderUsageStore(prefs);
    second.hydrate(1787236263 * 1000 + 1);
    expect(second.getState(1787236263 * 1000 + 1).codex).toBeUndefined();
  });

  it('treats malformed and structurally-invalid persisted values as empty', () => {
    for (const value of ['not json', '{"version":1}', '{"version":99,"providers":{}}',
      '{"version":1,"providers":{"claude":{"provider":"claude"}}}']) {
      const prefs = makePrefs();
      prefs.setUserPreference(PROVIDER_USAGE_PREFERENCE_KEY, value);
      const store = new ProviderUsageStore(prefs);
      expect(() => store.hydrate(NOW)).not.toThrow();
      expect(store.getState(NOW)).toEqual({});
    }
  });
});

describe('ProviderUsageStore — fail-soft', () => {
  it('does not let a throwing `changed` listener escape into the vendor call', () => {
    const store = new ProviderUsageStore();
    store.events.on('changed', () => { throw new Error('listener exploded'); });
    // A throw out of the Codex notification handler SIGTERMs the app-server's
    // whole process group; telemetry must never reach that path.
    expect(() => store.recordCodexRateLimits(CAPTURED_CODEX, NOW)).not.toThrow();
  });

  it('survives a preference backend that throws', () => {
    const store = new ProviderUsageStore({
      getUserPreference: () => { throw new Error('db down'); },
      setUserPreference: () => { throw new Error('db down'); },
    });
    expect(() => store.hydrate(NOW)).not.toThrow();
    store.recordCodexRateLimits(CAPTURED_CODEX, NOW);
    expect(() => store.flush(NOW)).not.toThrow();
  });
});
