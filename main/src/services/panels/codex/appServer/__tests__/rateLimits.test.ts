/**
 * Codex rateLimits parser tests — driven by verbatim production captures.
 */
import { describe, it, expect } from 'vitest';
import { parseCodexRateLimitsNotification } from '../rateLimits';

const POPULATED = JSON.parse(
  '{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex",'
  + '"limitName":null,"primary":{"usedPercent":59,"windowDurationMins":10080,'
  + '"resetsAt":1787236263},"secondary":null,"credits":{"hasCredits":false,'
  + '"unlimited":false,"balance":"0"},"individualLimit":null,"planType":"prolite",'
  + '"rateLimitReachedType":null}}}',
) as { params: unknown };

const EMPTY_PREMIUM = JSON.parse(
  '{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"premium",'
  + '"limitName":null,"primary":null,"secondary":null,"credits":{"hasCredits":false,'
  + '"unlimited":false,"balance":"0"},"individualLimit":null,"planType":null,'
  + '"rateLimitReachedType":null}}}',
) as { params: unknown };

describe('parseCodexRateLimitsNotification', () => {
  it('parses a captured populated frame', () => {
    expect(parseCodexRateLimitsNotification(POPULATED.params)).toEqual({
      limitId: 'codex',
      primary: { usedPercent: 59, windowDurationMins: 10080, resetsAt: 1787236263 },
      secondary: null,
      planType: 'prolite',
    });
  });

  it('parses a captured premium frame with both slots null', () => {
    const parsed = parseCodexRateLimitsNotification(EMPTY_PREMIUM.params);
    expect(parsed?.limitId).toBe('premium');
    expect(parsed?.primary).toBeNull();
    expect(parsed?.secondary).toBeNull();
  });

  it('treats a slot with no usable percentage as absent, not as zero', () => {
    const parsed = parseCodexRateLimitsNotification({
      rateLimits: { limitId: 'codex', primary: { windowDurationMins: 300 }, secondary: null },
    });
    expect(parsed?.primary).toBeNull();
  });

  it('returns null for unrecognised payloads instead of throwing', () => {
    // An escaping throw here reaches CodexAppServerClient.fail(), which SIGTERMs
    // the app-server's process group mid-turn.
    for (const value of [undefined, null, 'nope', 42, {}, { rateLimits: null }, { rateLimits: 7 }]) {
      expect(parseCodexRateLimitsNotification(value)).toBeNull();
    }
  });
});
