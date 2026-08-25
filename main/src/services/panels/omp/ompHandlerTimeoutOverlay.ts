/**
 * ompHandlerTimeoutOverlay — raise OMP's `tool_call` extension-handler cap for
 * the sessions cyboflow spawns, so a human approval no longer has to be
 * answered inside ~25 seconds.
 *
 * ===========================================================================
 * THE PROBLEM THIS REMOVES
 * ===========================================================================
 * OMP aborts a `tool_call` handler at `extensionHandlers.toolCallTimeoutMs`
 * and converts the abort into `{ block: true }`. cyboflow's gate is such a
 * handler, and asking a human is the one thing it does that cannot be made
 * fast. With the cap at its 30s default the gate must hang up at ~25s
 * ({@link HUMAN_DECISION_BUDGET_MS}) and tell the model to retry, and the
 * approval it opened sits in the queue with nobody attached to it.
 *
 * That hangup/retry dance is survivable for one call — a live smoke on
 * 2026-08-20 watched a verdict given ~5 minutes late replay onto a retry in a
 * LATER turn and execute correctly. It stops being survivable once subagents
 * enter the picture, because every one of a subagent's calls pays the same
 * 25s, AND the parent's own `hub` wait is a gated call that times out while
 * its child is blocked. The measured cost of writing three bytes through one
 * subagent was about seven minutes of wall clock.
 *
 * ===========================================================================
 * THE SEAM — VERIFIED AGAINST THE SHIPPED BINARY (omp v17.3.5)
 * ===========================================================================
 * OMP 17.3.5 made the cap a setting ("Made extension tool-call timeouts
 * configurable and paused them during user dialogs" — see
 * {@link OMP_CONFIGURABLE_HANDLER_TIMEOUT_VERSION}). Its validator accepts any
 * positive finite number and there is NO UPPER CLAMP, so the value below is
 * honored verbatim.
 *
 * Settings reach a spawn through a `config.yml`-style overlay, which OMP takes
 * from EITHER `--config <path>` (repeatable) or the `PI_CONFIG_FILES` env var
 * (path-delimiter separated). We use the env var: this manager already injects
 * `CYBOFLOW_*` env for the gate, the value survives into OMP's own child
 * processes, and it keeps the argv — which is fingerprinted for warm-session
 * reuse — untouched.
 *
 * Measured, not assumed (`omp config get extensionHandlers.toolCallTimeoutMs`):
 *   - no overlay                     → 30000
 *   - PI_CONFIG_FILES=<this overlay> → the value written here
 *   - the user's own ~/.omp/agent/config.yml is NOT modified either way
 *
 * ===========================================================================
 * LANDMINE — A MISSING OR MALFORMED OVERLAY IS FATAL TO THE SPAWN
 * ===========================================================================
 * OMP does not skip an overlay it cannot read. It throws before the session
 * starts:
 *
 *   error: Config overlay not found: <path>
 *   error: Failed to parse config overlay <path>: YAML Parse error: ...
 *
 * So this module NEVER hands back a path it has not just written successfully,
 * and {@link composePiConfigFiles} is only ever called with a path that exists.
 * On any write failure the caller keeps today's behavior (30s cap, ~25s
 * budget) rather than spawning against a path that might not be there — a
 * slower gate is a far better failure than an OMP that will not start.
 *
 * The file lives at a STABLE path and is rewritten on every spawn. That is
 * deliberate on two counts: a per-spawn temp path would churn the spawn
 * fingerprint and defeat warm-session reuse, and rewriting repairs the file if
 * anything (a tmp reaper, a user) removed it between spawns.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { Logger } from '../../../utils/logger';

/**
 * How long OMP is asked to let a `tool_call` handler run — i.e. the longest a
 * human has to answer an OMP approval before the gate gives up on this call.
 *
 * Thirty minutes, chosen to be long enough that a human who steps away still
 * finds a live gate when they return, while staying a bounded number rather
 * than an infinity. The Claude substrates genuinely wait forever (their
 * transports hold the requester open with no cap), so this is still the
 * strictest of the three lanes.
 *
 * Not a free-for-all: the wait only ever happens with cyboflow's orchestrator
 * ALIVE and holding a pending approval. Every liveness failure — socket error,
 * close without a verdict, malformed frame — rejects immediately and never
 * reaches this budget (`requestSocketDecision`).
 */
