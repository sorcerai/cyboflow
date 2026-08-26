-- Migration 094: per-direction sync modes + the push (create_issue) outbox kind.
--
-- Replaces 093's single `two_way` boolean with THREE independent per-connection
-- direction modes, each 'auto' | 'manual' (shared/types/trackerSync.ts →
-- TrackerDirectionMode):
--
--   status_sync_mode — status flow for LINKED items, BOTH directions (the
--                      outbound stage write-back AND the inbound application of
--                      a remote state).
--   pull_mode        — importing NEW remote issues as ideas.
--   push_mode        — NEW: a cyboflow idea created after the connection exists
--                      gets a TOP-LEVEL issue in the connection's source
--                      container.
--
-- 'auto' = the direction runs on the 5-minute tick and on live entity-change
-- events (093's behaviour). 'manual' = the direction is DEFERRED until an
-- explicit "Sync now"; intents still ENQUEUE durably in the meantime, so manual
-- mode delays work and never drops it.
--
-- BACKFILL, and why each existing row lands where it does:
--   status_sync_mode = two_way ? 'auto' : 'manual' — the old flag governed
--     exactly this direction, so it carries over verbatim.
--   pull_mode = 'auto' — importing was never gated by two_way; every existing
--     connection already pulls on the tick.
--   push_mode = 'manual' — push is NET-NEW behaviour. An existing connection
--     silently creating tracker issues for every idea its owner files would be
--     a surprise write into someone else's workspace, so it starts held. Fresh
--     connections take the column DEFAULT ('auto') from the wizard payload.
--
-- `two_way` is deliberately LEFT IN PLACE and permanently unread. Dropping it
-- would mean a fourth table recreate for a column that costs one byte a row,
-- and keeping it makes a downgrade to a 093-era build non-destructive.
--
-- tracker_outbox gains the `create_issue` kind, which needs a table RECREATE:
-- `kind` carries a CHECK constraint and SQLite cannot ALTER one. Same recipe as
-- 091/089 (create → copy → drop → rename), reproducing 093's exact column set
-- and index.
--
-- REPLAY SAFETY (a ledger-wiped DB re-runs every file end to end — see 088/093).
-- The whole file executes inside ONE transaction, so the ledger-wiped replay
-- hinges on its FIRST statement: the `ALTER TABLE ... ADD COLUMN
-- status_sync_mode` throws "duplicate column name: status_sync_mode", the
-- runner rolls the transaction back (nothing below it ran) and records the
-- ledger marker under its idempotent-ALTER tolerance — the ONLY failure shape
-- that tolerance covers. That is why the three ALTERs come first and the table
-- recreate last: a leading bare CREATE TABLE would instead re-run the recreate
-- on every replay, and a leading UPDATE would re-backfill a user's later
-- setting changes back to these defaults.

PRAGMA foreign_keys=OFF;

ALTER TABLE tracker_connections
  ADD COLUMN status_sync_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (status_sync_mode IN ('auto','manual'));
ALTER TABLE tracker_connections
  ADD COLUMN pull_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (pull_mode IN ('auto','manual'));
ALTER TABLE tracker_connections
  ADD COLUMN push_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (push_mode IN ('auto','manual'));

UPDATE tracker_connections
   SET status_sync_mode = CASE WHEN two_way = 1 THEN 'auto' ELSE 'manual' END,
       pull_mode = 'auto',
       push_mode = 'manual';

CREATE TABLE tracker_outbox_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create_sub_issue','create_issue','update_state','close_parent')),
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
