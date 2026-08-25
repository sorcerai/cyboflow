/**
 * deriveIdeaTileStates — the idea canvas's tile↔component mapping.
 *
 * Covers the four axes the canvas relies on: the mapping itself, the
 * recommended-next scan (including the skipped-counts-as-settled rule and the
 * all-settled → Ship fallthrough), the two amber hints and their precedence,
 * and the liveness greying with its two reason strings.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveIdeaTileStates,
  IDEA_TILE_COMPONENTS,
  IDEA_TILE_ORDER,
  CLARIFY_BUSY_REASON,
  CHILD_BUSY_REASON,
  NO_READY_TASKS_REASON,
  type IdeaTileKey,
} from '../ideaTileStates';
import {
  IDEA_COMPONENT_KEYS,
  type IdeaComponentKey,
  type IdeaComponentState,
  type IdeaComponentStateValue,
} from '../../../../shared/types/ideaComponents';

const IDLE = { clarifyActive: false, anyLaunchedChildActive: false };
/** Default readiness: a decomposed batch is ready — sprint's own gate is open. */
const READY = { hasReadyTasks: true };
const NO_BATCH = { hasReadyTasks: false };

function entry(
  component: IdeaComponentKey,
  state: IdeaComponentStateValue,
  staleAt: string | null = null,
): IdeaComponentState {
  return {
    component,
    state,
    source: staleAt === null ? 'derived' : 'flow',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt,
    staleReason: null,
    updatedAt: null,
  };
}

/** All five components at one state, then per-key overrides applied on top. */
function ledger(
  base: IdeaComponentStateValue,
  overrides: Partial<Record<IdeaComponentKey, IdeaComponentState>> = {},
): IdeaComponentState[] {
  return IDEA_COMPONENT_KEYS.map((key) => overrides[key] ?? entry(key, base));
}

function tile(states: ReturnType<typeof deriveIdeaTileStates>, key: IdeaTileKey) {
  const found = states.find((s) => s.key === key);
  if (!found) throw new Error(`no tile ${key}`);
  return found;
}

describe('deriveIdeaTileStates — shape', () => {
  it('returns exactly the five tiles in clarify → design → planner → sprint → ship order', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), IDLE, READY);
    expect(states.map((s) => s.key)).toEqual([...IDEA_TILE_ORDER]);
    expect(IDEA_TILE_ORDER).toEqual(['clarify', 'design', 'planner', 'sprint', 'ship']);
  });

  it('maps each tile to its documented components (ship = the build gate, all five)', () => {
    expect(IDEA_TILE_COMPONENTS.clarify).toEqual(['idea-spec']);
    expect(IDEA_TILE_COMPONENTS.design).toEqual(['prototype']);
    expect(IDEA_TILE_COMPONENTS.planner).toEqual(['architecture', 'epics', 'stories']);
    expect(IDEA_TILE_COMPONENTS.sprint).toEqual(['stories']);
    expect(IDEA_TILE_COMPONENTS.ship).toEqual([...IDEA_COMPONENT_KEYS]);
  });
});

describe('deriveIdeaTileStates — recommended next', () => {
  it('recommends Clarify while the spec is incomplete', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), IDLE, READY);
    expect(states.filter((s) => s.recommended).map((s) => s.key)).toEqual(['clarify']);
  });

  it('advances to Design once the spec is complete', () => {
    const states = deriveIdeaTileStates(
      ledger('incomplete', { 'idea-spec': entry('idea-spec', 'complete') }),
      IDLE,
      READY,
    );
    expect(tile(states, 'design').recommended).toBe(true);
    expect(tile(states, 'clarify').recommended).toBe(false);
  });

  it('advances to Planner once spec + prototype are settled', () => {
    const states = deriveIdeaTileStates(
      ledger('incomplete', {
        'idea-spec': entry('idea-spec', 'complete'),
        prototype: entry('prototype', 'complete'),
      }),
      IDLE,
      READY,
    );
    expect(tile(states, 'planner').recommended).toBe(true);
  });

  it('treats a SKIPPED component as settled (the recommendation moves past it)', () => {
    const states = deriveIdeaTileStates(
      ledger('incomplete', {
        'idea-spec': entry('idea-spec', 'complete'),
        prototype: entry('prototype', 'skipped'),
      }),
      IDLE,
      READY,
    );
    expect(tile(states, 'design').recommended).toBe(false);
    expect(tile(states, 'planner').recommended).toBe(true);
  });

  it('recommends Planner while ANY of its three components is unsettled', () => {
    const states = deriveIdeaTileStates(
      ledger('complete', { stories: entry('stories', 'incomplete') }),
      IDLE,
      READY,
    );
    expect(tile(states, 'planner').recommended).toBe(true);
    expect(tile(states, 'ship').recommended).toBe(false);
  });

  it('recommends Sprint when everything is settled AND a ready batch exists', () => {
    const states = deriveIdeaTileStates(ledger('complete'), IDLE, READY);
    expect(states.filter((s) => s.recommended).map((s) => s.key)).toEqual(['sprint']);
  });

  it('recommends Ship when everything is settled but nothing is ready to execute', () => {
    const states = deriveIdeaTileStates(ledger('complete'), IDLE, NO_BATCH);
    expect(states.filter((s) => s.recommended).map((s) => s.key)).toEqual(['ship']);
  });

  it('treats a MISSING component as unsettled (never assumes done)', () => {
    // Only idea-spec present, and complete — design must still be next.
    const states = deriveIdeaTileStates([entry('idea-spec', 'complete')], IDLE, READY);
    expect(tile(states, 'design').recommended).toBe(true);
  });
});

