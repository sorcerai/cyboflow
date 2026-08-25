-- ORDERING CONSTRAINT — 106 AND 107 MOVE TOGETHER, ALWAYS.
--
-- The two ALTERs at the bottom of this file target `verify_runbook_bootstrap`,
-- which migration 108 creates. Migrations apply in numeric order, so renumbering
-- 106 past 107 to resolve a collision — the obvious one-file fix — makes this
-- file run first against a fresh database. "no such table" is not the
-- duplicate-column signal the runner recovers from, so the WHOLE transaction
-- rolls back, retries on every boot, and the suppression table silently never
-- exists: bootstraps stop being suppressible and the rung-1 columns go missing,
-- which quietly drops the edited file from the eval-diff excision and the
-- address-review denylist. Nothing errors; it just degrades.
--
-- If either number has to change, change both and keep 106 < 107.

-- Migration 109: the bootstrap SUPPRESSION record + the rung-1 half of the
-- bootstrap stamp (docs/proposals/lane-runbook-bootstrap.md §10, §8.1, §11).
--
-- (1) verify_runbook_bootstrap_suppression — "stop paying for a project that
--     cannot be bootstrapped".
--
--     A bootstrap that fails costs an agent deployment, a verification-budget
--     charge, and the owning lane's wall clock. On a project where the answer is
--     structurally NOT-POSSIBLE — no dev server, a build nobody scripted, a
--     surface this harness cannot stand up — that cost repeats on every sprint,
--     forever, to re-derive the same refusal. This record is what stops it.
--
--     v1 wrote its suppression under the DRAFT's runbook hash, which would never
--     have fired: the capability ledger is keyed (project, modality,
--     runbook_hash) and an unpinned no-runbook request reads the '' bucket, so
--     the suppression sat in a bucket nothing consults. That is §16's defect 8,
--     and the reason this is a dedicated table rather than a reuse.
--
--     KEYED BY WHAT WOULD MAKE THE ANSWER CHANGE, which is the whole design.
--     `input_hash` is the project's own §5.3 input hash (package scripts, the
--     lockfile, the node/electron ABI) and `host_fingerprint` is the machine's;
--     a suppression is honored only while BOTH still match. So a project that
--     adds a `dev` script, or a host that grows a chromium, reopens the question
--     IMMEDIATELY and without a TTL to wait out — which is right, because the
--     thing that made it impossible is exactly the thing that just changed. A
--     time-based expiry would have the opposite property: it would keep paying on
--     a dead project and keep refusing on a fixed one.
--
--     One row per (project, modality) — a later failure REPLACES the earlier
--     record rather than accumulating, since only the most recent observation
--     describes the project as it is now.
--
-- (2) verify_runbook_bootstrap.rung1_path / rung1_commit_sha.
--
--     §8.1 commits the rung-1 config edit SEPARATELY from the runbook, so a
--     human reviewing the branch sees one self-contained, revertible commit
--     rather than a config change buried in a JSON blob. That means a bootstrap
--     can leave TWO commits behind, and both of them have to be:
--
--       - EXCLUDED from every sibling lane's commit-integrity probe (§9). The
--         probe reads "did HEAD move?" on the shared worktree, and a machine
--         commit landing mid-lane would otherwise make a lane that committed
--         nothing look like it had. `commitShasForRun` returns both.
--       - EXCISED from the run's eval diff (§11). verify-setup is exempt from
--         auto-eval precisely because a runbook diff is not rubric material; the
--         bootstrap moves that diff class into sprint/ship runs, which ARE
--         graded and A/B-compared.
--
--     `rung1_path` is recorded separately from the sha because the excision and
--     the address-review denylist are both PATH-scoped: a reviewer must not
--     "fix" the edited file (reverting it silently un-proves the environment),
--     and the eval diff must drop that file's hunks. The runbook's own path is a
--     constant and needs no column.
--
--     NULL on every bootstrap that applied no rung-1 operation, which is the
--     ordinary rung-0 case.
--
-- NOTE: CREATE TABLE IF NOT EXISTS is idempotent directly; the two ALTERs are
-- not (SQLite has no ADD COLUMN IF NOT EXISTS) and raise 'duplicate column
-- name' on a re-run, which is the signal runFileBasedMigrations() treats as an
-- already-applied file. Ordering the CREATE first is therefore safe: on a re-run
-- the whole transaction rolls back and the CREATE was a no-op anyway.
--
-- NOTE: No explicit BEGIN/COMMIT — runFileBasedMigrations() wraps every file in
-- a this.transaction(...) call.

CREATE TABLE IF NOT EXISTS verify_runbook_bootstrap_suppression (
  project_id       INTEGER NOT NULL,
  modality         TEXT    NOT NULL,
  -- Both nullable: a host that could not compute its input hash is a host that
  -- cannot honor a suppression keyed on one, and the store treats a NULL on
  -- either side as "does not match" so it fails OPEN (re-ask the question)
  -- rather than suppressing on an unknown.
  input_hash       TEXT,
  host_fingerprint TEXT,
  -- Why it was suppressed, verbatim from the drafting agent's NOT-POSSIBLE
  -- reason or the controller's validation rejection. Human audience.
  reason           TEXT,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, modality)
);

ALTER TABLE verify_runbook_bootstrap ADD COLUMN rung1_path TEXT;
ALTER TABLE verify_runbook_bootstrap ADD COLUMN rung1_commit_sha TEXT;
