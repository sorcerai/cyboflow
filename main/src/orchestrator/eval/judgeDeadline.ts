/**
 * judgeDeadline — the shared, PURE deadline curve for eval jury slots.
 *
 * Both juror boundaries (evalJudgeQuery for the Claude slots, codexEvalJudgeQuery
 * for the heterogeneous Codex slot) own their OWN base deadline, but they must
 * stretch it the same way: a juror grading a 200k-char diff is doing several times
 * the reading of one grading a 5k-char diff, and a flat wall makes exactly the
 * large-diff evals — the ones most worth grading — the ones that reproducibly miss
 * it. A whole-eval failure needs EVERY juror to miss the wall, but a single slot
 * timing out silently shrinks the jury (3 samples -> 2), so the curve is about
 * sample COUNT as much as it is about outright failure.
 *
 * Why a step function rather than a linear ramp: the deadline is a safety net for
 * a HUNG binary, not a budget the juror spends. Coarse steps keep the value
 * predictable (and log-greppable) while still tracking diff size.
 *
 * No imports — pure arithmetic, so both the SDK-touching and the app-server-touching
 * boundary can share it without dragging either module graph into the other.
 */

/**
 * Diff size that grades within the plain base deadline. Chosen above the diff
 * sizes the base was already tuned for (live runs showed ~35k-char diffs landing
 * inside 10 min even under host contention) so the common small-diff eval keeps
 * the exact wall it has today.
 */
export const JUDGE_DEADLINE_BASE_DIFF_CHARS = 50_000;

/** Every additional chunk of diff beyond the base size buys one step of headroom. */
export const JUDGE_DEADLINE_STEP_DIFF_CHARS = 50_000;

/** Headroom granted per step. */
export const JUDGE_DEADLINE_STEP_MS = 300_000;

/**
 * Hard ceiling on the stretched deadline. A juror past this is hung, not slow —
 * the eval is a background grade, but it still has to terminate.
 *
 * 60 min. The curve reaches 45 min at the diff-truncation cap
 * (evalJury.MAX_DIFF_CHARS = 400k) and saturates here at 500k chars, so the ceiling
 * binds only for diffs whose PROMPT is already capped — i.e. where the extra time
 * buys worktree exploration, not more reading. A stuck slot holds one of the three
 * judgeConcurrency 'normal' permits for that hour, which is survivable precisely
 * because the other two slots are unaffected; it is not a budget to spend freely.
 */
export const JUDGE_DEADLINE_MAX_MS = 3_600_000;

/**
 * Stretch `baseTimeoutMs` for a diff of `diffChars`. Returns the base unchanged for
 * a small/unknown diff, never returns LESS than the base (a caller with an already
 * generous base keeps it), and never exceeds JUDGE_DEADLINE_MAX_MS unless the base
 * itself already did.
 */
export function resolveJudgeDeadlineMs(baseTimeoutMs: number, diffChars?: number): number {
  if (typeof diffChars !== 'number' || !Number.isFinite(diffChars)) return baseTimeoutMs;
  if (diffChars <= JUDGE_DEADLINE_BASE_DIFF_CHARS) return baseTimeoutMs;
  const steps = Math.ceil(
    (diffChars - JUDGE_DEADLINE_BASE_DIFF_CHARS) / JUDGE_DEADLINE_STEP_DIFF_CHARS,
  );
  const stretched = baseTimeoutMs + steps * JUDGE_DEADLINE_STEP_MS;
  return Math.max(baseTimeoutMs, Math.min(stretched, JUDGE_DEADLINE_MAX_MS));
}
