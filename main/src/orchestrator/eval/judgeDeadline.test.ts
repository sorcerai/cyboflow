/**
 * Unit tests for judgeDeadline — the shared deadline curve both juror boundaries
 * apply. Pure arithmetic, so these pin the CONTRACT (base preserved for a small
 * diff, monotonic, ceilinged) rather than exercising any SDK/app-server plumbing.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveJudgeDeadlineMs,
  JUDGE_DEADLINE_BASE_DIFF_CHARS,
  JUDGE_DEADLINE_STEP_DIFF_CHARS,
  JUDGE_DEADLINE_STEP_MS,
  JUDGE_DEADLINE_MAX_MS,
} from './judgeDeadline';
import { MAX_DIFF_CHARS } from './evalJury';

const BASE = 600_000;

describe('resolveJudgeDeadlineMs', () => {
  it('returns the base unchanged when diffChars is absent (caller opted out)', () => {
    expect(resolveJudgeDeadlineMs(BASE)).toBe(BASE);
  });

  it('returns the base unchanged for a non-finite diffChars', () => {
    expect(resolveJudgeDeadlineMs(BASE, Number.NaN)).toBe(BASE);
    expect(resolveJudgeDeadlineMs(BASE, Number.POSITIVE_INFINITY)).toBe(BASE);
  });

  it('leaves the small-diff deadline exactly as it shipped', () => {
    expect(resolveJudgeDeadlineMs(BASE, 0)).toBe(BASE);
    expect(resolveJudgeDeadlineMs(BASE, 35_000)).toBe(BASE);
    expect(resolveJudgeDeadlineMs(BASE, JUDGE_DEADLINE_BASE_DIFF_CHARS)).toBe(BASE);
  });

  it('grants one step for the first chunk past the base size', () => {
    expect(resolveJudgeDeadlineMs(BASE, JUDGE_DEADLINE_BASE_DIFF_CHARS + 1)).toBe(
      BASE + JUDGE_DEADLINE_STEP_MS,
    );
    expect(
      resolveJudgeDeadlineMs(BASE, JUDGE_DEADLINE_BASE_DIFF_CHARS + JUDGE_DEADLINE_STEP_DIFF_CHARS),
    ).toBe(BASE + JUDGE_DEADLINE_STEP_MS);
  });

  it('grants a further step per additional chunk', () => {
    expect(
      resolveJudgeDeadlineMs(
        BASE,
        JUDGE_DEADLINE_BASE_DIFF_CHARS + JUDGE_DEADLINE_STEP_DIFF_CHARS + 1,
      ),
    ).toBe(BASE + 2 * JUDGE_DEADLINE_STEP_MS);
  });

  it('is monotonic non-decreasing in diff size', () => {
    let previous = 0;
    for (let chars = 0; chars <= MAX_DIFF_CHARS * 2; chars += 10_000) {
      const value = resolveJudgeDeadlineMs(BASE, chars);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  it('stays under the ceiling at the diff-truncation cap (where the PROMPT stops growing)', () => {
    const atCap = resolveJudgeDeadlineMs(BASE, MAX_DIFF_CHARS);
    expect(atCap).toBe(BASE + 7 * JUDGE_DEADLINE_STEP_MS);
    expect(atCap).toBeLessThan(JUDGE_DEADLINE_MAX_MS);
  });

  it('clamps an absurd diff size to the ceiling', () => {
    expect(resolveJudgeDeadlineMs(BASE, 100_000_000)).toBe(JUDGE_DEADLINE_MAX_MS);
  });

  it('never returns LESS than a base that already exceeds the ceiling', () => {
    const hugeBase = JUDGE_DEADLINE_MAX_MS + 60_000;
    expect(resolveJudgeDeadlineMs(hugeBase, 1_000_000)).toBe(hugeBase);
  });
});
