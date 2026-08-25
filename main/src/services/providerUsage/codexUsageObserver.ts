/**
 * The Codex half of the provider-usage ingest.
 *
 * Codex pushes `account/rateLimits/updated` over the app-server connection while
 * a turn runs. Every live app-server client forwards its notifications here.
 *
 * ## This function must never throw
 *
 * `CodexAppServerClient.handleNotification` catches an escaping exception and
 * calls `fail()`, which rejects every pending request and SIGTERMs the child's
 * WHOLE PROCESS GROUP — so a bug in a usage meter would kill a live codex turn,
 * or a warm parked process. Everything below is inside a catch-all, and callers
 * are expected to guard again at the call site.
 */
import { parseCodexRateLimitsNotification, CODEX_RATE_LIMITS_NOTIFICATION_METHOD } from '../panels/codex/appServer/rateLimits';
import { tryGetProviderUsageStore } from './providerUsageStore';

/**
 * Forward an app-server notification to the provider-usage store when it is a
 * rate-limits push. Any other method, an unparseable payload, or an
 * uninitialised store are all silent no-ops.
 */
export function observeCodexNotification(method: string, params: unknown): void {
  try {
    if (method !== CODEX_RATE_LIMITS_NOTIFICATION_METHOD) return;
    const rateLimits = parseCodexRateLimitsNotification(params);
    if (rateLimits === null) return;
    tryGetProviderUsageStore()?.recordCodexRateLimits(rateLimits);
  } catch {
    // Swallowed by design — see the module docstring. A throw here reaches
    // CodexAppServerClient.fail() and takes down the app-server process group.
  }
}
