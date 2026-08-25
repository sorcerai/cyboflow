/**
 * artifactFrameGuard — confine a static-mockup `ui-prototype`/`generic` artifact
 * frame to its own document (IDEA-039 / Approach C security).
 *
 * A static mockup renders via `<iframe srcDoc sandbox="">` (url `about:srcdoc`).
 * The bare sandbox disables scripts and the injected CSP `<meta>` blocks
 * subresource fetches, but NEITHER stops a USER-initiated link navigation: a
 * prototype's `<a href="https://attacker/beacon">` click would navigate the
 * frame itself and issue a network request the CSP no longer governs. The main
 * process therefore intercepts `will-frame-navigate` and blocks any navigation of
 * an `about:srcdoc` frame to a non-`about:` URL.
 *
 * Scope is deliberately narrow (only `about:srcdoc` sub-frames): the app's own
 * main frame and the LEGACY localhost dev-server prototype iframe (a real
 * cross-origin app at `http://localhost:…`, which legitimately navigates itself)
 * are left untouched.
 */

/**
 * Whether a `will-frame-navigate` should be BLOCKED. Pure so it can be unit
 * tested without Electron.
 *
 * @param frameUrl    the current url of the frame being navigated (`details.frame?.url`)
 * @param targetUrl   the url it wants to navigate to (`details.url`)
 * @param isMainFrame whether the navigating frame is the top frame (`details.isMainFrame`)
 */
export function shouldBlockArtifactFrameNavigation(
  frameUrl: string,
  targetUrl: string,
  isMainFrame: boolean,
): boolean {
  // Never confine the app's own top frame.
  if (isMainFrame) return false;
  // Only static-mockup srcdoc frames — a localhost dev-server frame (http(s)) or
  // any other sub-frame is left alone.
  if (!frameUrl.startsWith('about:srcdoc')) return false;
  // Allow the initial `about:srcdoc` load and `about:blank` — block everything
  // else (http(s), data:, file:, custom schemes) so nothing leaves the frame.
  if (targetUrl.startsWith('about:')) return false;
  return true;
}

/** Whether a blocked target should instead be offered to the OS browser. */
export function isExternallyOpenable(targetUrl: string): boolean {
  return /^https?:\/\//i.test(targetUrl);
}

/**
 * Scheme allowlist for `shell.openExternal` on RENDERER-SUPPLIED urls — the
 * `openExternal` IPC channel and the main window's `setWindowOpenHandler`.
 *
 * `shell.openExternal` hands the string to the OS launcher, so it is not a
 * "browser" call: `file:` opens local documents in their registered app,
 * platform schemes (`x-apple.systempreferences:`, `ms-settings:`) drive system
 * UI, and an arbitrary custom scheme reaches whatever app claimed it. Both
 * call sites take their url straight from the renderer, so anything a renderer
 * XSS can put in a link would otherwise become an OS-level launch.
 *
 * Deliberately WIDER than {@link isExternallyOpenable} by exactly `mailto:`:
 * that one governs a HOSTILE artifact/prototype frame, where a mail composer is
 * not something a mockup should be able to pop; this one governs the app's own
 * chrome, where "email support" is a real link. Keep them separate — widening
 * `isExternallyOpenable` would widen the hostile-frame rule too.
 */
export function isSafeExternalOpenTarget(targetUrl: string): boolean {
  let protocol: string;
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    return false;
  }
  return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
}

// ===========================================================================
// Scripted-frame navigation guard (Design Mode v1 — design-mode.md "Frame
// navigation — no external open for scripted frames").
//
// The interactive prototype canvas serves the blessed document from a
// token-gated loopback origin and runs its JS in a script-enabled OOPIF frame.
// The srcdoc guard above is wrong for this frame class in TWO ways:
//   1. it keys on `about:srcdoc` — a loopback-origin frame is `http://127.0.0.1:…`;
//   2. it offers blocked `http(s)` targets to `shell.openExternal` — for a
//      SCRIPT-enabled frame that turns `window.location = 'https://…/?<secrets>'`
//      into OS-browser egress (URL-encoded exfiltration, browser spam) even
//      though the frame itself stays confined.
// So scripted frames get their OWN guard keyed to an explicit artifact-frame
// identity: the set of live loopback ORIGINS the prototype server registers.
// The rule is "stay on your own origin, and NOTHING leaves via the OS browser".
//
// The origin registry is process-global (mirroring how the loopback servers are
// process-global) — DesignPrototypeServerManager registers each server's origin
// on spawn and unregisters on stop. The decision function is kept PURE (origins
// passed in) so it unit-tests without touching the registry; a thin
// `…FromRegistry` wrapper reads the live set for the `will-frame-navigate` seam.
// ===========================================================================

/**
 * Live loopback origins (`http://127.0.0.1:<port>`) of the currently-running
 * interactive prototype servers. A frame whose CURRENT url is within one of
 * these is a scripted artifact frame and is confined by
 * {@link shouldBlockScriptedFrameNavigation}.
 */
const scriptedFrameOrigins = new Set<string>();

/** Register a live prototype-server origin as a scripted artifact-frame identity. */
export function registerScriptedFrameOrigin(origin: string): void {
  scriptedFrameOrigins.add(origin);
}

