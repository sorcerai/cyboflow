import * as Sentry from '@sentry/electron/main';
import { initialize as aptabaseInitialize, trackEvent as aptabaseTrack } from '@aptabase/electron/main';
import { app } from 'electron';
import {
  scrubSentryEvent,
  scrubBreadcrumb,
  isBenignStreamWriteEpipe,
  tagCrashSource,
} from './scrub';
import { resolveTelemetryCredentials } from './credentials';
import { recordLocalError } from './diagnostics';
import type { TelemetryEventMap, TelemetryEventName } from '../../../../shared/types/telemetry';

export type { TelemetryEnvironment } from './environment';

// Module-level singleton state. Both stay false until the corresponding SDK is
// successfully initialized (env credential present AND config flag enabled), so
// every telemetry entry point is a silent no-op when credentials are absent.
let sentryActive = false;
let aptabaseActive = false;

/**
 * Initialize error reporting (Sentry) and usage metrics (Aptabase) from the
 * resolved telemetry config. Each SDK is only initialized when its config flag
 * is enabled AND its credential env var is present; otherwise it is skipped
 * silently. Telemetry must never throw into app code.
 *
 * The config flag is the single control: packaged (.dmg) builds default it ON
 * (opt-out), unpackaged `pnpm` builds default it OFF but leave it toggleable in
 * Settings (see configManager.defaultTelemetryEnabled). When the flag is on and
 * the credential env var is present, telemetry initializes regardless of build
 * type — so a developer can opt a local build in. The resolved `environment`
 * ('local' / 'dev' / 'stable') is still attached to every event.
 */
export function initTelemetry(cfg: {
  errorReportingEnabled: boolean;
  usageMetricsEnabled: boolean;
  installId: string;
}): void {
  // Credential + environment resolution lives in ./credentials so the in-app bug
  // reporter can resolve the same DSN without duplicating the asar-path lookup.
  const { sentryDsn, aptabaseAppKey, environment } = resolveTelemetryCredentials();

  // Gated purely on the config flag + credential presence. Local builds default
  // the flag off, but an opted-in developer (flag on + DSN present) gets it.
  if (cfg.errorReportingEnabled && sentryDsn) {
    try {
      Sentry.init({
        dsn: sentryDsn,
        release: app.getVersion(),
        environment,
        // Scrub every outbound event/breadcrumb so user source code, file
        // paths, repo names and prompts never leave the machine.
        // Drop benign broken-pipe writes before scrubbing — the app already
        // swallows EPIPE at the process level, so these are duplicate noise
        // (see isBenignStreamWriteEpipe). Everything else is scrubbed + kept.
        // Native crashes are additionally tagged by provenance first: the
        // crashpad handler catches processes spawned BENEATH the app too, so a
        // minidump is not self-evidently ours (see tagCrashSource). Scrubbing
        // stays the outermost step — nothing leaves without passing it.
        beforeSend: (event) =>
          isBenignStreamWriteEpipe(event) ? null : scrubSentryEvent(tagCrashSource(event)),
        beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
      });
      // Default integrations capture uncaught exceptions / unhandled
      // rejections — no manual process handlers needed.
      sentryActive = true;
    } catch {
      // Telemetry init must never break the app boot.
      sentryActive = false;
    }
  }

  // Same posture for usage metrics: governed by the config flag (default off on
  // local builds, on for .dmg) plus the Aptabase app key.
  if (cfg.usageMetricsEnabled && aptabaseAppKey) {
    try {
      aptabaseInitialize(aptabaseAppKey);
      aptabaseActive = true;
      trackUsage('app_started', { environment });
    } catch {
      aptabaseActive = false;
    }
  }
}

function emitUsage(name: string, props?: Record<string, string | number | boolean>): void {
  if (!aptabaseActive) return;
  try {
    aptabaseTrack(name, props);
  } catch {
    // Swallow — telemetry must never throw into app code.
  }
}

/**
 * Record an anonymous usage event (typed against the shared `TelemetryEventMap`).
 * For main-process call sites. No-op unless Aptabase was initialized; never throws.
 */
export function trackUsage<E extends TelemetryEventName>(
  event: E,
  props?: TelemetryEventMap[E],
): void {
  emitUsage(event, props as Record<string, string | number | boolean> | undefined);
}

/**
 * Forward a renderer-originated usage event over the `telemetry:track` IPC boundary.
 * The event/props were already type-checked at the renderer's `trackEvent`; here they
 * arrive as opaque JSON, so this entry point is intentionally stringly-typed.
 */
export function trackUsageFromRenderer(
  eventName: string,
  props?: Record<string, string | number | boolean>,
): void {
  emitUsage(eventName, props);
}

/** Whether Sentry error reporting was successfully initialized this boot. */
export function isSentryActive(): boolean {
  return sentryActive;
}

/**
 * Capture a HANDLED error at a named seam. Sentry's default integrations only
 * see uncaught exceptions / unhandled rejections, so failure paths the app
 * catches and surfaces in the UI (CLI unavailable, spawn timeouts) are
 * invisible without an explicit capture like this.
 *
 * No-op unless Sentry initialized; never throws into app code.
 *
 * Payload rules (see scrub.ts): the `extra` bag is DELETED by scrubSentryEvent,
 * so context must ride in `tags` — low-cardinality, non-PII values only (seam
 * names, substrate, platform). Detail belongs in the error MESSAGE, which
 * beforeSend home-path-redacts automatically.
 */
export function captureSeamError(
  seam: string,
  error: unknown,
  tags?: Record<string, string>,
): void {
  // Record locally FIRST, unconditionally. The Sentry guard below returns early
  // when reporting is off — and that is precisely when a user is most likely to
  // file a bug report by hand, so a buffer fed after the guard would always be
  // empty in the case it exists to serve.
  recordLocalError(seam, error, new Date().toISOString());

  if (!sentryActive) return;
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    Sentry.captureException(err, { tags: { seam, ...tags } });
  } catch {
    // Telemetry must never throw into app code.
  }
}
