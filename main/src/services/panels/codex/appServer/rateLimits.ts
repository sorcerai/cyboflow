/**
 * Codex `account/rateLimits/updated` — the app-server's subscription-quota push.
 *
 * Shape observed in production:
 * ```json
 * {"method":"account/rateLimits/updated","params":{"rateLimits":{
 *   "limitId":"codex","limitName":null,
 *   "primary":{"usedPercent":59,"windowDurationMins":10080,"resetsAt":1787236263},
 *   "secondary":null,
 *   "credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
 *   "individualLimit":null,"planType":"prolite","rateLimitReachedType":null}}}
 * ```
 *
 * `limitId` varies (`codex`, `premium`, …) and `primary`/`secondary` are
 * independently nullable — a `premium` frame carries neither window. The caller
 * filters on `limitId`; this module only reports what arrived.
 *
 * Parsing NEVER throws. This runs inside `CodexAppServerClient`'s notification
 * handler, where an escaping exception reaches `fail()` and SIGTERMs the
 * app-server's whole process group mid-turn. An unrecognised payload is `null`.
 */

export interface CodexRateLimitWindow {
  /** 0-100 as reported by the provider. */
  usedPercent: number;
  /** Window length in minutes (10080 = weekly). */
  windowDurationMins: number | null;
  /** Epoch SECONDS. */
  resetsAt: number | null;
}

export interface CodexRateLimits {
  limitId: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
}

export const CODEX_RATE_LIMITS_NOTIFICATION_METHOD = 'account/rateLimits/updated';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseWindow(value: unknown): CodexRateLimitWindow | null {
  if (!isRecord(value)) return null;
  const usedPercent = optionalNumber(value.usedPercent);
  // A slot without a usable percentage is no better than an absent slot.
  if (usedPercent === null) return null;
  return {
    usedPercent,
    windowDurationMins: optionalNumber(value.windowDurationMins),
    resetsAt: optionalNumber(value.resetsAt),
  };
}

/**
 * Parse the `params` of an `account/rateLimits/updated` notification.
 * Returns null for anything that is not a recognisable rateLimits payload.
 */
export function parseCodexRateLimitsNotification(params: unknown): CodexRateLimits | null {
  try {
    if (!isRecord(params)) return null;
    const rateLimits = params.rateLimits;
    if (!isRecord(rateLimits)) return null;
    return {
      limitId: optionalString(rateLimits.limitId),
      primary: parseWindow(rateLimits.primary),
      secondary: parseWindow(rateLimits.secondary),
      planType: optionalString(rateLimits.planType),
    };
  } catch {
    return null;
  }
}
