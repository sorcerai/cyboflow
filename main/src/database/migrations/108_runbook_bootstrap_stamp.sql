-- Migration 108: the run-scoped runbook-bootstrap STAMP
-- (docs/proposals/lane-runbook-bootstrap.md §9, §12 step 3).
--
-- WHY THIS IS PERSISTED AND NOT AN IN-MEMORY MUTEX. The bootstrap is a
-- multi-step, side-effecting sequence — draft, commit, register, prove, re-enqueue
-- — driven by one lane while its siblings run concurrently in the SAME worktree.
-- It needs two things a closure variable cannot give it:
--
--   SINGLE-FLIGHT ACROSS LANES. Five sprint lanes reach visual-verify at
--   whatever moment their own work finishes. Exactly ONE may derive a runbook:
--   `registerDraft` UPSERTs a singleton (project_id, modality) row, so two lanes
--   racing would interleave two derivations over one record, and each would then
--   prove a revision the other had already replaced. The winner of an atomic
--   INSERT here is the owner; everyone else reads the stamp and takes today's
--   skip.
--
--   SURVIVAL ACROSS A RESTART. v1's single-flight was a mutex in the controller
--   closure, which was simply wrong: the controller reconstructs its state on
--   resume and restarts lanes at inner step zero, so a crash after the commit,
--   the registration, or the enqueue would re-run the drafting agent and race
--   rows that already exist. The stamp records WHICH step completed, so recovery
--   is "read it and resume at the first incomplete one" rather than a bespoke
--   state machine or a blind redo.
--
-- KEYED (run_id, project_id, modality). Run-scoped rather than project-scoped on
-- purpose: a bootstrap that failed in run A must not permanently suppress the
-- question for run B (the project may have changed in exactly the way that makes
-- it work now), while WITHIN a run one attempt per modality is the whole point.
-- The §10 bootstrap SUPPRESSION — the "stop paying for a project that cannot be
-- bootstrapped" record — is a separate, project-scoped concern keyed by input
-- hash + host fingerprint, and deliberately not folded in here: they answer
-- different questions and expire on different evidence.
--
-- `state` is the resume cursor, and its order is the sequence in §12:
--   claimed  — the owner won the race; nothing has been written yet.
--   drafted  — the runbook file is written AND committed (commit_sha is set).
--   proving  — a bootstrap_proof request is in flight (request_id is set).
--   proven   — the engine flipped the record; the lane re-enqueues ordinarily.
--   failed   — terminal for this run; every later lane takes today's skip.
-- Left as TEXT with a CHECK rather than an enum table: five values that change
-- only when this proposal's phases change, and a CHECK keeps a hand-edited DB
-- from inventing a sixth that the resume logic would silently treat as unknown.
--
-- `round` is the ≤2 draft-round counter (§12 step 7). A second round re-drafts
-- with the first proof's failure feedback, and it is what makes the proof's
-- enqueue key (`...:bootstrap:<round>`, migration 105's other half) unique —
-- without a fresh key, `findLiveRequestByEnqueueKey` would return the first
-- round's terminal row and deploy nothing.
--
-- `owner_task_ref` is the lane that claimed it. Recorded so a RESTARTED owner
-- resumes its own bootstrap rather than being locked out by its own stamp, and
-- so the artifact can say which lane paid for it.
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in
-- a this.transaction(...) call. CREATE TABLE IF NOT EXISTS makes this file
-- idempotent directly, without relying on the 'duplicate column name' signal the
-- ALTER-based migrations key off.

CREATE TABLE IF NOT EXISTS verify_runbook_bootstrap (
  run_id          TEXT    NOT NULL,
  project_id      INTEGER NOT NULL,
  modality        TEXT    NOT NULL,
  owner_task_ref  TEXT    NOT NULL,
  state           TEXT    NOT NULL CHECK (state IN ('claimed','drafted','proving','proven','failed')),
  round           INTEGER NOT NULL DEFAULT 1,
  -- The bootstrap's own commit, EXCLUDED from every other lane's commit-integrity
  -- probe (§9): beginCommitProbe reports headAdvanced on the shared worktree, so
  -- a machine commit landing mid-lane would otherwise make a lane that committed
  -- nothing look like it had.
  commit_sha      TEXT,
  -- The registered revision this run's proof is pinned to (runbookStore's
  -- content hash + CAS version). Both NULL until 'drafted'.
  runbook_hash    TEXT,
  runbook_version INTEGER,
  -- The in-flight bootstrap_proof request, so a resume can await the SAME
  -- request rather than firing a second one.
  request_id      TEXT,
  -- Why it ended, for the artifact and the finding. Free text: this is a human
  -- audience, and constraining it would only invite a lossy code.
  detail          TEXT,
  claimed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (run_id, project_id, modality)
);
