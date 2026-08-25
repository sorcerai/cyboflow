-- Migration 101: Idea component ledger.
--
-- Tracks FIVE components per idea ('idea-spec' | 'prototype' | 'architecture' |
-- 'epics' | 'stories'), each in one of THREE states ('complete' | 'incomplete' |
-- 'skipped'). WHY: today an idea half-planned in one planner run leaves no
-- record of what got done, so a second run redundantly repeats stages. Design
-- mode + the planner's own ui-prototype step are two unaware pathways to the
-- same prototype deliverable — this ledger is the shared record both read.
--
-- THE TRUTH MODEL IS HYBRID, and this is the single most important decision:
--   - A ledger ROW, when present for a (idea, component) pair, is
--     authoritative. Full stop.
--   - A component with NO ledger row falls back to DERIVATION from what
--     already exists in the DB (body headings, approved_designs, child
--     entities). This backfills legacy/hand-edited ideas so nothing shows a
--     blank checklist, WITHOUT a risky data migration.
--   - Therefore DERIVATION CAN ONLY EVER YIELD 'complete' OR 'incomplete'.
--     'skipped' is unfalsifiable from absence, so it is ONLY ever set
--     explicitly by a flow or a user — never derived. This is why `source`
--     below only ever persists 'flow' | 'manual': 'derived' is a READ-TIME-ONLY
--     marker (shared/types/ideaComponents.ts IdeaComponentSource) that never
--     reaches this table, because a derived component by definition has no
--     row to carry it.
--
-- STALENESS ("reset means re-verify, NOT discard") is the other decision that
-- shapes this table. When an idea's body materially changes, dependent
-- components are RESET, but their prior work is retained — carried by the
-- separate `stale_at` timestamp column, NOT a fourth state:
--   state='incomplete' AND stale_at IS NULL      => "not started"
--   state='incomplete' AND stale_at IS NOT NULL  => "needs review" (prior work
--                                                  exists; an agent re-entering
--                                                  that step gets the prior
--                                                  artifact plus the diff, and
--                                                  may legitimately re-stamp it
--                                                  complete immediately)
-- Keeping this as a column rather than a state is deliberate: the three states
-- stay exactly three.
--
-- NO foreign keys, deliberately (same rationale as migration 082's header):
-- integrity (idea ownership, liveness) is chokepoint-enforced in this
-- codebase, not database-enforced, and these rows must survive cascade-deletes
-- of the runs/sessions that produced them — a row recording "prototype was
-- built by run X" must remain resolvable (and re-derivable-from) after run X's
-- worktree/session is torn down.

CREATE TABLE IF NOT EXISTS idea_components (
  idea_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  component TEXT NOT NULL CHECK (component IN ('idea-spec','prototype','architecture','epics','stories')),
  state TEXT NOT NULL CHECK (state IN ('complete','incomplete','skipped')),
  -- Only 'flow' | 'manual' ever persist here. 'derived' (shared IdeaComponentSource's
  -- third value) is a READ-TIME-ONLY marker stamped when a (idea, component) pair has
  -- NO row at all — it never reaches this table.
  source TEXT NOT NULL CHECK (source IN ('flow','manual')),
  source_run_id TEXT,
  source_session_id TEXT,
  built_against_version INTEGER,
  stale_at TEXT,
  stale_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (idea_id, component)
);

CREATE INDEX IF NOT EXISTS idx_idea_components_project ON idea_components(project_id);
