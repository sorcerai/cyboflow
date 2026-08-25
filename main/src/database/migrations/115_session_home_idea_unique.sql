-- Migration 115: partial unique index enforcing "at most one live idea-home
-- session per idea" — the other half of 113's home_idea_id contract.
--
-- WHERE home_idea_id IS NOT NULL AND (archived = 0 OR archived IS NULL): a
-- NULL home_idea_id never participates (SQLite treats every NULL as distinct
-- in a unique index anyway, but the explicit clause documents intent), and an
-- ARCHIVED session's claim is released so a fresh session can become the
-- idea's new home. `archived` predates this migration and is nullable
-- upstream, hence the OR IS NULL arm — same defensive shape as other
-- archived-scoped predicates in this codebase.
--
-- CREATE UNIQUE INDEX IF NOT EXISTS (not a bare ALTER) is naturally idempotent
-- — no duplicate-column hazard here — but this still gets its own file to
-- keep the three-migration set uniform and because it must run strictly after
-- 113 adds the column it indexes.
--
-- NOTE: runFileBasedMigrations() in database.ts wraps every file in a
-- this.transaction(...) call, so no explicit BEGIN/COMMIT here.

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_home_idea
  ON sessions(home_idea_id)
  WHERE home_idea_id IS NOT NULL AND (archived = 0 OR archived IS NULL);
