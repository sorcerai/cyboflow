-- Migration 105: admit 'dart' as a third tracker-sync provider.
--
-- Numbering: 101/102 are claimed by in-flight worktrees that have not landed on
-- this branch (see docs/CODE-PATTERNS.md migration-numbering convention); 105 is
-- the next free prefix after 104.
--
-- WHY. Two CHECK constraints hardcode the two-provider world, both minted by
-- 093_tracker_sync.sql:
--   tracker_connections.provider     (093:61)  IN ('linear','plane')
--   entity_external_links.provider   (093:90)  IN ('linear','plane')
-- SQLite cannot ALTER a CHECK, and the file-keyed migration ledger applies each
-- .sql exactly once, so editing 093 in place would silently never re-apply on an
-- already-migrated DB (the 062_approve_ideas_atype lesson). Both are widened
-- here, in one atomic file, so the Dart adapter work is pure code.
--
-- WHY A FULL RECREATE rather than 103's cheaper DROP-COLUMN/re-ADD-COLUMN trick.
-- 103 could re-ADD its columns because each had a sensible non-null default; both
-- `provider` columns here are NOT NULL with NO default, and `ALTER TABLE ADD
-- COLUMN` refuses a NOT NULL column without one. Inventing `DEFAULT 'linear'` is
-- exactly the silent-fallback-to-the-first-provider failure mode this widening
-- exists to prevent (103's header makes the same argument for `DEFAULT 'claude'`
-- on agent_invocations, and recreates that table for precisely this reason).
--
-- A recreate is SAFE here in a way it is not for 103's `sessions`/`workflow_runs`:
-- both tables are young and their complete shape is reproduced from exactly two
-- files. 093 minted every column; 094 added `status_sync_mode`/`pull_mode`/
-- `push_mode` to tracker_connections and touched nothing on entity_external_links;
-- no migration after 094 references either table, and database.ts never ALTERs
-- them imperatively. The CREATE statements below are 093+094's columns verbatim,
-- including 093's deliberately-retained-but-unread `two_way` (094's header
-- explains why it stays) and both tables' indexes and constraints.
--
-- ORDER. entity_external_links is rebuilt FIRST, while tracker_connections still
-- exists, then tracker_connections itself. Each DROP happens with FK enforcement
-- off, so neither cascades into its children (tracker_outbox / tracker_conflicts /
-- entity_external_links all reference tracker_connections ON DELETE CASCADE, and
-- tracker_conflicts.link_id references entity_external_links ON DELETE SET NULL).
-- Only the `_new` tables are renamed and nothing references those names, so no
-- other table's FK clause is rewritten by the rename.
--
-- REPLAY SAFETY (a ledger-wiped DB re-runs every file end to end — see 088/093).
-- This file has no idempotent-ALTER first statement to lean on, so a replay
-- genuinely re-executes both recreates. That is CONVERGENT rather than merely
-- tolerated: each copy is column-for-column verbatim with no backfill, defaulting
-- or value rewriting of any kind (094's leading-UPDATE hazard does not exist
-- here), so a second pass reproduces byte-identical tables holding the same rows.
-- The `_new` names are free at the start of every pass because the previous pass
-- renamed them away.

PRAGMA foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- entity_external_links — 093 shape, provider CHECK widened.
-- ---------------------------------------------------------------------------

CREATE TABLE entity_external_links_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('idea','epic','task')),
  entity_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('linear','plane','dart')),
  external_id TEXT NOT NULL,
  external_identifier TEXT,
  external_url TEXT,
  external_parent_id TEXT,
  baseline_json TEXT,
  orphaned_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, entity_id, provider),
  UNIQUE (connection_id, external_id),
  FOREIGN KEY (connection_id) REFERENCES tracker_connections(id) ON DELETE CASCADE
);

