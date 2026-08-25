/**
 * trackerSync/stateMapping — the tracker-state ⇄ cyboflow-stage translation
 * layer. Design: docs/proposals/tracker-sync-integration.md ("Import & state
 * mapping" + "Write-back & sub-issue mirroring").
 *
 * Two directions, both provider-agnostic (they only ever see the canonical
 * `TrackerStateGroup`, never a provider's own state vocabulary):
 *
 *   INBOUND   tracker state --group--> TrackerMappingTarget --> board_stages id
 *             seedDefaultMapping / resolveEffectiveMapping / mappingTargetToStageId
 *   OUTBOUND  board_stages id --> TrackerStateGroup --> a concrete provider state
 *             stageIdToWriteBackGroup / pickWriteBackState
 *
 * Cyboflow's four WRITABLE stages (Idea / Ready for development / Done /
 * Won't do) are the only inbound mapping targets. Position 7 'In development'
 * is orchestrator-DERIVED — a provider actor writing it is rejected by
 * TaskChangeRouter as 'forbidden_stage' — so it is never an inbound target,
 * but it IS the outbound trigger for the `started` group (a task pulled into a
 * live session moves its mirrored issue to In Progress).
 *
 * Stage ids are resolved BY POSITION against the project's default board with
 * a label sanity-check fallback (see resolveStageIds): the seeded board is
 * deterministic (`stage-board-{projectId}-default-{position}`), but a
 * re-ordered or re-labelled board must not silently map Done onto Won't do.
 */
import type Database from 'better-sqlite3';
import type {
  TrackerMappingTarget,
  TrackerState,
  TrackerStateGroup,
  TrackerStateMapping,
} from '../../../../shared/types/trackerSync';

// ---------------------------------------------------------------------------
// Inbound: provider state group -> mapping target
// ---------------------------------------------------------------------------

/**
 * The seeded inbound default per canonical state group (the proposal's
 * "Default inbound mapping" rows, unified across both providers):
 * Triage → don't import; Backlog → Idea; Todo/In Progress/In Review
 * (unstarted + started) → Ready for development; Done → Done;
 * Canceled → Won't do.
 *
 * `started` deliberately maps to Ready-for-development rather than the derived
 * In-development stage: execution stages are orchestrator-owned, so an issue
 * being worked in the tracker lands queued here, not faked into a live session.
 */
const GROUP_DEFAULT_TARGET: Record<TrackerStateGroup, TrackerMappingTarget> = {
  triage: 'dont',
  backlog: 'idea',
  unstarted: 'ready',
  started: 'ready',
  completed: 'done',
  cancelled: 'wontdo',
};

/**
 * Seed a fresh state mapping from the provider's state list — the wizard's
 * Step 3 table pre-fill. Custom/user-defined states seed by their canonical
 * group, so a workspace with five bespoke "in progress" states gets all five
 * pointed at Ready for development without any per-state configuration.
 */
export function seedDefaultMapping(states: TrackerState[]): TrackerStateMapping {
  const mapping: TrackerStateMapping = {};
  for (const state of states) {
    mapping[state.id] = GROUP_DEFAULT_TARGET[state.group] ?? 'dont';
  }
  return mapping;
}

/**
 * The mapping a sync pass actually runs on: {@link seedDefaultMapping} over the
 * CURRENT provider state list, overlaid by the connection's persisted
 * `state_mapping_json`. Seeding first means a state added in the tracker since
 * the wizard ran still has a sane target instead of silently dropping out;
 * overlaying second means every explicit user choice wins.
 *
 * A missing / malformed / non-object `state_mapping_json` degrades to the
 * seeded defaults rather than throwing — a corrupt blob must not wedge sync.
 * Overlay entries whose value is not a known target are ignored.
 */
export function resolveEffectiveMapping(
  states: TrackerState[],
  stateMappingJson: string | null,
): TrackerStateMapping {
  const mapping = seedDefaultMapping(states);
  if (stateMappingJson === null || stateMappingJson.length === 0) return mapping;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stateMappingJson);
  } catch {
    return mapping;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return mapping;

  for (const [stateId, target] of Object.entries(parsed as Record<string, unknown>)) {
    if (isMappingTarget(target)) mapping[stateId] = target;
  }
  return mapping;
}

const MAPPING_TARGETS: readonly TrackerMappingTarget[] = [
  'dont',
  'idea',
  'ready',
  'done',
  'wontdo',
  'indev',
];

function isMappingTarget(value: unknown): value is TrackerMappingTarget {
  return typeof value === 'string' && (MAPPING_TARGETS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Board stage resolution
// ---------------------------------------------------------------------------

/** The board_stages ids the sync engine maps onto, for one project. */
export interface TrackerStageIds {
  /** Position 1 — 'Idea'. */
  idea: string;
  /** Position 6 — 'Ready for development'. */
  ready: string;
  /** Position 9 — 'Done' (terminal). */
  done: string;
  /** Position 10 — "Won't do" (terminal, hidden by default). */
  wontdo: string;
  /**
   * Position 7 — 'In development'. write_policy='derived' (orchestrator-only),
   * so it is NEVER an inbound target; it is here purely as the OUTBOUND
   * write-back trigger for the `started` group.
   */
  inDevelopment: string;
}

/** A project's board/stage layout could not be resolved (missing board or stage row). */
export class TrackerStageResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerStageResolutionError';
  }
}

