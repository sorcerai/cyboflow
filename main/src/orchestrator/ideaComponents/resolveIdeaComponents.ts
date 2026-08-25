/**
 * resolveIdeaComponents — the idea component ledger's HYBRID read model
 * (migration 101, `shared/types/ideaComponents.ts`). Always returns all FIVE
 * components (`IDEA_COMPONENT_KEYS` order), never a partial list.
 *
 * PRECEDENCE (the whole point of this module): for each of the five
 * components, a ledger row in `idea_components` for (ideaId, component), when
 * present, is authoritative and is mapped VERBATIM — even when derivation
 * would disagree. E.g. a user can mark 'incomplete' to force a redo while the
 * '## Architecture design' heading is still sitting in the idea body; the
 * ledger wins, and the flow that re-does the work re-stamps the row itself
 * later. Only when NO row exists for a (ideaId, component) pair do we fall
 * back to DERIVATION from what already exists in the DB (body headings,
 * approved_designs, child entities, prototype artifacts) — this backfills
 * legacy/hand-edited ideas so nothing shows a blank checklist, without a
 * risky data migration.
 *
 * ONE deliberate carve-out to that rule — the ENTITY-EXISTENCE override: an
 * 'epics' or 'stories' ledger row stamped 'complete' while the idea has ZERO
 * corresponding child entities is downgraded on read to 'incomplete' (staleAt
 * from the stamp's updatedAt, staleReason naming the deletion). Those two
 * components' "complete" means "the decomposition EXISTS as entities" — done
 * and archived children still have rows, so zero rows can only mean the
 * decomposition was hard-deleted after the stamp (a failed run's cleanup, a
 * manual delete), and nothing ever invalidates the ledger on entity deletion.
 * The override is read-side and self-healing: re-decomposing re-creates the
 * entities and the stamp reads 'complete' again without any write. It NEVER
 * fires the other way ('incomplete'/'skipped' rows stay verbatim — forcing a
 * redo and deliberate skips are judgments the ledger owns).
 *
 * DERIVATION CAN ONLY EVER YIELD 'complete' OR 'incomplete' — never
 * 'skipped', because absence is not evidence of an explicit skip decision
 * (see migration 101 and shared/types/ideaComponents.ts headers). A derived
 * result always carries `source: 'derived'` and every source/staleness field
 * null.
 *
 * An unknown idea id (no `ideas` row at all) is NOT an error and is NOT
 * omitted from the batch result: it simply has no ledger rows and nothing to
 * derive from, so it resolves to five 'incomplete' derived components — the
 * same as a freshly-created idea with an empty body.
 *
 * Follows the `../design/approvedDesigns.ts` shape: standalone, `DatabaseLike`
 * only (no concrete service, no 'electron'/'better-sqlite3'), COLUMNS alias
 * strings, a shape() mapper, plain exported functions — no statement caching.
 *
 * PERFORMANCE: `resolveIdeaComponentsBatch` is the once-per-backlog-render
 * path (every idea on the board, every render). It issues a small, bounded
 * number of GROUPED queries — never a query per idea and never a query per
 * (idea, component) — chunking any `IN (...)` list to stay under SQLite's
 * ~999 bound-parameter ceiling. `resolveIdeaComponents` (single) delegates to
 * the batch form with a one-element array; there is no separate single-idea
 * code path to drift out of sync.
 *
 * The 'prototype' component's run-linkage arm intentionally mirrors
 * `entityRunLinks.ts`'s `listRunIdsForEntity('idea', ...)` fail-soft,
 * multi-arm derivation (seed_idea_id, seed_idea_ids JSON, and the three
 * entity_events lineage arms) rather than calling it once per idea — that
 * file has no batch form, and instructions were to write the grouped
 * equivalent locally rather than modify it. Keep the two in sync if
 * `listRunIdsForEntity`'s idea arms ever change.
 */
import type { DatabaseLike } from '../types';
import {
  IDEA_COMPONENT_KEYS,
  type IdeaComponentKey,
  type IdeaComponentState,
} from '../../../../shared/types/ideaComponents';
import { extractArchDesignSection, extractIdeaSpecSection } from '../../../../shared/types/artifacts';

