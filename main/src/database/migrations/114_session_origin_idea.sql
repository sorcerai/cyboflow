-- Migration 114: Add nullable origin_idea_id to sessions — sidebar nesting
-- lineage for the idea-session home concept.
--
-- origin_idea_id points at the idea whose LAUNCH minted this session (planner/
-- ship/design launch, as today). Unlike home_idea_id (113), many sessions may
-- share the same origin_idea_id — it is lineage, not a claim — so no unique
-- index accompanies it. Plain nullable ADD COLUMN, no FK/CHECK, same rationale
-- as 113 and design_idea_id (082): sessions is a legacy table, integrity is
-- chokepoint-enforced. NULL means "no recorded launch origin" (byte-identical
-- behavior to before this column existed).
--
-- Single-statement file for the same replay-hazard reason as 113 (see its
-- header, and migration 088's).
--
-- NOTE: runFileBasedMigrations() in database.ts wraps every file in a
-- this.transaction(...) call, so no explicit BEGIN/COMMIT here.

ALTER TABLE sessions ADD COLUMN origin_idea_id TEXT;
