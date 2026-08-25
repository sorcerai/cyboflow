/**
 * deriveIdeaTileStates — the EXPLICIT tile↔component mapping behind the idea
 * session canvas's five direction tiles (Clarify / Design / Full planner /
 * Launch sprint / Ship).
 *
 * Pure and unit-tested on purpose: the canvas renders whatever this returns, so
 * "which tile does the app recommend next, and why is that one greyed" is
 * decided in one readable place instead of inside JSX conditionals.
 *
 * ## Mapping (idea sessions plan, Stage 5)
 *   clarify ← idea-spec
 *   design  ← prototype
 *   planner ← architecture + epics + stories
 *   sprint  ← stories (it EXECUTES the decomposed tasks; its real gate is
 *             `hasReadyTasks` below — the stories mapping only feeds the
 *             stale-hint scan)
 *   ship    ← all five (it is the build gate — it runs the planner AND the
 *             sprint, so every upstream component is in its scope)
 *
 * ## Recommended-next
 * The FIRST tile in clarify → design → planner order whose mapped component(s)
 * are not ALL settled ('complete' or 'skipped' — a deliberately skipped
 * component is a decision, not a gap). When all three are settled the
 * recommendation moves to Sprint when the idea has ready-for-development tasks
 * to execute (planning is done — build what was planned, don't re-plan via
 * Ship), else to Ship. Exactly one tile is ever recommended.
 *
 * ## Hints (amber, advisory — they never disable anything)
 *   - "spec not ready" on Planner + Ship while `idea-spec.state !== 'complete'`:
 *     both consume the spec, and planning against an unsettled one is the
 *     classic wasted run.
 *   - "needs review" on a tile when any component it maps to is STALE
 *     (`state === 'incomplete' && staleAt !== null` — prior work exists but the
 *     idea body changed underneath it; see shared/types/ideaComponents.ts).
 *     NEVER keyed on `idea-spec.staleAt`: the body IS the spec, so an edit
 *     updates that component rather than invalidating it and the ledger's
 *     body-change hook never stales it. Keying on it would encode an
 *     unreachable state and quietly rot.
 *   When both apply to the same tile the UPSTREAM warning wins ("spec not
 *   ready") — re-verifying downstream work against a spec that is still moving
 *   is the wrong next action.
 *
 * ## Disabling (the hard rule's UI half)
 * An idea may have AT MOST ONE live thing running against it. While the home
 * session is mid-turn (a clarify interview) or any launched child session/run
 * is active, EVERY tile greys with a reason line. The server-side backstop is
 * `assertIdeaNotBusy` (main/src/orchestrator/ideaBusy.ts) — this is guidance,
 * that is enforcement.
 */
import {
  type IdeaComponentKey,
  type IdeaComponentState,
} from '../../../shared/types/ideaComponents';

/** The five directions an idea session can take. */
export type IdeaTileKey = 'clarify' | 'design' | 'planner' | 'sprint' | 'ship';

/** An advisory line under a tile. Amber is the only tone v1 uses. */
export interface IdeaTileHint {
  tone: 'amber';
  text: string;
}

export interface IdeaTileState {
  key: IdeaTileKey;
  /** Exactly one tile carries this — the app's suggested next direction. */
  recommended: boolean;
  disabled: boolean;
  /** Why the tile is greyed; only set while `disabled`. */
  disabledReason?: string;
  hint?: IdeaTileHint;
}

/** Live signals that grey every tile (the max-one-running-per-idea rule). */
export interface IdeaTileLiveness {
  /** The home session itself is mid-turn (a clarify interview in flight). */
  clarifyActive: boolean;
  /** A session launched FROM this idea (design/planner/ship) is running. */
  anyLaunchedChildActive: boolean;
}

/** The components each tile's readiness is derived from. */
export const IDEA_TILE_COMPONENTS: Record<IdeaTileKey, readonly IdeaComponentKey[]> = {
  clarify: ['idea-spec'],
  design: ['prototype'],
  planner: ['architecture', 'epics', 'stories'],
  sprint: ['stories'],
  ship: ['idea-spec', 'prototype', 'architecture', 'epics', 'stories'],
};