describe('deriveIdeaTileStates — hints', () => {
  it('flags "spec not ready" on Planner and Ship while idea-spec is incomplete', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), IDLE, READY);
    expect(tile(states, 'planner').hint).toEqual({ tone: 'amber', text: 'spec not ready' });
    expect(tile(states, 'ship').hint).toEqual({ tone: 'amber', text: 'spec not ready' });
    expect(tile(states, 'clarify').hint).toBeUndefined();
    expect(tile(states, 'design').hint).toBeUndefined();
  });

  it('still flags "spec not ready" when the spec was SKIPPED (only complete clears it)', () => {
    const states = deriveIdeaTileStates(
      ledger('complete', { 'idea-spec': entry('idea-spec', 'skipped') }),
      IDLE,
      READY,
    );
    expect(tile(states, 'planner').hint?.text).toBe('spec not ready');
  });

  it('drops the spec hint once idea-spec is complete', () => {
    const states = deriveIdeaTileStates(ledger('complete'), IDLE, READY);
    expect(tile(states, 'planner').hint).toBeUndefined();
    expect(tile(states, 'ship').hint).toBeUndefined();
  });

  it('flags "needs review" on a tile whose mapped component is stale', () => {
    const states = deriveIdeaTileStates(
      ledger('complete', { prototype: entry('prototype', 'incomplete', '2026-08-21T10:00:00Z') }),
      IDLE,
      READY,
    );
    expect(tile(states, 'design').hint).toEqual({ tone: 'amber', text: 'needs review' });
    // Ship maps to all five, so a stale prototype reaches it too.
    expect(tile(states, 'ship').hint?.text).toBe('needs review');
  });

  it('does NOT flag needs-review for a merely not-started component', () => {
    const states = deriveIdeaTileStates(
      ledger('complete', { prototype: entry('prototype', 'incomplete', null) }),
      IDLE,
      READY,
    );
    expect(tile(states, 'design').hint).toBeUndefined();
  });

  it('NEVER keys anything on idea-spec.staleAt (an unreachable ledger state)', () => {
    const states = deriveIdeaTileStates(
      ledger('complete', {
        'idea-spec': entry('idea-spec', 'incomplete', '2026-08-21T10:00:00Z'),
      }),
      IDLE,
      READY,
    );
    // Clarify maps ONLY to idea-spec, so it can never carry a needs-review hint.
    expect(tile(states, 'clarify').hint).toBeUndefined();
    // Ship's hint comes from the spec-not-ready rule (state !== 'complete'),
    // not from the spec's staleAt.
    expect(tile(states, 'ship').hint?.text).toBe('spec not ready');
  });

  it('gives the UPSTREAM warning precedence when both apply to the same tile', () => {
    const states = deriveIdeaTileStates(
      ledger('complete', {
        'idea-spec': entry('idea-spec', 'incomplete'),
        epics: entry('epics', 'incomplete', '2026-08-21T10:00:00Z'),
      }),
      IDLE,
      READY,
    );
    expect(tile(states, 'planner').hint?.text).toBe('spec not ready');
  });
});

describe('deriveIdeaTileStates — liveness greying', () => {
  it('leaves every tile enabled and reasonless when nothing is live', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), IDLE, READY);
    expect(states.every((s) => !s.disabled)).toBe(true);
    expect(states.every((s) => s.disabledReason === undefined)).toBe(true);
  });

  it('greys EVERY tile while clarify is mid-turn', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), {
      clarifyActive: true,
      anyLaunchedChildActive: false,
    }, READY);
    expect(states.every((s) => s.disabled)).toBe(true);
    expect(states.every((s) => s.disabledReason === CLARIFY_BUSY_REASON)).toBe(true);
  });

  it('greys every tile while a launched child session is running', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), {
      clarifyActive: false,
      anyLaunchedChildActive: true,
    }, READY);
    expect(states.every((s) => s.disabled)).toBe(true);
    expect(states.every((s) => s.disabledReason === CHILD_BUSY_REASON)).toBe(true);
  });

  it('reports the clarify reason when both arms are live (the more specific one)', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), {
      clarifyActive: true,
      anyLaunchedChildActive: true,
    }, READY);
    expect(tile(states, 'planner').disabledReason).toBe(CLARIFY_BUSY_REASON);
  });

  it('greys ONLY sprint (with its own reason) when nothing is ready to execute', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), IDLE, NO_BATCH);
    expect(tile(states, 'sprint').disabled).toBe(true);
    expect(tile(states, 'sprint').disabledReason).toBe(NO_READY_TASKS_REASON);
    expect(states.filter((s) => s.key !== 'sprint').every((s) => !s.disabled)).toBe(true);
  });

  it('the busy reason wins over the no-batch reason on the sprint tile', () => {
    const states = deriveIdeaTileStates(
      ledger('incomplete'),
      { clarifyActive: true, anyLaunchedChildActive: false },
      NO_BATCH,
    );
    expect(tile(states, 'sprint').disabledReason).toBe(CLARIFY_BUSY_REASON);
  });

  it('keeps the recommendation and hints intact while greyed (guidance survives)', () => {
    const states = deriveIdeaTileStates(ledger('incomplete'), {
      clarifyActive: true,
      anyLaunchedChildActive: false,
    }, READY);
    expect(tile(states, 'clarify').recommended).toBe(true);
    expect(tile(states, 'planner').hint?.text).toBe('spec not ready');
  });
});
