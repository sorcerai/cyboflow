-- Migration 106: restore the findings the archive sweeps destroyed on sessions
-- whose work was actually DELIVERED.
--
-- WHY THESE ROWS EXIST
--
-- `sessions:delete` dismisses every pending review item a session's runs
-- produced, and that seam is reached by a plain dismiss AND by the successful
-- merge / created-PR close-outs (SessionMergeDialog and SessionCreatePrDialog
-- delete the session as soon as the work is away). So a merge destroyed the
-- findings it had just produced, milliseconds later, with resolution
-- 'session dismissed'. `backfillArchivedSessionReviewItems` did the same at
-- every boot for anything the live sweep missed, with resolution
-- 'archived session boot backfill'.
--
-- The result was a closed loop: the Insights compounding surface only offers
-- findings from a session that landed its work, and landing the work was
-- exactly what deleted them. Across a real installation this left ZERO pending
-- findings from a delivered session in any project.
--
-- Both sweeps now carve findings out of a delivered session
-- (DELIVERED_SESSION_FINDING_CARVE_OUT in orchestrator/runRecovery.ts). This
-- migration reopens what they already took.
--
-- SCOPE — deliberately narrow:
--   * kind='finding' only. Gates (permission / decision / human_task) were
--     dismissed correctly: they need a live run to resume and can never be
--     actioned again.
--   * The two ARCHIVE-SWEEP resolutions only. 'entity deleted' is a different
--     sweep (the finding's task/idea was deleted) and stays dismissed — its
--     subject is gone, not merely archived.
--   * Delivered sessions only, read the same way the runtime reads it: the
--     finding's own run, or any sibling run in the same session, carries a
--     DELIVERED_RUN_OUTCOMES stamp. A session whose work was thrown away keeps
--     its findings dismissed — they describe code that never landed.
--
-- The restored rows go back to exactly the state the sweep found them in:
-- status='pending' with no resolution. `staged_at` / `selected` are untouched,
-- so a finding the human had already approved into READY returns as READY.
--
-- Idempotent: after the first application no row matches the
-- status='dismissed' + resolution predicate, so re-running is a no-op.
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() in database.ts wraps
-- every file in a transaction, so an inner BEGIN would nest.

UPDATE review_items
   SET status      = 'pending',
       resolution  = NULL,
       resolved_by = NULL,
       updated_at  = CURRENT_TIMESTAMP
 WHERE kind = 'finding'
   AND status = 'dismissed'
   AND resolution IN ('session dismissed', 'archived session boot backfill')
   AND run_id IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM workflow_runs r
      WHERE r.id = review_items.run_id
        AND (
          COALESCE(r.outcome, '') IN ('merged', 'integrated', 'completed', 'pr_open')
          OR EXISTS (
            SELECT 1
              FROM workflow_runs wrm
             WHERE wrm.session_id = r.session_id
               AND wrm.outcome IN ('merged', 'integrated', 'completed', 'pr_open')
          )
        )
   );
