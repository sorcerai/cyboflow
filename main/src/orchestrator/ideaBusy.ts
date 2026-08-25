/**
 * assertIdeaNotBusy — the server-side backstop for the idea-session hard rule:
 * an idea may have AT MOST ONE live thing running against it at a time (idea
 * sessions plan, Stage 1 "Max-one-running server guard"). The idea canvas greys
 * its tiles from the same signal; this is what makes the rule true for a
 * scripted/stale caller that never saw the greying.
 *
 * Three independent arms make an idea busy:
 *   (a) a NON-TERMINAL workflow run whose ONLY seeded idea is this one;
 *   (b) the idea's HOME session (sessions.home_idea_id) is mid-turn
 *       (DB status 'running' — a clarify interview in flight);
 *   (c) any session LAUNCHED from the idea (sessions.origin_idea_id) is
 *       mid-turn.
 *
 * WHY ARM (a) IS "ONLY seeded idea" AND NOT "seeds this idea":
 * a multi-idea planner batch (migration 061 `seed_idea_ids`) is deliberately
 * EXEMPT — v1 neither gates the launch of a batch nor lets a live batch claim
 * every idea it touches. It cannot be launched from an idea session (that
 * surface only ever launches singular), its host session carries no
 * `origin_idea_id`, so the greying UI would never warn about it, and treating it
 * as a claim would break `runs.separatePlannerForIdea` — the "plan this idea
 * separately" fork, which launches a singular-idea planner precisely WHILE the
 * parent batch run sits parked non-terminal at its approve-idea gate. A run's
 * seed set is `seed_idea_ids` when it parses to a non-empty array, else the
 * singular `seed_idea_id`; the codebase already treats a <=1-element array as
 * the single-idea path (see RunLauncher's dual-write comment), and so does this.
 *
 * The `__quick__` chat sentinel never seeds an idea (only RunLauncher stamps
 * `seed_idea_id`), so no sentinel exclusion is needed here — unlike the
 * one-running-at-a-time session guard in RunLauncher.
 *
 * Every arm is INDEPENDENTLY fail-soft: a pre-061/111/112 schema missing a
 * column contributes no busy signal instead of throwing, and one corrupt
 * `seed_idea_ids` JSON row cannot abort the scan (the entityRunLinks.ts
 * convention — parse per row in TypeScript, never `json_each`).
 *
 * Standalone-typecheck invariant (mirrors runLauncher.ts): only DatabaseLike —
 * no 'electron', no 'better-sqlite3', no service imports.
 */
import type { DatabaseLike } from './types';

/** Machine-readable discriminant carried by {@link IdeaBusyError}. */
export const IDEA_BUSY_ERROR_CODE = 'idea_busy';

/** Which arm reported the idea busy. */
export type IdeaBusyArm = 'run' | 'home-session' | 'origin-session';

export interface IdeaBusyReason {
  arm: IdeaBusyArm;
  /** The run id (arm 'run') or session id (both session arms) holding the idea. */
  holderId: string;
  /** Human-readable sentence for a toast / IPC error string. */
  message: string;
}

/**
 * Structured rejection thrown by {@link assertIdeaNotBusy}. `code` is stable so
 * a tRPC/IPC boundary can map it to a toast without string-matching the message.
 */
export class IdeaBusyError extends Error {
  readonly code = IDEA_BUSY_ERROR_CODE;
  readonly ideaId: string;
  readonly arm: IdeaBusyArm;
  readonly holderId: string;

  constructor(ideaId: string, reason: IdeaBusyReason) {
    super(reason.message);
    this.name = 'IdeaBusyError';
    this.ideaId = ideaId;
    this.arm = reason.arm;
    this.holderId = reason.holderId;
  }
}

/** Terminal workflow-run statuses — everything else occupies the idea. */
const TERMINAL_RUN_STATUSES = "('completed','failed','canceled')";

/**
 * The ideas a run was seeded with. `seed_idea_ids` (migration 061) wins when it
 * parses to a non-empty string array; otherwise the singular `seed_idea_id` is
 * the whole seed. Corrupt JSON falls back to the singular column rather than
 * dropping the row.
 */