/**
 * Max ids per `IN (...)` chunk; keeps every grouped query well under
 * SQLite's bound-parameter ceiling (~999). Mirrors the pattern in
 * `insightsQueries.ts`'s `RUN_ID_CHUNK_SIZE` — kept local here since that
 * helper isn't exported and this module must stay standalone-typecheck-safe.
 */
const ID_CHUNK_SIZE = 400;

/** Split an id list into chunks of at most `size`, preserving order. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/** Build a comma-joined '?' placeholder string of length `n`. */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(', ');
}

/** All `idea_components` columns, aliased to the camelCase wire shape. */
const LEDGER_COLUMNS =
  'idea_id AS ideaId, component AS component, state AS state, source AS source, ' +
  'source_run_id AS sourceRunId, source_session_id AS sourceSessionId, ' +
  'built_against_version AS builtAgainstVersion, stale_at AS staleAt, ' +
  'stale_reason AS staleReason, updated_at AS updatedAt';

/** Row shape as SELECTed with the aliased columns above. */
interface LedgerSelectRow {
  ideaId: string;
  component: IdeaComponentKey;
  state: 'complete' | 'incomplete' | 'skipped';
  source: 'flow' | 'manual';
  sourceRunId: string | null;
  sourceSessionId: string | null;
  builtAgainstVersion: number | null;
  staleAt: string | null;
  staleReason: string | null;
  updatedAt: string | null;
}

