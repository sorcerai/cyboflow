-- Migration 112: collapse superseded Codex snapshot notifications in raw_events.
--
-- Three app-server notification methods carry a CUMULATIVE SNAPSHOT rather than
-- an increment — each message restates the entire current value, so every row
-- but the last is dead the moment its successor arrives. Appended blindly they
-- were measured at ~80 MB across ~37k rows of a 1.18 GB production payload
-- (2026-08-21), ~98% of it superseded:
--
--   turn/diff/updated           68 MB / 3,739 rows across 138 turns. The FULL
--                               working-tree diff, re-sent per update: one turn
--                               logged 113 snapshots growing 70 KB -> 95 KB.
--                               Keeping the last per turn leaves ~1 MB.
--   thread/tokenUsage/updated    7 MB / 16,795 rows across 678 turns — a
--                               cumulative counter sampled ~25x per turn, where
--                               the last sample IS the turn total.
--   account/rateLimits/updated   5 MB / 16,800 rows carrying only 276 DISTINCT
--                               payloads (98.4% byte-identical) — an
--                               account-wide gauge re-persisted per event tick.
--                               It carries no turn scope, so it collapses to one
--                               row per run.
--
-- No information is lost: the surviving row is the newest snapshot, which by the
-- cumulative contract subsumes every row removed here. This is a different trade
-- from 072, which dropped delta rows whose durable finals lived elsewhere — here
-- the final snapshot has no other home, so it is explicitly preserved.
--
-- The write path is fixed in the same change-set: CodexRawNotificationSink now
-- stamps a dedup_key on exactly these methods and upserts, making them
-- last-write-wins via 071's partial unique index. The UPDATE below stamps the
-- SAME keys on the survivors so a resumed run upserts onto its historical row
-- instead of opening a second one beside it — the key format is
-- `codex:<slug>:<run_id>:<turnId or 'run'>` and MUST stay in lockstep with
-- buildSnapshotDedupKey() in rawNotificationSink.ts.
--
-- Freed pages go to SQLite's freelist; the conditional VACUUM in database.ts
-- (maybeVacuumAfterBulkDelete) requires the freelist to be BOTH >50 MB and >20%
-- of the file, so on a large DB this reclaim may fall under the ratio gate and
-- leave the file size unchanged while still halting growth (pages get reused).
-- That is intended — an unconditional VACUUM on a multi-GB file at boot is worse.

-- Order matters: dedup FIRST so each surviving group is unique, THEN stamp the
-- key. Stamping first would violate the partial unique index on dedup_key.
DELETE FROM raw_events
WHERE event_type = 'codex_app_server_notification'
  AND json_extract(payload_json, '$.method') IN
    ('turn/diff/updated', 'thread/tokenUsage/updated', 'account/rateLimits/updated')
  AND id NOT IN (
    SELECT MAX(id)
    FROM raw_events
    WHERE event_type = 'codex_app_server_notification'
      AND json_extract(payload_json, '$.method') IN
        ('turn/diff/updated', 'thread/tokenUsage/updated', 'account/rateLimits/updated')
    GROUP BY
      run_id,
      json_extract(payload_json, '$.method'),
      COALESCE(json_extract(payload_json, '$.params.turnId'), 'run')
  );

UPDATE raw_events
SET dedup_key =
  'codex:'
  || CASE json_extract(payload_json, '$.method')
       WHEN 'turn/diff/updated' THEN 'turn-diff'
       WHEN 'thread/tokenUsage/updated' THEN 'token-usage'
       WHEN 'account/rateLimits/updated' THEN 'rate-limits'
     END
  || ':' || run_id
  || ':' || COALESCE(json_extract(payload_json, '$.params.turnId'), 'run')
WHERE event_type = 'codex_app_server_notification'
  AND json_extract(payload_json, '$.method') IN
    ('turn/diff/updated', 'thread/tokenUsage/updated', 'account/rateLimits/updated')
  AND dedup_key IS NULL;
