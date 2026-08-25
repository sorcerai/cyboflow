/**
 * providerUsage — the shape of a provider's SUBSCRIPTION quota, as reported by
 * the provider itself, for the usage meters at the top of the Human review queue.
 *
 * ## This is observed, never computed
 *
 * Every field here is copied from a reading the vendor pushed at us. Nothing is
 * accumulated locally and nothing is inferred from token counts — tokens are not
 * quota, and a synthetic percentage would be a confident lie. A provider that has
 * not spoken recently is reported as stale, not as zero.
 *
 * ## The two providers do NOT report symmetrically
 *
 * - Codex (`account/rateLimits/updated`) always carries a real `usedPercent`.
 * - Claude (`rate_limit_event`) carries `utilization` only sometimes — across
 *   1362 production rows, every reading that had one was already at
 *   `allowed_warning` (`surpassedThreshold: 0.75`). The schema
 *   (shared/types/claudeStream.ts) makes it optional independently of `status`,
 *   so we accept a number under any status, but we must render correctly when
 *   there is none.
 *
 * Hence `usedPercent: number | null`. A null percent means "the provider did not
 * say" — it must never render as 0%.
 */

/** Providers with a subscription quota worth metering. OMP is out of scope. */
export type UsageProvider = 'claude' | 'codex';

/**
 * A single quota window. Claude's kinds mirror the SDK's `rateLimitType`; Codex
 * reports two unnamed slots, so they are keyed by slot.
 */
export type UsageWindowKind =
  | 'claude_five_hour'
  | 'claude_seven_day'
  | 'claude_seven_day_opus'
  | 'claude_seven_day_sonnet'
  | 'claude_seven_day_oauth_apps'
  | 'claude_seven_day_overage_included'
  | 'claude_overage'
  | 'codex_primary'
  | 'codex_secondary';

/**
 * Severity tiers. `exhausted` is terminal for the window — lanes on that provider
 * will park until it resets.
 */
export type UsageStatus = 'ok' | 'warning' | 'critical' | 'exhausted';

/**
 * Where a reading came from.
 *
 * - `poll`  — we ASKED, just now. Codex `account/rateLimits/read`, or Claude's
 *   `/usage` control request. Authoritative and current.
 * - `stream` — it fell out of a turn that happened to be running. Correct WHEN
 *   OBSERVED, but it only refreshes when a turn runs, so it can silently
 *   describe a world that has moved on. The UI says so.
 */
export type UsageSource = 'poll' | 'stream';

export interface ProviderUsageWindow {
  kind: UsageWindowKind;
  /** Display label ("5-hour session", "Weekly", "Weekly (Opus)"). */
  label: string;
  status: UsageStatus;
  /** 0-100, or null when the provider reported no number. NEVER coerce to 0. */
  usedPercent: number | null;
  /**
   * Provenance of `usedPercent` specifically — null when there is no percentage.
   *
   * Tracked separately from the window record because the two can diverge: a
   * stream reading that carries no `utilization` RETAINS the percentage from an
   * earlier reading, so the record is fresh while the number it shows is not.
   */
  percentSource: UsageSource | null;
  /**
   * When `usedPercent` was measured. May PREDATE `observedAtMs` for the retained
   * case above — that gap is exactly what the staleness warning is about.
   */
  percentObservedAtMs: number | null;
  /** Unix MILLISECONDS. Both providers report seconds on the wire; converted at ingest. */
  resetsAtMs: number | null;
  /** Window length in minutes. Codex reports it; Claude does not. */
  windowMinutes: number | null;
  /** Unix ms at which this window record was last updated by any reading. */
  observedAtMs: number;
}

/**
 * True when the displayed percentage came from a turn's event stream rather than
 * a direct poll, and so may describe a world that has moved on. A window with no
 * percentage is NOT "stale" — it is unknown, which the UI states differently.
 */
export function isPercentPossiblyStale(window: ProviderUsageWindow): boolean {
  return window.usedPercent !== null && window.percentSource === 'stream';
}

export interface ProviderUsageSnapshot {
  provider: UsageProvider;
  /** Most-constrained window first. */
  windows: ProviderUsageWindow[];
  /** Codex reports a plan ("prolite"); Claude does not. */
  planType: string | null;
  /** max(window.observedAtMs) — drives the "as of Xm ago" footer. */
  observedAtMs: number;
}

/** Both providers. A provider absent from the map has never reported. */
export type ProviderUsageState = Partial<Record<UsageProvider, ProviderUsageSnapshot>>;

// ---------------------------------------------------------------------------
// Tiering
// ---------------------------------------------------------------------------

/**
 * Status AND fill colour from one function, so the two can never disagree.
 *
 * An earlier draft reused `contextMeterClass` for the fill while deriving status
 * from a separate threshold table; at 51-79% that painted an amber bar under an
 * "OK" label. The boundaries below are deliberately the SAME as
 * `frontend/src/components/cyboflow/unified/contextUsage.ts` (>50 amber, >80
 * terracotta) so the usage meters and the context meter read as one family —
 * this adds only the `exhausted` tier at 100, which a context meter has no
 * equivalent for.
 */
export interface UsageTier {
  status: UsageStatus;
  /** Tailwind background class for the meter fill. */
  fillClass: string;
}

export function usageTier(percent: number): UsageTier {
  if (percent >= 100) return { status: 'exhausted', fillClass: 'bg-status-error' };
  if (percent > 80) return { status: 'critical', fillClass: 'bg-interactive' };
  if (percent > 50) return { status: 'warning', fillClass: 'bg-status-warning' };
  return { status: 'ok', fillClass: 'bg-status-success' };
}

/** Fill class for a window, including the no-number case (no fill at all). */
export function usageWindowFillClass(window: ProviderUsageWindow): string | null {
  if (window.usedPercent === null) return null;
  return usageTier(window.usedPercent).fillClass;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const USAGE_WINDOW_LABELS: Record<UsageWindowKind, string> = {
  claude_five_hour: '5-hour session',
  claude_seven_day: 'Weekly',
  claude_seven_day_opus: 'Weekly (Opus)',
  claude_seven_day_sonnet: 'Weekly (Sonnet)',
  claude_seven_day_oauth_apps: 'Weekly (OAuth apps)',
  claude_seven_day_overage_included: 'Weekly (incl. overage)',
  claude_overage: 'Overage',
  codex_primary: 'Primary',
  codex_secondary: 'Secondary',
};

export const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

/**
 * Sort key — most-constrained first. A window with no percent sorts after every
 * window that has one, since we cannot claim it is more or less constrained.
 */
export function compareWindowsByPressure(a: ProviderUsageWindow, b: ProviderUsageWindow): number {
  if (a.usedPercent === null && b.usedPercent === null) return a.kind.localeCompare(b.kind);
  if (a.usedPercent === null) return 1;
  if (b.usedPercent === null) return -1;
  return b.usedPercent - a.usedPercent;
}