/** Tile order — also the recommendation-scan order for the first three. */
export const IDEA_TILE_ORDER: readonly IdeaTileKey[] = [
  'clarify',
  'design',
  'planner',
  'sprint',
  'ship',
];

/** Reason text per liveness arm. */
export const CLARIFY_BUSY_REASON = 'waiting on clarify…';
export const CHILD_BUSY_REASON = 'a session for this idea is running';
/** Sprint's own gate: nothing decomposed and ready to execute. */
export const NO_READY_TASKS_REASON = 'no ready tasks — run the planner first';

const SPEC_NOT_READY_HINT: IdeaTileHint = { tone: 'amber', text: 'spec not ready' };
const NEEDS_REVIEW_HINT: IdeaTileHint = { tone: 'amber', text: 'needs review' };

/**
 * "Settled" = nothing further is owed for this component. A SKIPPED component
 * counts: it was an explicit decision (never derived — see
 * shared/types/ideaComponents.ts), so the recommendation must move past it
 * rather than parking on it forever.
 */
function isSettled(entry: IdeaComponentState | undefined): boolean {
  if (entry === undefined) return false; // unknown ⇒ not settled (never assume done)
  return entry.state === 'complete' || entry.state === 'skipped';
}

/** Stale = prior work exists but needs re-verification (see file header). */
function isStale(entry: IdeaComponentState | undefined): boolean {
  return entry !== undefined && entry.state === 'incomplete' && entry.staleAt !== null;
}

/** Readiness inputs that are not component-ledger state. */
export interface IdeaTileReadiness {
  /**
   * The idea has ready-for-development, un-pulled decomposed tasks — Sprint's
   * real gate (its components mapping only feeds the stale-hint scan).
   */
  hasReadyTasks: boolean;
}

export function deriveIdeaTileStates(
  components: IdeaComponentState[],
  liveness: IdeaTileLiveness,
  readiness: IdeaTileReadiness,
): IdeaTileState[] {
  const byKey = new Map<IdeaComponentKey, IdeaComponentState>();
  for (const entry of components) byKey.set(entry.component, entry);

  const allSettled = (key: IdeaTileKey): boolean =>
    IDEA_TILE_COMPONENTS[key].every((c) => isSettled(byKey.get(c)));

  // First unsettled of clarify → design → planner; all settled ⇒ Sprint when
  // there is a decomposed batch to execute (build what was planned), else Ship.
  const recommendedKey: IdeaTileKey =
    (['clarify', 'design', 'planner'] as const).find((key) => !allSettled(key)) ??
    (readiness.hasReadyTasks ? 'sprint' : 'ship');

  const specComplete = byKey.get('idea-spec')?.state === 'complete';
  const busy = liveness.clarifyActive || liveness.anyLaunchedChildActive;
  // clarifyActive is reported first: it is the more specific explanation when
  // both arms are live (the user is looking at the session that is mid-turn).
  const busyReason = liveness.clarifyActive ? CLARIFY_BUSY_REASON : CHILD_BUSY_REASON;

  return IDEA_TILE_ORDER.map((key) => {
    // Downstream-stale scan. 'idea-spec' is excluded EVERYWHERE (it is never
    // staled by a body edit — see the file header), which is why Clarify, whose
    // only component is the spec, can never carry a needs-review hint.
    const stale = IDEA_TILE_COMPONENTS[key].some((c) => c !== 'idea-spec' && isStale(byKey.get(c)));
    const specGated = (key === 'planner' || key === 'ship') && !specComplete;
    const hint = specGated ? SPEC_NOT_READY_HINT : stale ? NEEDS_REVIEW_HINT : undefined;

    // Sprint alone also greys on its OWN gate — nothing ready to execute. The
    // busy reason wins when both apply: it explains every tile at once.
    const noBatch = key === 'sprint' && !readiness.hasReadyTasks;
    const disabled = busy || noBatch;
    const disabledReason = busy ? busyReason : NO_READY_TASKS_REASON;

    return {
      key,
      recommended: key === recommendedKey,
      disabled,
      ...(disabled ? { disabledReason } : {}),
      ...(hint !== undefined ? { hint } : {}),
    };
  });
}
