/**
 * ProviderUsageCards — subscription headroom for Claude and Codex, at the top of
 * the Human review queue.
 *
 * ## Why it lives here
 *
 * This is the surface where you decide what to unblock next, and "is there quota
 * left to run it" is part of that decision. A lane that parks on an exhausted
 * window looks identical to a lane waiting on a human until you know the window
 * is gone.
 *
 * ## The two providers do not report the same thing
 *
 * Codex always sends a real `usedPercent`. Claude sends `utilization` only
 * sometimes — so the RESET COUNTDOWN, which we always have, carries each row,
 * and the percentage is an enrichment. A window with no percentage renders an
 * EMPTY track and a status word; it must never render as 0%, which would read
 * as "plenty left".
 *
 * Every window counts down SEPARATELY. A single headline countdown could only
 * describe one window, and the windows expire on unrelated clocks — the weekly
 * one is usually the most constrained, so a headline would systematically hide
 * the thing most often asked for: when the 5-hour session comes back.
 *
 * Expiry is evaluated at render against a ticking clock rather than trusted from
 * the store: a mounted card would otherwise sit past a window's reset until the
 * next push arrived. The ticker is renderer-side on purpose — a main-process
 * timer costs more than its callback (docs/PERFORMANCE.md).
 */
import React, { useEffect, useState } from 'react';
import { useProviderUsageSlice } from '../../stores/providerUsageSlice';
import { useAgentProviderAccess } from '../../hooks/useAgentProviderAccess';
import { isAgentProviderEnabled } from '../../../../shared/types/agentRuntime';
import {
  USAGE_PROVIDER_LABELS,
  isPercentPossiblyStale,
  usageWindowFillClass,
  type ProviderUsageSnapshot,
  type ProviderUsageWindow,
  type UsageProvider,
  type UsageStatus,
} from '../../../../shared/types/providerUsage';

/** How often the render clock advances. Windows are minutes-to-days long. */
const TICK_MS = 30_000;

/**
 * How often to ask the providers directly while this view is open. The poll is
 * single-flight and rate-limited in the main process, so this only sets an upper
 * bound on freshness — it cannot stampede a provider.
 */
const REFRESH_MS = 5 * 60_000;

/** A reading older than this is called out as stale rather than shown plainly. */
const STALE_AFTER_MS = 30 * 60 * 1_000;

const STATUS_WORD: Record<UsageStatus, string> = {
  ok: 'OK',
  warning: 'Watch',
  critical: 'Low',
  exhausted: 'Exhausted',
};

