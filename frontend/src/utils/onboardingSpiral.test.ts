/**
 * onboardingSpiral — pure geometry/progress coverage for the onboarding wrapper.
 *
 * The two invariants that make the wrapper safe to ship live here, not in the
 * render path: the peel order really is a clockwise-from-top-left spiral (the
 * whole metaphor rests on it), and the reveal is complete at step 5 — the first
 * coachmark step, which anchors to live UI and so cannot tolerate a surviving
 * tile or any residual blur. The component's DOM is deliberately not asserted;
 * it is presentational and its motion is CSS-transition-driven.
 */
import { describe, it, expect } from 'vitest';
import { hiddenTileCount, revealFraction, spiralRanks } from './onboardingSpiral';

describe('spiralRanks', () => {
  it('walks a 4x4 grid clockwise from the top-left, winding inward', () => {
    // rank at each cell, laid out as the grid reads on screen:
    //   0  1  2  3
    //  11 12 13  4
    //  10 15 14  5
    //   9  8  7  6
    expect(spiralRanks(4)).toEqual([0, 1, 2, 3, 11, 12, 13, 4, 10, 15, 14, 5, 9, 8, 7, 6]);
  });

  it('starts at the top-left corner and moves right first', () => {
    const ranks = spiralRanks(6);
    expect(ranks[0]).toBe(0); // top-left is always peeled first
    expect(ranks[1]).toBe(1); // ...then its right-hand neighbour, not the one below
    // The cell directly below top-left closes the outer ring: 6*4-4 = 20 cells,
    // so it lands on the ring's last rank rather than an early one.
    expect(ranks[6]).toBe(19);
  });

  it('assigns every tile a unique rank covering 0..n-1', () => {
    for (const grid of [1, 2, 3, 5, 6, 7]) {
      const ranks = spiralRanks(grid);
      expect(ranks).toHaveLength(grid * grid);
      expect([...ranks].sort((a, b) => a - b)).toEqual(
        Array.from({ length: grid * grid }, (_, i) => i),
      );
    }
  });
});

describe('revealFraction', () => {
  it('is fully wrapped at the welcome step and fully open at the first coach step', () => {
    expect(revealFraction(0)).toBe(0);
    expect(revealFraction(5)).toBe(1);
  });

  it('opens one even band per modal-step advance', () => {
    expect(revealFraction(1)).toBeCloseTo(0.2);
    expect(revealFraction(2)).toBeCloseTo(0.4);
    expect(revealFraction(3)).toBeCloseTo(0.6);
    expect(revealFraction(4)).toBeCloseTo(0.8);
  });

  it('stays clamped past the coach steps and the closing rail-map card', () => {
    for (const step of [6, 9, 10, 11, 99]) expect(revealFraction(step)).toBe(1);
    expect(revealFraction(-3)).toBe(0);
  });
});

describe('hiddenTileCount', () => {
  it('leaves the wrapper intact at step 0 and fully gone by step 5', () => {
    expect(hiddenTileCount(0)).toBe(0);
    expect(hiddenTileCount(5)).toBe(36);
  });

  it('never regresses as the tour advances', () => {
    const counts = [0, 1, 2, 3, 4, 5].map((s) => hiddenTileCount(s));
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]);
  });

  it('re-wraps on Back — the count is a function of the live step only', () => {
    // Progress deliberately tracks `step`, not maxVisitedStep: stepping back to
    // 2 must restore exactly the step-2 wrapping, no matter how far the user
    // had already got. That is what makes the wrapper a progress readout.
    expect(hiddenTileCount(2)).toBeLessThan(hiddenTileCount(3));
    expect(hiddenTileCount(2)).toBeGreaterThan(hiddenTileCount(1));
  });
});