function resolveRunSeedIdeas(seedIdeaId: unknown, seedIdeaIds: unknown): string[] {
  if (typeof seedIdeaIds === 'string' && seedIdeaIds.length > 0) {
    try {
      const parsed: unknown = JSON.parse(seedIdeaIds);
      if (Array.isArray(parsed)) {
        const ids = parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
        if (ids.length > 0) return ids;
      }
    } catch {
      // Corrupt seed JSON — fall through to the singular column.
    }
  }
  return typeof seedIdeaId === 'string' && seedIdeaId.length > 0 ? [seedIdeaId] : [];
}

/** Arm (a): a non-terminal run whose ONLY seeded idea is `ideaId`. */
function findBusyRunId(db: DatabaseLike, ideaId: string): string | null {
  try {
    const rows = db
      .prepare(
        `SELECT id AS runId, seed_idea_id AS seedIdeaId, seed_idea_ids AS seedIdeaIds
           FROM workflow_runs
          WHERE status NOT IN ${TERMINAL_RUN_STATUSES}
            AND (seed_idea_id = ? OR seed_idea_ids IS NOT NULL)`,
      )
      .all(ideaId) as Array<{ runId: unknown; seedIdeaId: unknown; seedIdeaIds: unknown }>;
    for (const row of rows) {
      if (typeof row.runId !== 'string') continue;
      const seeds = resolveRunSeedIdeas(row.seedIdeaId, row.seedIdeaIds);
      if (seeds.length === 1 && seeds[0] === ideaId) return row.runId;
    }
    return null;
  } catch {
    // Pre-061 schema (no seed_idea_ids column) — the singular arm below still applies.
  }
  try {
    const row = db
      .prepare(
        `SELECT id AS runId FROM workflow_runs
          WHERE seed_idea_id = ? AND status NOT IN ${TERMINAL_RUN_STATUSES}
          LIMIT 1`,
      )
      .get(ideaId) as { runId?: unknown } | undefined;
    return typeof row?.runId === 'string' ? row.runId : null;
  } catch {
    return null;
  }
}

/** Arms (b)+(c): a live, non-archived session mid-turn on one of the idea columns. */
function findRunningSessionId(db: DatabaseLike, column: 'home_idea_id' | 'origin_idea_id', ideaId: string): string | null {
  try {
    const row = db
      .prepare(
        `SELECT id AS sessionId FROM sessions
          WHERE ${column} = ?
            AND status = 'running'
            AND (archived = 0 OR archived IS NULL)
          LIMIT 1`,
      )
      .get(ideaId) as { sessionId?: unknown } | undefined;
    return typeof row?.sessionId === 'string' ? row.sessionId : null;
  } catch {
    // Pre-111/112 schema — the column does not exist, so it holds nothing.
    return null;
  }
}

/**
 * Report WHY `ideaId` is busy, or null when it is free. Read-only and
 * fail-soft; safe to call on any schema vintage.
 */
export function findIdeaBusyReason(db: DatabaseLike, ideaId: string): IdeaBusyReason | null {
  const runId = findBusyRunId(db, ideaId);
  if (runId !== null) {
    return {
      arm: 'run',
      holderId: runId,
      message: `Idea ${ideaId} already has a workflow run in flight (${runId}). Let it finish or cancel it first.`,
    };
  }

  const homeSessionId = findRunningSessionId(db, 'home_idea_id', ideaId);
  if (homeSessionId !== null) {
    return {
      arm: 'home-session',
      holderId: homeSessionId,
      message: `Idea ${ideaId} is mid-turn in its own idea session (${homeSessionId}). Wait for that turn to finish.`,
    };
  }

  const originSessionId = findRunningSessionId(db, 'origin_idea_id', ideaId);
  if (originSessionId !== null) {
    return {
      arm: 'origin-session',
      holderId: originSessionId,
      message: `Idea ${ideaId} already has a session running (${originSessionId}) that was launched from it.`,
    };
  }

  return null;
}

/**
 * Throw {@link IdeaBusyError} when `ideaId` is already occupied. Call BEFORE
 * provisioning anything (no half-created session/run to compensate).
 */
export function assertIdeaNotBusy(db: DatabaseLike, ideaId: string): void {
  const reason = findIdeaBusyReason(db, ideaId);
  if (reason !== null) throw new IdeaBusyError(ideaId, reason);
}
