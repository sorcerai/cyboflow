-- Migration 102: widen the artifacts.atype CHECK to include 'idea-summary' and
-- make it PER-ENTITY (one per idea, alongside idea-spec/arch-design).
--
-- 'idea-summary' is the per-idea HUB artifact (shared/types/ideaComponents.ts,
-- migration 101's idea_components ledger): it surfaces the five-component
-- status (idea-spec / prototype / architecture / epics / stories) for ONE idea
-- and links out to each real deliverable tab — it is a hub, not an aggregator,
-- so it points at those tabs rather than inlining their content. It is
-- SYSTEM-MINTED by autoMintArtifacts (reportable:false in the artifact-policy
-- registry): an agent-reported hub would arrive with no source_ref/ledger
-- context and render broken, mirroring arch-design/approve-designs.
--
-- WHY a table recreate: SQLite cannot ALTER a CHECK constraint, and the
-- file-keyed migration ledger applies each .sql once, so editing an earlier
-- migration in place would silently never re-apply on an already-migrated DB.
-- We recreate the artifacts table with the widened CHECK and copy the rows —
-- the same recipe 035/045/060/062/063/073/089/091 use. The leading `PRAGMA
-- foreign_keys=OFF` is detected by the migration runner, which toggles FK
-- enforcement OFF *outside* the wrapping transaction so DROP TABLE does not
-- cascade.
--
-- Runs AFTER 099 (the previous artifacts recreate, which added 'project-brief'
-- on top of 097's 'verify-runbook'), so this recreate reproduces 099's FULL
-- schema — its column set (INCLUDING `revision`; see migration 088's header for
-- the replay hazard a recreate that forgets that column re-opens, breaking
-- Design Mode's CAS binding), its atype list, and the split-identity indexes —
-- changing ONLY the CHECK (gains 'idea-summary') and the per-entity index
-- (gains 'idea-summary' alongside 'idea-spec'/'arch-design'). Each recreate
-- carries only the atypes it NAMES, so dropping 'verify-runbook'/'project-brief'
-- from the list below would strand every row of those two kinds.
--
-- 'idea-summary' IS added to the per-entity set (idx_artifacts_per_source): it
-- is one hub PER idea, so a multi-idea planner batch surfaces one summary tab
-- per idea, exactly like idea-spec/arch-design. Putting it in the OTHER index
-- (one-per-(run, atype)) would make the first idea's hub silently get
-- overwritten by the second idea's mint in a multi-idea batch.

PRAGMA foreign_keys=OFF;

CREATE TABLE artifacts_new (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  session_id   TEXT,
  atype        TEXT NOT NULL CHECK (atype IN ('idea-spec', 'decomposed-stories', 'screenshots', 'ui-prototype', 'generic', 'interactive-prototype', 'arch-design', 'compound-recommendations', 'project-brief', 'approve-ideas', 'approve-designs', 'eval-report', 'verify-runbook', 'idea-summary')),
  label        TEXT NOT NULL,
  step_origin  TEXT,
  mode         TEXT NOT NULL DEFAULT 'canvas' CHECK (mode IN ('template', 'canvas')),
  committed    INTEGER NOT NULL DEFAULT 0,
  session_only INTEGER NOT NULL DEFAULT 1,
  is_new       INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT,
  source_ref   TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  committed_at DATETIME,
  revision     INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

INSERT INTO artifacts_new (id, run_id, session_id, atype, label, step_origin, mode, committed,
                           session_only, is_new, payload_json, source_ref, created_at, committed_at, revision)
  SELECT id, run_id, session_id, atype, label, step_origin, mode, committed,
         session_only, is_new, payload_json, source_ref, created_at, committed_at, revision
  FROM artifacts;

DROP TABLE artifacts;
ALTER TABLE artifacts_new RENAME TO artifacts;

CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_run_committed ON artifacts(run_id, committed);

-- Split identity rule (unchanged shape from 073/089/091/097/099; 'idea-summary' joins
-- the per-entity set):
--   * every atype EXCEPT the per-entity set stays one-per-(run, atype);
--   * idea-spec, arch-design, AND idea-summary are one-per-(run, atype,
--     source_ref). COALESCE keeps a NULL source_ref from escaping the unique
--     check.
CREATE UNIQUE INDEX idx_artifacts_one_per_atype
  ON artifacts(run_id, atype) WHERE atype NOT IN ('idea-spec', 'arch-design', 'idea-summary');
CREATE UNIQUE INDEX idx_artifacts_per_source
  ON artifacts(run_id, atype, COALESCE(source_ref, '')) WHERE atype IN ('idea-spec', 'arch-design', 'idea-summary');

PRAGMA foreign_keys=ON;