interface StageRow {
  id: string;
  label: string;
  position: number;
}

/**
 * Resolve a project's five canonical stage ids off its DEFAULT board.
 *
 * Board choice mirrors taskListing.boardsForProject's ordering
 * (`is_default DESC, name ASC`) so "the default board" means the same thing
 * here as everywhere else. Stage choice is BY POSITION — the seed in
 * DatabaseService.seedDefaultBoard pins positions 1/6/7/9/10 — with a LABEL
 * sanity check: if the row sitting at the canonical position does not carry the
 * canonical label, we prefer a row that matches the label, and only fall back
 * to the positional row when no label matches (a renamed but otherwise intact
 * board). This keeps a re-ordered board from mapping Done onto Won't do.
 *
 * @throws TrackerStageResolutionError when the project has no board, or the
 *         board is missing a stage that neither position nor label can resolve.
 */
export function resolveStageIds(db: Database.Database, projectId: number): TrackerStageIds {
  const board = db
    .prepare('SELECT id FROM boards WHERE project_id = ? ORDER BY is_default DESC, name ASC LIMIT 1')
    .get(projectId) as { id: string } | undefined;
  if (!board) {
    throw new TrackerStageResolutionError(`project ${projectId} has no board to map tracker states onto`);
  }

  const rows = db
    .prepare('SELECT id, label, position FROM board_stages WHERE board_id = ? ORDER BY position ASC')
    .all(board.id) as StageRow[];

  const pick = (position: number, label: string): string => {
    const atPosition = rows.find((r) => r.position === position);
    if (atPosition && normalizeLabel(atPosition.label) === normalizeLabel(label)) return atPosition.id;
    const byLabel = rows.find((r) => normalizeLabel(r.label) === normalizeLabel(label));
    if (byLabel) return byLabel.id;
    if (atPosition) return atPosition.id;
    throw new TrackerStageResolutionError(
      `board ${board.id} has no stage at position ${position} ('${label}') to map tracker states onto`,
    );
  };

  return {
    idea: pick(1, 'Idea'),
    ready: pick(6, 'Ready for development'),
    inDevelopment: pick(7, 'In development'),
    done: pick(9, 'Done'),
    wontdo: pick(10, "Won't do"),
  };
}

/** Case/whitespace/apostrophe-insensitive label compare ("Won't do" vs "Won’t Do"). */
function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Target <-> stage id
// ---------------------------------------------------------------------------

/**
 * The board_stages id an inbound mapping target lands on, or null for
 * `'dont'` (— Don't import: the issue is skipped entirely, never imported and
 * never stage-moved).
 */
export function mappingTargetToStageId(
  target: TrackerMappingTarget,
  stageIds: TrackerStageIds,
): string | null {
  switch (target) {
    case 'idea':
      return stageIds.idea;
    case 'ready':
      return stageIds.ready;
    case 'done':
      return stageIds.done;
    case 'wontdo':
      return stageIds.wontdo;
    case 'dont':
      return null;
    case 'indev':
      // OUTBOUND-ONLY (see TrackerMappingTarget). Position 7 is derived, so
      // naming it here would produce a stage write TaskChangeRouter rejects as
      // 'forbidden_stage' — and even if it landed, the boot self-heal would
      // revert it on the next pass. Inbound therefore treats it as 'dont';
      // its whole effect is on the write-back side, in pickWriteBackState.
      return null;
  }
}

/**
 * The canonical state group a local stage should write back to, or null when
 * the stage writes NOTHING. Per the proposal's "Write-back & sub-issue
 * mirroring": In development → started, Done → completed, Won't do →
 * cancelled. Idea and Ready-for-development intentionally write nothing —
 * readiness is not "started", and there is no tracker state meaning "someone
 * filed this".
 */
export function stageIdToWriteBackGroup(
  stageId: string,
  stageIds: TrackerStageIds,
): TrackerStateGroup | null {
  if (stageId === stageIds.inDevelopment) return 'started';
  if (stageId === stageIds.done) return 'completed';
  if (stageId === stageIds.wontdo) return 'cancelled';
  return null;
}

/**
 * The concrete provider state a write-back targets.
 *
 * An explicit `'indev'` pin in the mapping WINS for the `started` group: that
 * is the user naming, in the mapping table, which state "In development"
 * pushes. It overrides the state's own group, because the pin exists precisely
 * to correct a group the adapter had to GUESS (Dart infers groups from state
 * names; Linear and Plane declare them).
 *
 * Failing a pin, the fallback is the FIRST state in the group by the provider's
 * own returned order. Providers return workflow states in their configured
 * board order, so "first started state" is the natural "In Progress" and "first
 * completed state" the natural "Done" without asking the user to pick one.
 *
 * Null when nothing matches (the caller then skips the write rather than
 * inventing a state) — reachable on a provider whose state NAMES defeat the
 * inference and where the user has pinned nothing.
 */
export function pickWriteBackState(
  states: TrackerState[],
  group: TrackerStateGroup,
  mapping: TrackerStateMapping = {},
): TrackerState | null {
  if (group === 'started') {
    const pinned = states.find((state) => mapping[state.id] === 'indev');
    if (pinned !== undefined) return pinned;
  }
  return states.find((state) => state.group === group) ?? null;
}
