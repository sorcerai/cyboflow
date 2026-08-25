-- Migration 118: tracker content/archive write-back modes + mapping overlays,
-- and the tracker_outbox kind widening they need.
--
-- Design: docs/proposals/tracker-field-writeback.md ("Phase 3 — Migration 118
-- + direction modes + outbox kinds"). Two independent additions to
-- tracker_connections, each gated OFF for every connection that predates this
-- feature — neither existing connection consented to writing local edits back
-- into someone else's tracker workspace:
--
--   content_sync_mode  — field write-back ("Sync task fields": title,
--                        description, priority, category) for LINKED items,
--                        OUTBOUND only. A THIRD, separate schema from the
--                        existing status_sync_mode/pull_mode/push_mode
--                        (094 / `TrackerDirectionMode`) rather than a widening
--                        of it: those three answer "auto or manual", this
--                        answers "auto, manual, or never" —
--                        tracker.ts:219-225's `directionModeSchema` comment
--                        already warns against coupling a third value onto
--                        that pair, so `TrackerContentSyncMode` is minted as
--                        its own type instead.
--   archive_sync_mode  — remote trash/archive on a local archive/delete, same
--                        three-state shape, same reasoning.
--
-- 'off' is the backfill DEFAULT for both: an existing connection's owner never
-- saw a UI offering this feature, so silently starting to write derived field
-- values or archive issues into their tracker on upgrade would be a surprise
-- write into someone else's workspace — the same argument 094's header makes
-- for push_mode defaulting to 'manual' rather than 'auto'. A FRESH connection
-- still takes the column DEFAULT ('off') until Phase 6 wires a wizard control
-- that asks for something else; no data migration UPDATE is needed for either
-- column, so this file has no backfill step (unlike 094's push_mode, which
-- had an existing `two_way` flag to derive from).
--
-- priority_mapping_json / category_mapping_json are the persisted OVERLAY half
-- of priorityMapping.ts / categoryMapping.ts's seed-then-overlay contract
-- (already landed as of this migration — every Phase-2 caller passes
-- `overlayJson: null` and gets the seed verbatim, specifically so this column
-- could arrive later without touching that code). DEFAULT '{}' needs no
-- backfill UPDATE either: resolveEffective*Mapping's parseOverlay treats an
-- empty object exactly like a missing one ("nothing to overlay") and falls
-- through to the seed, which is what a connection that predates the two
-- mapping tables should get.
--
-- tracker_outbox gains 'update_content' and 'archive_issue' to its `kind`
-- CHECK — the two write kinds Phase 5 drains. SQLite cannot ALTER a CHECK, so
-- (094/105 recipe) this is a table RECREATE: create -> copy -> drop -> rename,
-- reproducing the CURRENT live column set VERBATIM. That set is 093's columns
-- unchanged: 094 widened this same table's `kind` CHECK in place (an identical
-- recreate, no NEW columns, no sqlite_sequence carry-forward — mirrored here
-- for the same reason) and nothing since has touched tracker_outbox. 105's
-- recreate covers entity_external_links + tracker_connections only, and 110
-- only ALTERs tracker_connections. (tracker_connections' own push_target
-- column, added by 110, lives on the OTHER table — this file only ALTERs
-- tracker_connections, never recreates it, so push_target survives untouched
-- regardless of anything below.)
--
-- ORDER — the four ALTERs FIRST, the tracker_outbox recreate LAST, per 094's
-- replay argument reproduced here for tracker_connections' new columns: a
-- ledger-wiped replay's FIRST statement is the first `ALTER TABLE
-- tracker_connections ADD COLUMN content_sync_mode`, which throws "duplicate
-- column name" on a second pass, the runner rolls the whole transaction back
-- under its idempotent-ALTER tolerance, and NOTHING below it (including the
-- recreate) re-runs. A leading bare CREATE TABLE, or an UPDATE before the
-- ALTERs, would not have that property (089/091/094's own headers make the
-- identical argument).
--
-- REPLAY SAFETY for the tracker_outbox recreate itself: convergent rather than
-- merely tolerated, the same way 094's and 105's recreates are — each pass
-- copies every row verbatim with no backfill or value rewriting, so a second
-- pass reproduces a byte-identical table holding the same rows.

PRAGMA foreign_keys=OFF;

ALTER TABLE tracker_connections
  ADD COLUMN content_sync_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (content_sync_mode IN ('auto','manual','off'));
ALTER TABLE tracker_connections
  ADD COLUMN archive_sync_mode TEXT NOT NULL DEFAULT 'off'
  CHECK (archive_sync_mode IN ('auto','manual','off'));
ALTER TABLE tracker_connections
  ADD COLUMN priority_mapping_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE tracker_connections
  ADD COLUMN category_mapping_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE tracker_outbox_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'create_sub_issue','create_issue','update_state','close_parent',
    'update_content','archive_issue'
  )),
  entity_type TEXT,
  entity_id TEXT,
  external_id TEXT,
  client_key TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','in_flight','done','failed','ambiguous')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (connection_id) REFERENCES tracker_connections(id) ON DELETE CASCADE
);

INSERT INTO tracker_outbox_new (
  id, connection_id, kind, entity_type, entity_id, external_id, client_key,
  payload_json, state, attempts, last_error, next_attempt_at, created_at, updated_at
)
  SELECT id, connection_id, kind, entity_type, entity_id, external_id, client_key,
         payload_json, state, attempts, last_error, next_attempt_at, created_at, updated_at
    FROM tracker_outbox;

DROP TABLE tracker_outbox;
ALTER TABLE tracker_outbox_new RENAME TO tracker_outbox;

CREATE INDEX IF NOT EXISTS idx_tracker_outbox_conn_state ON tracker_outbox(connection_id, state);

PRAGMA foreign_keys=ON;