/** Drop a prototype-server origin when its server stops. Idempotent. */
export function unregisterScriptedFrameOrigin(origin: string): void {
  scriptedFrameOrigins.delete(origin);
}

/** Test/introspection helper — a snapshot of the currently registered origins. */
export function scriptedFrameOriginsSnapshot(): string[] {
  return [...scriptedFrameOrigins];
}

/**
 * The registered origin that CONTAINS `url` (exact origin, or origin + '/…'),
 * else null. The `+ '/'` boundary is deliberate: it prevents a sibling-port
 * prefix confusion (`http://127.0.0.1:8080` must NOT match a target at
 * `http://127.0.0.1:80801`) — a bare-origin target still matches via the
 * exact-equality arm (reload/respawn navigates to the origin itself).
 */
function containingOrigin(url: string, origins: ReadonlySet<string>): string | null {
  for (const origin of origins) {
    if (url === origin || url.startsWith(origin + '/')) return origin;
  }
  return null;
}

/**
 * The path segment (directly under the per-spawn token) that marks a hosted
 * COMMENT document — mirrors `COMMENT_PATH_SEGMENT` in designPrototypeServer.ts.
 */
const COMMENT_DOC_PATH_RE = /^\/[^/]+\/comment\//;

/**
 * Whether `url` addresses a comment document on `origin` — i.e. the frame is a
 * COMMENT frame, not a prototype frame. Both classes live on the same loopback
 * origin (the comment capture rides the run's existing prototype server), so the
 * two are distinguished by path.
 */
function isCommentDocumentUrl(url: string, origin: string): boolean {
  const rest = url.slice(origin.length).split(/[?#]/)[0] ?? '';
  return COMMENT_DOC_PATH_RE.test(rest);
}

/**
 * Whether a `will-frame-navigate` of a SCRIPTED artifact frame should be
 * BLOCKED. Pure so it unit-tests without Electron (origins passed explicitly).
 *
 * Rule (design-mode.md "Frame navigation"):
 *   - never confine the app's own top frame;
 *   - a COMMENT frame (a frozen, sanitized capture — design-mode.md "Comment
 *     mode") is confined HARDER than a prototype frame: EVERY navigation is
 *     blocked, same-origin included. CSP does not govern document navigation, so
 *     this is the only thing standing between a captured `<a href>` / form
 *     submit / meta refresh and the frame moving off the freeze the user is
 *     commenting on. A prototype frame legitimately re-navigates same-origin
 *     (reload / respawn); a comment frame has nothing to re-navigate TO — its
 *     bytes are replaced by hosting a NEW capture at a new URL, which the parent
 *     drives by setting `src` on a fresh/blank frame (the initial-load arm below);
 *   - any other frame whose CURRENT url is within a registered origin may navigate ONLY
 *     to a target within that SAME origin (covers reload / respawn / same-origin
 *     hops — the server only ever serves the one blessed doc anyway); EVERYTHING
 *     else is blocked, including `about:`, `data:`, `file:`, and cross-origin
 *     `http(s)`;
 *   - the INITIAL load — an `about:blank`/empty frame navigating TO a registered
 *     origin — is allowed (the iframe's first navigation to its src);
 *   - a frame that is not a registered-origin frame (and not that initial load)
 *     is NOT ours — returns false so the srcdoc guard / default handling applies.
 *
 * There is NO external-open branch: unlike {@link shouldBlockArtifactFrameNavigation},
 * a blocked scripted-frame target is NEVER offered to `shell.openExternal`.
 *
 * @param frameUrl          the frame's current url (`details.frame?.url`)
 * @param targetUrl         the url it wants to navigate to (`details.url`)
 * @param isMainFrame       whether the navigating frame is the top frame
 * @param registeredOrigins the live scripted-frame origins to judge against
 */
export function shouldBlockScriptedFrameNavigation(
  frameUrl: string,
  targetUrl: string,
  isMainFrame: boolean,
  registeredOrigins: ReadonlySet<string>,
): boolean {
  // Never confine the app's own top frame.
  if (isMainFrame) return false;

  const currentOrigin = containingOrigin(frameUrl, registeredOrigins);
  if (currentOrigin !== null) {
    // Comment frame: block EVERY navigation, same-origin and about: included.
    if (isCommentDocumentUrl(frameUrl, currentOrigin)) return true;
    // Prototype frame: allow only same-origin targets, block everything else.
    return containingOrigin(targetUrl, new Set([currentOrigin])) === null;
  }

  // Initial iframe load: about:blank/empty → a registered origin is allowed so
  // the frame can reach its src (and its post-kill respawn, which re-navigates
  // from a fresh about:blank).
  if ((frameUrl === '' || frameUrl === 'about:blank') && containingOrigin(targetUrl, registeredOrigins) !== null) {
    return false;
  }

  // Not a scripted artifact frame — leave to the srcdoc guard / default handling.
  return false;
}

/**
 * Convenience wrapper over {@link shouldBlockScriptedFrameNavigation} that reads
 * the live module registry — the form the `will-frame-navigate` handler calls.
 */
export function shouldBlockScriptedFrameNavigationFromRegistry(
  frameUrl: string,
  targetUrl: string,
  isMainFrame: boolean,
): boolean {
  return shouldBlockScriptedFrameNavigation(frameUrl, targetUrl, isMainFrame, scriptedFrameOrigins);
}