/** Map an authoritative ledger row to the wire shape, verbatim. */
function shapeLedgerRow(row: LedgerSelectRow): IdeaComponentState {
  return {
    component: row.component,
    state: row.state,
    source: row.source,
    sourceRunId: row.sourceRunId ?? null,
    sourceSessionId: row.sourceSessionId ?? null,
    builtAgainstVersion: row.builtAgainstVersion ?? null,
    staleAt: row.staleAt ?? null,
    staleReason: row.staleReason ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/**
 * Build a DERIVED (never 'skipped') read-model entry for a component with no
 * ledger row. Every source/staleness field is null — derivation carries no
 * lineage, only a yes/no signal from what already exists in the DB.
 */
function derivedState(component: IdeaComponentKey, complete: boolean): IdeaComponentState {
  return {
    component,
    state: complete ? 'complete' : 'incomplete',
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt: null,
    staleReason: null,
    updatedAt: null,
  };
}

/**
 * Grouped equivalent of `entityRunLinks.ts`'s `listIdeaRunIds`, for a whole
 * batch of idea ids at once. Same five arms (seed_idea_id, seed_idea_ids
 * JSON, and the three entity_events lineage joins), same fail-soft-per-arm
 * behavior (a missing table/column on an older schema contributes nothing
 * from that arm, other arms still resolve) — just grouped by `IN (...)`
 * instead of called once per idea, since this is the performance-critical
 * batch path. Returns an entry (possibly an empty Set) for every requested id.
 */
function listIdeaRunIdsBatch(db: DatabaseLike, ideaIds: readonly string[]): Map<string, Set<string>> {
  const byIdea = new Map<string, Set<string>>();
  for (const ideaId of ideaIds) byIdea.set(ideaId, new Set());
  if (ideaIds.length === 0) return byIdea;

  const addRun = (ideaId: string, runId: unknown): void => {
    if (typeof runId === 'string' && runId.length > 0) byIdea.get(ideaId)?.add(runId);
  };

  // Arm 1: workflow_runs.seed_idea_id (single-seed runs).
  for (const idsChunk of chunk(ideaIds, ID_CHUNK_SIZE)) {
    try {
      const rows = db
        .prepare(
          `SELECT id AS runId, seed_idea_id AS ideaId FROM workflow_runs
            WHERE seed_idea_id IN (${placeholders(idsChunk.length)})`,
        )
        .all(...idsChunk) as Array<{ runId: unknown; ideaId: unknown }>;
      for (const row of rows) {
        if (typeof row.ideaId === 'string') addRun(row.ideaId, row.runId);
      }
    } catch {
      // Pre-061 schema (or missing seed_idea_id column) — other arms still apply.
    }
  }

  // Arm 2: workflow_runs.seed_idea_ids (migration-061 JSON array). One
  // unchunked query total (parsed in TypeScript, same as listRunIdsForEntity)
  // so one corrupt legacy row can't abort the whole read.
  try {
    const rows = db
      .prepare('SELECT id AS runId, seed_idea_ids AS seedIdeaIds FROM workflow_runs WHERE seed_idea_ids IS NOT NULL')
      .all() as Array<{ runId: unknown; seedIdeaIds: unknown }>;
    const wanted = new Set(ideaIds);
    for (const row of rows) {
      if (typeof row.runId !== 'string' || typeof row.seedIdeaIds !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(row.seedIdeaIds);
        if (!Array.isArray(parsed)) continue;
        for (const candidate of parsed) {
          if (typeof candidate === 'string' && wanted.has(candidate)) addRun(candidate, row.runId);
        }
      } catch {
        // Corrupt seed JSON contributes nothing; other rows still resolve.
      }
    }
  } catch {
    // Pre-061 schema — seed_idea_id and event-lineage arms still apply.
  }

  // Arm 3: entity_events directly on the idea.
  for (const idsChunk of chunk(ideaIds, ID_CHUNK_SIZE)) {
    try {
      const rows = db
        .prepare(
          `SELECT entity_id AS ideaId, run_id AS runId FROM entity_events
            WHERE entity_type = 'idea' AND entity_id IN (${placeholders(idsChunk.length)})
              AND run_id IS NOT NULL`,
        )
        .all(...idsChunk) as Array<{ ideaId: unknown; runId: unknown }>;
      for (const row of rows) {
        if (typeof row.ideaId === 'string') addRun(row.ideaId, row.runId);
      }
    } catch {
      // Missing entity_events table/column contributes no associations.
    }
  }

  // Arm 4: entity_events on epics descended from the idea.
  for (const idsChunk of chunk(ideaIds, ID_CHUNK_SIZE)) {
    try {
      const rows = db
        .prepare(
          `SELECT e.originating_idea_id AS ideaId, ev.run_id AS runId
             FROM entity_events ev
             JOIN epics e ON e.id = ev.entity_id
            WHERE ev.entity_type = 'epic' AND e.originating_idea_id IN (${placeholders(idsChunk.length)})
              AND ev.run_id IS NOT NULL`,
        )
        .all(...idsChunk) as Array<{ ideaId: unknown; runId: unknown }>;
      for (const row of rows) {
        if (typeof row.ideaId === 'string') addRun(row.ideaId, row.runId);
      }
    } catch {
      // Missing epics/entity_events table/column contributes no associations.
    }
  }

  // Arm 5: entity_events on tasks descended from the idea, directly or via epic.
  for (const idsChunk of chunk(ideaIds, ID_CHUNK_SIZE)) {
    try {
      const rows = db
        .prepare(
          `SELECT COALESCE(t.originating_idea_id, e.originating_idea_id) AS ideaId, ev.run_id AS runId
             FROM entity_events ev
             JOIN tasks t ON t.id = ev.entity_id
             LEFT JOIN epics e ON e.id = t.parent_epic_id
            WHERE ev.entity_type = 'task'
              AND COALESCE(t.originating_idea_id, e.originating_idea_id) IN (${placeholders(idsChunk.length)})
              AND ev.run_id IS NOT NULL`,
        )
        .all(...idsChunk) as Array<{ ideaId: unknown; runId: unknown }>;
      for (const row of rows) {
        if (typeof row.ideaId === 'string') addRun(row.ideaId, row.runId);
      }
    } catch {
      // Missing tasks/epics/entity_events table/column contributes no associations.
    }
  }

  return byIdea;
}

/**
 * Resolve the idea component ledger for a whole batch of ideas at once — the
 * performance-critical path (called once per backlog list render, across
 * every idea on the board). Issues a small, bounded number of GROUPED
 * queries (ledger rows, idea bodies, approved_designs, epics, tasks, run
 * linkage, prototype artifacts), never a query per idea and never a query
 * per (idea, component); every `IN (...)` list is chunked to stay under
 * SQLite's bound-parameter ceiling.
 *
 * Always returns an entry for every requested id, even ids with no `ideas`
 * row at all — see the module header ("An unknown idea id... is NOT
 * omitted"). Each entry is always all FIVE components, `IDEA_COMPONENT_KEYS`
 * order, never partial.
 */
export function resolveIdeaComponentsBatch(
  db: DatabaseLike,
  ideaIds: readonly string[],
): Map<string, IdeaComponentState[]> {
  const uniqueIds = [...new Set(ideaIds)];
  const result = new Map<string, IdeaComponentState[]>();
  if (uniqueIds.length === 0) return result;

  // (1) Ledger rows — authoritative when present. idea_id -> component -> state.
  const ledgerByIdea = new Map<string, Map<IdeaComponentKey, IdeaComponentState>>();
  for (const idsChunk of chunk(uniqueIds, ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(`SELECT ${LEDGER_COLUMNS} FROM idea_components WHERE idea_id IN (${placeholders(idsChunk.length)})`)
      .all(...idsChunk) as LedgerSelectRow[];
    for (const row of rows) {
      let byComponent = ledgerByIdea.get(row.ideaId);
      if (!byComponent) {
        byComponent = new Map();
        ledgerByIdea.set(row.ideaId, byComponent);
      }
      byComponent.set(row.component, shapeLedgerRow(row));
    }
  }

  // (2) Idea bodies — feeds 'idea-spec' and 'architecture' derivation.
  const bodyByIdea = new Map<string, string | null>();
  for (const idsChunk of chunk(uniqueIds, ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(`SELECT id AS ideaId, body AS body FROM ideas WHERE id IN (${placeholders(idsChunk.length)})`)
      .all(...idsChunk) as Array<{ ideaId: string; body: string | null }>;
    for (const row of rows) bodyByIdea.set(row.ideaId, row.body ?? null);
  }

  // (3) approved_designs — the "current approved design" read model
  // (idea_id=? AND superseded_at IS NULL), grouped. See
  // `../design/approvedDesigns.ts` getCurrentApprovedDesign for the
  // single-idea form of this exact WHERE clause.
  const ideasWithApprovedDesign = new Set<string>();
  for (const idsChunk of chunk(uniqueIds, ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(
        `SELECT DISTINCT idea_id AS ideaId FROM approved_designs
          WHERE idea_id IN (${placeholders(idsChunk.length)}) AND superseded_at IS NULL`,
      )
      .all(...idsChunk) as Array<{ ideaId: string }>;
    for (const row of rows) ideasWithApprovedDesign.add(row.ideaId);
  }

  // (4) epics — 'epics' component completeness.
  const ideasWithEpics = new Set<string>();
  for (const idsChunk of chunk(uniqueIds, ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(
        `SELECT DISTINCT originating_idea_id AS ideaId FROM epics
          WHERE originating_idea_id IN (${placeholders(idsChunk.length)})`,
      )
      .all(...idsChunk) as Array<{ ideaId: string }>;
    for (const row of rows) ideasWithEpics.add(row.ideaId);
  }

  // (5) tasks — 'stories' component completeness.
  //
  // A task reaches its idea EITHER directly (`tasks.originating_idea_id`, for a
  // task minted straight off an idea) OR through its parent epic
  // (`tasks.parent_epic_id` -> `epics.originating_idea_id`) — a task minted
  // UNDER an epic carries a NULL originating_idea_id. COALESCEing both is the
  // codebase's own lineage model; see `../runEntityOwnership.ts`
  // (listRunBatchIdeaIds/resolveRunBatchIdeaId) for the identical join. Reading
  // only the direct column would derive 'stories: incomplete' for an idea
  // decomposed idea -> epics -> tasks while every story already exists, and the
  // planner would redo the whole decomposition.
  const ideasWithStories = new Set<string>();
  for (const idsChunk of chunk(uniqueIds, ID_CHUNK_SIZE)) {
    const rows = db
      .prepare(
        `SELECT DISTINCT COALESCE(t.originating_idea_id, e.originating_idea_id) AS ideaId
           FROM tasks t
           LEFT JOIN epics e ON e.id = t.parent_epic_id
          WHERE COALESCE(t.originating_idea_id, e.originating_idea_id) IN (${placeholders(idsChunk.length)})`,
      )
      .all(...idsChunk) as Array<{ ideaId: string }>;
    for (const row of rows) ideasWithStories.add(row.ideaId);
  }

  // (6) Run linkage (grouped `listIdeaRunIds` equivalent) + (7) prototype
  // artifacts on those linked runs — together feed the other half of the
  // 'prototype' component completeness signal.
  const runIdsByIdea = listIdeaRunIdsBatch(db, uniqueIds);
  const allLinkedRunIds = new Set<string>();
  for (const runIds of runIdsByIdea.values()) {
    for (const runId of runIds) allLinkedRunIds.add(runId);
  }
  const runIdsWithPrototypeArtifact = new Set<string>();
  if (allLinkedRunIds.size > 0) {
    for (const idsChunk of chunk([...allLinkedRunIds], ID_CHUNK_SIZE)) {
      const rows = db
        .prepare(
          `SELECT DISTINCT run_id AS runId FROM artifacts
            WHERE atype IN ('ui-prototype', 'interactive-prototype')
              AND run_id IN (${placeholders(idsChunk.length)})`,
        )
        .all(...idsChunk) as Array<{ runId: string }>;
      for (const row of rows) runIdsWithPrototypeArtifact.add(row.runId);
    }
  }

  for (const ideaId of uniqueIds) {
    const ledger = ledgerByIdea.get(ideaId);
    const body = bodyByIdea.get(ideaId) ?? null;
    const hasApprovedDesign = ideasWithApprovedDesign.has(ideaId);
    const linkedRunIds = runIdsByIdea.get(ideaId) ?? new Set<string>();
    let hasPrototypeArtifact = false;
    for (const runId of linkedRunIds) {
      if (runIdsWithPrototypeArtifact.has(runId)) {
        hasPrototypeArtifact = true;
        break;
      }
    }
    const hasEpics = ideasWithEpics.has(ideaId);
    const hasStories = ideasWithStories.has(ideaId);

    const states: IdeaComponentState[] = IDEA_COMPONENT_KEYS.map((component) => {
      // A ledger row ALWAYS wins over derivation, even when derivation would
      // disagree — see the module header's precedence rule.
      const ledgerRow = ledger?.get(component);
      if (ledgerRow) {
        // Entity-existence override (module header): a 'complete' stamp for a
        // decomposition that no longer exists as entities reads as stale
        // incomplete work, not as done.
        const entitiesGone =
          ledgerRow.state === 'complete' &&
          ((component === 'epics' && !hasEpics) || (component === 'stories' && !hasStories));
        if (entitiesGone) {
          return {
            ...ledgerRow,
            state: 'incomplete',
            staleAt: ledgerRow.staleAt ?? ledgerRow.updatedAt,
            staleReason: `stamped complete but the idea has no ${component === 'epics' ? 'epics' : 'tasks'} — decomposition deleted after the stamp`,
          };
        }
        return ledgerRow;
      }

      switch (component) {
        case 'idea-spec':
          return derivedState(component, extractIdeaSpecSection(body) !== null);
        case 'architecture':
          return derivedState(component, extractArchDesignSection(body) !== null);
        case 'prototype':
          return derivedState(component, hasApprovedDesign || hasPrototypeArtifact);
        case 'epics':
          return derivedState(component, hasEpics);
        case 'stories':
          return derivedState(component, hasStories);
        default:
          return derivedState(component, false);
      }
    });

    result.set(ideaId, states);
  }

  return result;
}

/**
 * Resolve the idea component ledger for a single idea. Thin wrapper around
 * {@link resolveIdeaComponentsBatch} with a one-element array — there is no
 * separate single-idea code path to drift out of sync with the batch form.
 * Always returns all FIVE components, `IDEA_COMPONENT_KEYS` order.
 */
export function resolveIdeaComponents(db: DatabaseLike, ideaId: string): IdeaComponentState[] {
  const batch = resolveIdeaComponentsBatch(db, [ideaId]);
  return batch.get(ideaId) ?? IDEA_COMPONENT_KEYS.map((component) => derivedState(component, false));
}
