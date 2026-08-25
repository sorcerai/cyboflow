-- Migration 117: widen the entity `priority` CHECK on ideas/epics/tasks from
-- the 3-level P0-P2 scale (migration 015) to a 7-level P0-P6 scale.
--
-- WHY. docs/proposals/tracker-field-writeback.md Phase 1: the tracker
-- write-back work needs headroom to map provider priority scales (Linear's
-- 5 levels, Plane's 4, Dart's free-form workspace list) onto ours without
-- lossy collapsing at both ends. This migration is self-contained — no
-- tracker coupling yet, purely a local scale widen. `DEFAULT 'P2'` is
-- preserved so every existing row's meaning is unchanged.
--
-- WHY NOT the 015 table-recreate. `ideas`/`epics`/`tasks` are the busiest
-- FK-referenced tables in the schema (epics/tasks FK->ideas, tasks
-- FK->epics, plus entity_events/review_items/task_* satellites soft- and
-- hard-linking to them) and have accreted columns via ALTER across many
-- migrations since 015 (024's archived_at, 028's attachments, 059's
-- category, …) — a hardcoded CREATE TABLE here would silently drop any
-- column this file doesn't happen to list. Exactly the 103 argument.
--
-- `priority` itself is safe to drop-and-readd in place: it sits in no index,
-- trigger, or view, and carries no FK — a column-level CHECK on an ordinary
-- TEXT column. So we use 103's shadow-column recipe per table: ADD a shadow
-- column, copy the live values into it, DROP the constrained column, re-ADD
-- it with the widened CHECK (and the original NOT NULL DEFAULT 'P2'), copy
-- the values back, DROP the shadow. Three tables, same six-statement shape;
-- no PRAGMA foreign_keys toggle needed since we never DROP/recreate the
-- table itself (only ADD/DROP COLUMN on it), so no FK cascade risk exists.
--
-- Findings (review_items.priority, migration 034) are a DIFFERENT axis and
-- untouched here — same P0/P1/P2 shape, different concept (see the
-- proposal doc's "findings axis" callout).

-- ---------------------------------------------------------------------------
-- ideas.priority
-- ---------------------------------------------------------------------------

ALTER TABLE ideas ADD COLUMN priority_widen_117 TEXT;
UPDATE ideas SET priority_widen_117 = priority;
ALTER TABLE ideas DROP COLUMN priority;
ALTER TABLE ideas
  ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2'
    CHECK (priority IN ('P0','P1','P2','P3','P4','P5','P6'));
UPDATE ideas SET priority = COALESCE(priority_widen_117, 'P2');
ALTER TABLE ideas DROP COLUMN priority_widen_117;

-- ---------------------------------------------------------------------------
-- epics.priority
-- ---------------------------------------------------------------------------

ALTER TABLE epics ADD COLUMN priority_widen_117 TEXT;
UPDATE epics SET priority_widen_117 = priority;
ALTER TABLE epics DROP COLUMN priority;
ALTER TABLE epics
  ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2'
    CHECK (priority IN ('P0','P1','P2','P3','P4','P5','P6'));
UPDATE epics SET priority = COALESCE(priority_widen_117, 'P2');
ALTER TABLE epics DROP COLUMN priority_widen_117;

-- ---------------------------------------------------------------------------
-- tasks.priority
-- ---------------------------------------------------------------------------

ALTER TABLE tasks ADD COLUMN priority_widen_117 TEXT;
UPDATE tasks SET priority_widen_117 = priority;
ALTER TABLE tasks DROP COLUMN priority;
ALTER TABLE tasks
  ADD COLUMN priority TEXT NOT NULL DEFAULT 'P2'
    CHECK (priority IN ('P0','P1','P2','P3','P4','P5','P6'));
UPDATE tasks SET priority = COALESCE(priority_widen_117, 'P2');
ALTER TABLE tasks DROP COLUMN priority_widen_117;