INSERT INTO entity_external_links_new (
  id, connection_id, entity_type, entity_id, provider, external_id,
  external_identifier, external_url, external_parent_id, baseline_json,
  orphaned_at, created_at, updated_at
)
  SELECT id, connection_id, entity_type, entity_id, provider, external_id,
         external_identifier, external_url, external_parent_id, baseline_json,
         orphaned_at, created_at, updated_at
    FROM entity_external_links;

-- Carry AUTOINCREMENT's high-water mark across the rebuild (103's argument):
-- copying explicit ids only sets the new table's mark to max(id) among SURVIVING
-- rows, and the old mark is higher whenever the newest links were CASCADE-deleted
-- with their connection — the normal case. Letting it regress would hand a later
-- insert a retired rowid, exactly what AUTOINCREMENT exists to promise. The first
-- statement covers the copy having moved zero rows, which leaves the new table
-- with no sqlite_sequence row at all.
INSERT INTO sqlite_sequence (name, seq)
  SELECT 'entity_external_links_new', 0
   WHERE EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'entity_external_links')
     AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'entity_external_links_new');

UPDATE sqlite_sequence
   SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'entity_external_links'), 0))
 WHERE name = 'entity_external_links_new';

DROP TABLE entity_external_links;
ALTER TABLE entity_external_links_new RENAME TO entity_external_links;

CREATE INDEX IF NOT EXISTS idx_entity_external_links_conn ON entity_external_links(connection_id);

-- ---------------------------------------------------------------------------
-- tracker_connections — 093 shape + 094's three direction modes, provider
-- CHECK widened. TEXT PRIMARY KEY, so no sqlite_sequence row to carry.
-- ---------------------------------------------------------------------------

CREATE TABLE tracker_connections_new (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('linear','plane','dart')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disconnected')),
  workspace_id TEXT,
  workspace_name TEXT,
  actor_label TEXT,
  base_url TEXT,
  secret_ciphertext BLOB,
  source_json TEXT,
  selection_mode TEXT NOT NULL DEFAULT 'all' CHECK (selection_mode IN ('all','assignee','manual')),
  selection_json TEXT,
  state_mapping_json TEXT NOT NULL DEFAULT '{}',
  two_way INTEGER NOT NULL DEFAULT 1,
  mirror_subissues INTEGER NOT NULL DEFAULT 1,
  conflict_mode TEXT NOT NULL DEFAULT 'auto' CHECK (conflict_mode IN ('auto','manual')),
  cursor_updated_at TEXT,
  cursor_external_id TEXT,
  last_sync_at TEXT,
  last_sync_log_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  status_sync_mode TEXT NOT NULL DEFAULT 'auto' CHECK (status_sync_mode IN ('auto','manual')),
  pull_mode TEXT NOT NULL DEFAULT 'auto' CHECK (pull_mode IN ('auto','manual')),
  push_mode TEXT NOT NULL DEFAULT 'auto' CHECK (push_mode IN ('auto','manual')),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

INSERT INTO tracker_connections_new (
  id, project_id, provider, status, workspace_id, workspace_name, actor_label,
  base_url, secret_ciphertext, source_json, selection_mode, selection_json,
  state_mapping_json, two_way, mirror_subissues, conflict_mode, cursor_updated_at,
  cursor_external_id, last_sync_at, last_sync_log_json, created_at, updated_at,
  status_sync_mode, pull_mode, push_mode
)
  SELECT id, project_id, provider, status, workspace_id, workspace_name, actor_label,
         base_url, secret_ciphertext, source_json, selection_mode, selection_json,
         state_mapping_json, two_way, mirror_subissues, conflict_mode, cursor_updated_at,
         cursor_external_id, last_sync_at, last_sync_log_json, created_at, updated_at,
         status_sync_mode, pull_mode, push_mode
    FROM tracker_connections;

DROP TABLE tracker_connections;
ALTER TABLE tracker_connections_new RENAME TO tracker_connections;

CREATE INDEX IF NOT EXISTS idx_tracker_connections_project ON tracker_connections(project_id);

PRAGMA foreign_keys=ON;
