/**
 * Spiral-reveal geometry — the pure half of the onboarding wrapper.
 *
 * Kept out of OnboardingSpiralReveal.tsx so that file exports a component and
 * nothing else (fast refresh degrades to a full reload otherwise, which is
 * exactly wrong for a surface whose whole point is motion you tune by eye).
 * OnboardingGate also reads revealFraction from here to drive the modal scrim.
 */

/** Tiles per side. 6×6 = 36 tiles ≈ 7 per band across the 5 transitions. */
export const SPIRAL_GRID = 6;
export const SPIRAL_TILE_COUNT = SPIRAL_GRID * SPIRAL_GRID;

/**
 * The step at which the app is fully exposed — NOT the end of the tour.
 * Transitions 0→1→2→3→4→5 each peel ~1/5 of the sheet, landing at 100% exactly
 * as the first coachmark mounts. Steps 5–10 anchor to real UI (quick-session
 * card, model picker, ship chip) and cannot point into a covered or blurred
 * app, so the last tile must be gone the moment step 5 renders.
 */
export const REVEAL_COMPLETE_STEP = 5;

/**
 * Spiral rank per tile: `ranks[flatIndex]` = that tile's position in a clockwise
 * walk starting at the top-left corner (right along the top edge, down the right
 * edge, left along the bottom, up the left, then inward one ring and repeat).
 * Tiles peel in ascending rank, so the wrapper unwinds from the outside in.
 */
export function spiralRanks(grid: number): number[] {
  const ranks = new Array<number>(grid * grid).fill(0);
  let top = 0;
  let bottom = grid - 1;
  let left = 0;
  let right = grid - 1;
  let rank = 0;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) ranks[top * grid + c] = rank++;
    top++;
    for (let r = top; r <= bottom; r++) ranks[r * grid + right] = rank++;
    right--;
    if (top <= bottom) {
      for (let c = right; c >= left; c--) ranks[bottom * grid + c] = rank++;
      bottom--;
    }
    if (left <= right) {
      for (let r = bottom; r >= top; r--) ranks[r * grid + left] = rank++;
      left++;
    }
  }
  return ranks;
}

/**
 * Fraction of the wrapper that should be gone at `step`, clamped to [0,1].
 * A function of the LIVE step, not maxVisitedStep — Back re-wraps its band, so
 * the wrapping reads as a direct progress indicator.
 */
export function revealFraction(step: number): number {
  if (step <= 0) return 0;
  if (step >= REVEAL_COMPLETE_STEP) return 1;
  return step / REVEAL_COMPLETE_STEP;
}

/** How many tiles are peeled at `step` — the boundary of the spiral walk. */
export function hiddenTileCount(step: number, tileCount: number = SPIRAL_TILE_COUNT): number {
  return Math.round(revealFraction(step) * tileCount);
}
