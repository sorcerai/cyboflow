/**
 * validateIdeaSessionLink — the idea-liveness gate for the OPEN-IDEA-SESSION
 * door (the backlog idea card's "Open"), the find-or-create twin of
 * {@link validateDesignIdeaLink} in designIdeaValidation.ts.
 *
 * ONE deliberate difference from the design gate: a DECOMPOSED idea is still a
 * valid home. The design gate rejects decomposed ideas because a design session
 * produces a prototype the planner has already consumed; an idea's persistent
 * home is a place to keep talking about the idea, and a decomposed idea's home
 * stays reopenable from the sidebar even after its board card is gone.
 *
 * Existence in `ideas` IS the `type === 'idea'` check — ideas/epics/tasks live in
 * three separate tables (see TaskChangeRouter.locateEntity), so an epic or task
 * id simply misses this SELECT and reports `not_found`.
 *
 * Same shape/contract as its design sibling: takes a raw `better-sqlite3` handle
 * (not the `databaseService` singleton) so it is unit-testable without booting
 * Electron, performs NO writes (the chokepoint rule governs writes only), and
 * returns a distinct human-readable reason per failure so the IPC handler can
 * surface a clear error string without re-deriving it.
 *
 * Argument order matches validateDesignIdeaLink exactly — (db, ideaId,
 * projectId). Two adjacent validators with swapped positional ids would be a
 * silent-miscall hazard.
 */
import type Database from 'better-sqlite3';

export type IdeaSessionValidationFailureReason = 'not_found' | 'wrong_project' | 'archived';

export type IdeaSessionValidationResult =
  | { ok: true }
  | { ok: false; reason: IdeaSessionValidationFailureReason; error: string };

interface IdeaLivenessRow {
  project_id: number;
  archived_at: string | null;
}

/**
 * Validate that `ideaId` is a live idea owned by `projectId` and therefore
 * eligible to own a persistent idea session. Read-only — the caller owns the
 * subsequent `sessions.home_idea_id` stamp.
 */
export function validateIdeaSessionLink(
  db: Database.Database,
  ideaId: string,
  projectId: number,
): IdeaSessionValidationResult {
  const row = db
    .prepare(`SELECT project_id, archived_at FROM ideas WHERE id = ?`)
    .get(ideaId) as IdeaLivenessRow | undefined;

  if (!row) {
    return { ok: false, reason: 'not_found', error: `Idea ${ideaId} not found.` };
  }
  if (row.project_id !== projectId) {
    return {
      ok: false,
      reason: 'wrong_project',
      error: `Idea ${ideaId} belongs to a different project and cannot own a session in this one.`,
    };
  }
  if (row.archived_at !== null) {
    return {
      ok: false,
      reason: 'archived',
      error: `Idea ${ideaId} is archived and can no longer open an idea session.`,
    };
  }
  return { ok: true };
}