export const OMP_HANDLER_TIMEOUT_MS = 1_800_000;

/**
 * Margin between OMP's cap and cyboflow's own budget, so the gate is always
 * the one that gives up FIRST and the model sees cyboflow's explanation
 * instead of OMP's generic "Extension <path> timed out after Nms".
 *
 * Larger than the 5s the 30s-era budget used, because the failure it guards
 * against is the same shape but the stakes are higher: at this timescale a
 * verdict frame arriving during teardown is worth absorbing comfortably.
 */
export const OMP_HANDLER_TIMEOUT_MARGIN_MS = 30_000;

/** The decision budget the gate is told to use when the raise is in effect. */
export const OMP_RAISED_DECISION_BUDGET_MS =
  OMP_HANDLER_TIMEOUT_MS - OMP_HANDLER_TIMEOUT_MARGIN_MS;

/** Basename of the overlay written under the cyboflow data directory. */
export const OMP_OVERLAY_FILENAME = 'handler-timeout.yml';

/**
 * The overlay body.
 *
 * NESTED yaml, not a dotted key: OMP resolves `settings.get('a.b')` against a
 * nested object (its own `~/.omp/agent/config.yml` writes `modelRoles.default`
 * the same way), so a literal `"extensionHandlers.toolCallTimeoutMs":` key
 * would parse fine and then never be found.
 *
 * Unknown keys ARE tolerated by the loader (verified), so the comment costs
 * nothing and explains the file to whoever finds it in the data directory.
 */
export function renderHandlerTimeoutOverlay(timeoutMs: number): string {
  return [
    '# Written by cyboflow. Raises OMP\'s tool_call extension-handler cap so a',
    '# human has time to answer an approval prompt. Safe to delete: cyboflow',
    '# rewrites it before every OMP spawn.',
    'extensionHandlers:',
    `  toolCallTimeoutMs: ${timeoutMs}`,
    '',
  ].join('\n');
}

/**
 * Write (or repair) the overlay and return its path, or `null` if it could not
 * be written.
 *
 * `null` is a supported outcome, not an error to propagate: the caller keeps
 * the unraised budget and the session still runs. Never returns a path that
 * does not exist on disk — see this module's landmine note.
 */
export function ensureHandlerTimeoutOverlay(
  directory: string,
  timeoutMs: number,
  logger?: Logger,
): string | null {
  const filePath = path.join(directory, OMP_OVERLAY_FILENAME);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(filePath, renderHandlerTimeoutOverlay(timeoutMs), 'utf8');
    return filePath;
  } catch (error) {
    logger?.warn(
      `[OmpSdkManager] could not write the OMP config overlay at ${filePath} ` +
        `(${error instanceof Error ? error.message : String(error)}); this session keeps OMP's ` +
        'default 30s extension-handler cap, so approvals must be answered quickly',
    );
    return null;
  }
}

/**
 * Compose the `PI_CONFIG_FILES` value, preserving anything the user already
 * set there.
 *
 * Ours goes LAST because later overlays win, and dropping a user's own entry
 * would silently discard their configuration. Empty segments are filtered out
 * so a stray delimiter cannot become an empty path — which OMP would then fail
 * to read, taking the whole spawn down with it.
 */
export function composePiConfigFiles(
  inherited: string | undefined,
  overlayPath: string,
): string {
  const existing = (inherited ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== overlayPath);
  return [...existing, overlayPath].join(path.delimiter);
}