const STATUS_TEXT_CLASS: Record<UsageStatus, string> = {
  ok: 'text-text-tertiary',
  warning: 'text-status-warning',
  critical: 'text-interactive',
  exhausted: 'text-status-error',
};

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** "3h 10m" / "18m". Null when there is no reset to count down to. */
function formatTimeLeft(resetsAtMs: number | null, nowMs: number): string | null {
  if (resetsAtMs === null) return null;
  const remainingMs = resetsAtMs - nowMs;
  if (remainingMs <= 0) return null;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * A reset more than a day out needs a DATE, not just a clock: "resets 9:00 AM"
 * for a window that resets five days from now reads as this morning.
 */
function formatResetClock(resetsAtMs: number | null, nowMs: number): string | null {
  if (resetsAtMs === null) return null;
  const at = new Date(resetsAtMs);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (resetsAtMs - nowMs < 24 * 60 * 60 * 1_000) return time;
  return `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function formatAge(observedAtMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs - observedAtMs) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function UsageMeterRow({
  window: usageWindow,
  nowMs,
}: {
  window: ProviderUsageWindow;
  nowMs: number;
}): React.ReactElement {
  const fillClass = usageWindowFillClass(usageWindow);
  // Every window carries its OWN countdown, not just the leading one: the
  // 5-hour session and the weekly window expire on completely different clocks,
  // and "how long until the session resets" is the question this card is most
  // often opened to answer.
  const timeLeft = formatTimeLeft(usageWindow.resetsAtMs, nowMs);
  const resetClock = formatResetClock(usageWindow.resetsAtMs, nowMs);
  return (
    <div className="flex items-center gap-2.5 text-xs" data-testid={`usage-window-${usageWindow.kind}`}>
      <span className="w-[104px] shrink-0 truncate text-text-secondary">{usageWindow.label}</span>
      {/* Meter anatomy matches ChatMetaStrip's context meter so the two read as
          one family: 6px track, 1px border, sunken fill, absolute bar. */}
      <span
        className="relative h-1.5 w-[84px] shrink-0 overflow-hidden border border-border-primary bg-surface-sunken"
        aria-hidden
      >
        {fillClass !== null && (
          <span
            className={`absolute inset-y-0 left-0 ${fillClass}`}
            style={{ width: `${Math.min(usageWindow.usedPercent ?? 0, 100)}%` }}
          />
        )}
      </span>
      {usageWindow.usedPercent === null ? (
        // NOT "0%" — the provider did not report a number, and an empty meter
        // with a number next to it would read as "nothing used yet".
        <span className={STATUS_TEXT_CLASS[usageWindow.status]} data-testid="usage-no-percent">
          {STATUS_WORD[usageWindow.status]}
        </span>
      ) : (
        <span className="w-9 shrink-0 text-right tabular-nums text-text-primary">
          {Math.round(usageWindow.usedPercent)}%
        </span>
      )}
      {timeLeft !== null && (
        <span
          className="truncate tabular-nums text-text-tertiary"
          title={resetClock === null ? undefined : `Resets ${resetClock}`}
          data-testid="usage-window-time-left"
        >
          {timeLeft} left
        </span>
      )}
      {isPercentPossiblyStale(usageWindow) && (
        // This number fell out of a turn's event stream rather than a direct
        // poll, so it only refreshed when a turn happened to run. Say so
        // rather than presenting it with the same confidence as a poll.
        <span
          className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-status-warning"
          title="Read from a running turn rather than a direct query — may be out of date"
          data-testid="usage-stale-flag"
        >
          may be stale
        </span>
      )}
    </div>
  );
}

function ProviderCard({
  snapshot,
  nowMs,
}: {
  snapshot: ProviderUsageSnapshot;
  nowMs: number;
}): React.ReactElement {
  const isStale = nowMs - snapshot.observedAtMs > STALE_AFTER_MS;

  return (
    <div
      className="border border-border-primary bg-bg-secondary px-4 py-3"
      data-testid={`usage-card-${snapshot.provider}`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-bold text-text-primary">
          {USAGE_PROVIDER_LABELS[snapshot.provider]}
        </span>
        {snapshot.planType !== null && (
          <span className="eyebrow text-text-tertiary">{snapshot.planType}</span>
        )}
      </div>

      <div className="mt-2 flex flex-col gap-1.5">
        {snapshot.windows.map((w) => <UsageMeterRow key={w.kind} window={w} nowMs={nowMs} />)}
      </div>

      <div className={`mt-2 text-[11px] ${isStale ? 'text-status-warning' : 'text-text-muted'}`}>
        as of {formatAge(snapshot.observedAtMs, nowMs)}
        {isStale && ' — no recent reading'}
      </div>
    </div>
  );
}

export function ProviderUsageCards(): React.ReactElement | null {
  const usage = useProviderUsageSlice((s) => s.usage);
  const init = useProviderUsageSlice((s) => s.init);
  const refresh = useProviderUsageSlice((s) => s.refresh);
  const providerAccess = useAgentProviderAccess();
  const nowMs = useNow();

  useEffect(() => init(), [init]);

  // Ask the providers on mount and periodically thereafter. Without this the
  // meters would show only whatever a turn happened to mention — which for
  // Claude means no percentage at all until it crosses its warning threshold.
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { void refresh(); }, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const visible = (['claude', 'codex'] as UsageProvider[])
    .filter((provider) => isAgentProviderEnabled(providerAccess, provider))
    .map((provider) => usage[provider])
    .filter((snapshot): snapshot is ProviderUsageSnapshot => snapshot !== undefined)
    // The store prunes on read, but a card mounted across a reset needs the
    // check re-run against the live clock.
    .map((snapshot) => ({
      ...snapshot,
      windows: snapshot.windows.filter((w) => w.resetsAtMs === null || w.resetsAtMs > nowMs),
    }))
    .filter((snapshot) => snapshot.windows.length > 0);

  // Nothing to say: no card, no empty shell. Readings arrive opportunistically
  // while turns run, so "nothing yet" is a normal state, not an error.
  if (visible.length === 0) return null;

  return (
    <div className="mb-4 grid gap-3 sm:grid-cols-2" data-testid="provider-usage-cards">
      {visible.map((snapshot) => (
        <ProviderCard key={snapshot.provider} snapshot={snapshot} nowMs={nowMs} />
      ))}
    </div>
  );
}
