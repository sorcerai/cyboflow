/**
 * Version discipline for the OMP CLI (oh-my-pi, omp.sh).
 *
 * OMP releases near-daily — 683 changelog entries in ~9 months per the
 * proposal's fact §2.8 — with majors incrementing weekly and breaking changes
 * flagged in the changelog. A hard equality pin, the shape Codex uses
 * (`CODEX_EXECUTABLE_VERSION`), would break this integration constantly: we
 * spawn the USER's binary, not a bundled one, so an equality pin would refuse
 * every install within days of release.
 *
 * Instead OMP carries two numbers (proposal §3.4):
 *   - {@link OMP_MIN_SUPPORTED_VERSION} — a hard floor. A binary below this is
 *     refused (probes report 'unavailable') because it may predate behavior
 *     this integration depends on (the `--no-extensions`/`--no-skills`
 *     discovery-lockdown flags, the RPC `ready`-frame shape).
 *   - {@link OMP_TESTED_VERSION} — the newest version this integration has
 *     actually been verified against. A binary newer than this is still
 *     ACCEPTED (refusing it would put cyboflow permanently behind OMP's
 *     release cadence); callers log a one-time warning so the gap stays
 *     visible instead of silently drifting.
 *
 * docs/proposals/omp-provider-integration.md §3.4.
 */

/** Hard floor: a probed OMP binary below this version is refused. */
export const OMP_MIN_SUPPORTED_VERSION = '17.3.0';

/**
 * Newest version this integration has been verified against. Soft ceiling only
 * — never refuses, only warns.
 *
 * 17.3.5 was smoked end to end on 2026-08-21 against the real
 * `~/.local/bin/omp`: gate spawn, `PI_CONFIG_FILES` overlay, a human approval
 * answered after six minutes and executed, and both halves of the `hub`
 * argument classifier. Leaving the constant at 17.3.2 would keep warning about
 * a version this integration is now pinned to by
 * {@link OMP_CONFIGURABLE_HANDLER_TIMEOUT_VERSION}.
 */
export const OMP_TESTED_VERSION = '17.3.5';

export interface OmpParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse an OMP version string defensively. Accepts a bare `MAJOR.MINOR.PATCH`
 * or the `omp/MAJOR.MINOR.PATCH` form the real binary's `--version` output
 * uses (verified: v17.3.2 reports `omp/17.3.2`) — the regex only looks for the
 * first `\d+.\d+.\d+` run, so either form (and any surrounding prefix/suffix
 * text a future release adds) parses the same way. Returns null rather than
 * throwing on anything unrecognized: OMP's release cadence makes an
 * unparseable future format an expected event, not a bug, and callers must
 * degrade to "unavailable" rather than crash the probe.
 */
export function parseOmpVersion(raw: string): OmpParsedVersion | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Ascending comparator over parsed versions: negative/zero/positive like `Array.prototype.sort`. */
export function compareOmpVersions(a: OmpParsedVersion, b: OmpParsedVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export type OmpVersionPolicyVerdict =
  | { ok: true; aboveTested: boolean }
  | { ok: false; reason: 'unparseable' | 'below-floor' };

/**
 * Apply the floor+tested policy (see module doc) to a raw `--version` string.
 *  - Unparseable output → refuse, `reason: 'unparseable'`.
 *  - Below {@link OMP_MIN_SUPPORTED_VERSION} → refuse, `reason: 'below-floor'`.
 *  - At/above the floor → accept; `aboveTested: true` when the binary is newer
 *    than {@link OMP_TESTED_VERSION}, so the caller can log a one-time warning.
 */
export function evaluateOmpVersionPolicy(raw: string): OmpVersionPolicyVerdict {
  const parsed = parseOmpVersion(raw);
  if (!parsed) return { ok: false, reason: 'unparseable' };
  // Both constants are hardcoded valid `MAJOR.MINOR.PATCH` strings — non-null
  // by construction — but guard rather than assert past a compiler check.
  const floor = parseOmpVersion(OMP_MIN_SUPPORTED_VERSION);
  const tested = parseOmpVersion(OMP_TESTED_VERSION);
  if (!floor || !tested) return { ok: false, reason: 'unparseable' };
  if (compareOmpVersions(parsed, floor) < 0) return { ok: false, reason: 'below-floor' };
  return { ok: true, aboveTested: compareOmpVersions(parsed, tested) > 0 };
}

/**
 * The first OMP release whose `tool_call` extension-handler timeout is
 * CONFIGURABLE, rather than a hard 30s constant.
 *
 * Until 17.3.5 the cap was `EXTENSION_HANDLER_TIMEOUT_MS = 30_000` with no
 * env or settings override, which is why cyboflow's gate answers inside ~25s
 * and tells the model to retry (see `HUMAN_DECISION_BUDGET_MS` in
 * `gate/ompGateExtension.ts`). 17.3.5's changelog — "Made extension tool-call
 * timeouts configurable and paused them during user dialogs" — added the
 * `extensionHandlers.toolCallTimeoutMs` setting, read at
 * `extensibility/extensions/runner.ts` as
 * `O99(this.settings?.get('extensionHandlers.toolCallTimeoutMs') ?? 30000)`
 * where the validator accepts ANY positive finite number (there is no upper
 * clamp) and falls back to 30000 otherwise.
 *
 * This is an EXACT floor, read off the changelog of the shipped binary, not a
 * guess: 17.3.4 and earlier ignore the setting entirely and would still abort
 * the handler at 30s. Below this version cyboflow must not raise its own
 * decision budget, because a gate that waits longer than OMP allows loses the
 * chance to return its own reason (OMP substitutes "Extension ... timed out").
 */
export const OMP_CONFIGURABLE_HANDLER_TIMEOUT_VERSION = '17.3.5';

/**
 * Whether a probed OMP binary honors `extensionHandlers.toolCallTimeoutMs`.
 *
 * Unparseable input answers `false` — the conservative direction, since the
 * only cost of a false negative is keeping today's 25s budget, while a false
 * positive silently reintroduces the timeout it is meant to remove.
 */
export function supportsConfigurableHandlerTimeout(raw: string): boolean {
  const parsed = parseOmpVersion(raw);
  const floor = parseOmpVersion(OMP_CONFIGURABLE_HANDLER_TIMEOUT_VERSION);
  if (!parsed || !floor) return false;
  return compareOmpVersions(parsed, floor) >= 0;
}
