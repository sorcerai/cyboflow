/**
 * RunbookBootstrapStampStore — the run-scoped single-flight + resume cursor for
 * the lane runbook bootstrap (docs/proposals/lane-runbook-bootstrap.md §9),
 * persisted on migration 108's `verify_runbook_bootstrap` table.
 *
 * THE ONE THING TO UNDERSTAND: `claim()` is the whole concurrency design. Five
 * sprint lanes reach `visual-verify` at unpredictable moments in the SAME
 * worktree, and exactly one of them may derive a runbook, because
 * `VerifyRunbookStore.registerDraft` UPSERTs a singleton `(project, modality)`
 * row — two lanes racing would interleave two derivations over one record, and
 * each would then prove a revision the other had already replaced. The winner is
 * decided by an atomic INSERT whose primary key IS the mutual exclusion; there
 * is no read-then-write anywhere on that path, so there is no window to lose.
 *
 * AND IT MUST SURVIVE A RESTART, which is why it is a table and not a mutex in
 * the controller closure (v1's mistake). The controller reconstructs state on
 * resume and restarts lanes at inner step zero, so a crash after the commit, the
 * registration, or the proof enqueue would otherwise re-run the drafting agent
 * and race rows that already exist. `state` is a resume CURSOR, not a status
 * badge: a returning owner reads which step completed and continues from the
 * first incomplete one.
 *
 * THE OWNER RE-ENTRY RULE is the subtle half. A lock that excluded its own owner
 * would be worse than none — a restarted owner would be permanently locked out
 * of finishing what it started, and the run would hold a claimed stamp nobody
 * can advance. So `claim()` distinguishes four outcomes, and only ONE of them
 * ('held') means "someone else is doing this; take today's skip".
 *
 * FAIL-SOFT, in the same posture as runbookStore/capabilityStore: every method
 * catches its own SQL errors (a pre-106 DB, a locked file, a hand-edited row)
 * and degrades to the answer that DOES NOTHING — for `claim()` that is
 * `'unavailable'`, which the preflight treats as "do not bootstrap", never as
 * "you own it". There is no failure mode here that hands two lanes the same
 * claim.
 */
import type { DatabaseLike, LoggerLike } from '../types';
import type { VerificationModality } from '../../../../shared/types/visualVerification';
import { VERIFY_RUNBOOK_RELATIVE_PATH } from '../../../../shared/types/verifyRunbook';

/**
 * The resume cursor. Ordered as the sequence in §12 — a state implies every
 * earlier one completed:
 *
 *   claimed → drafted → proving → proven
 *                              ↘ failed
 */
export type BootstrapStampState = 'claimed' | 'drafted' | 'proving' | 'proven' | 'failed';

/** A stamp row as the preflight reads it. */
export interface BootstrapStamp {
  runId: string;
  projectId: number;
  modality: VerificationModality;
  ownerTaskRef: string;
  state: BootstrapStampState;
  round: number;
  commitSha: string | null;
  runbookHash: string | null;
  runbookVersion: number | null;
  requestId: string | null;
  detail: string | null;
  /**
   * The rung-1 edit this bootstrap applied (migration 109), or null on the
   * ordinary rung-0 path. The PATH is carried separately from the sha because
   * the two consumers are path-scoped rather than commit-scoped: the eval diff
   * drops that file's hunks (§11), and address-review is told not to touch it
   * (a reviewer "fixing" it would silently un-prove the environment).
   *
   * Both read `null` on a pre-107 DB — the same answer as "no rung-1 edit",
   * which is the honest degradation: such a DB has none.
   */
  rung1Path: string | null;
  rung1CommitSha: string | null;
}

/**
 * What `claim()` decided. The four outcomes are NOT shades of one answer — each
 * sends the caller down a different path:
 *
 *  - `'claimed'`  — a fresh row; this lane owns the bootstrap and must run it.
 *  - `'resumed'`  — a non-terminal row this SAME lane already owns (a restart).
 *                   Continue from `stamp.state`; do NOT start over.
 *  - `'held'`     — a non-terminal row owned by a DIFFERENT lane. Take today's
 *                   skip; the finding says a bootstrap is in flight.
 *  - `'settled'`  — a terminal row ('proven' or 'failed') for this run. Nothing
 *                   more to do here: on 'proven' the ordinary enqueue now passes
 *                   the gate on its own, on 'failed' the run has already decided.
 *  - `'unavailable'` — the store could not answer (pre-106 DB, SQL error). Do
 *                   nothing, which is byte-identical to the feature being off.
 */
export type BootstrapClaim =
  | { kind: 'claimed'; stamp: BootstrapStamp }
  | { kind: 'resumed'; stamp: BootstrapStamp }
  | { kind: 'held'; stamp: BootstrapStamp }
  | { kind: 'settled'; stamp: BootstrapStamp }
  | { kind: 'unavailable' };

/** Raw row shape as read back from SQLite. */
interface StampRow {
  run_id: string;
  project_id: number;
  modality: string;
  owner_task_ref: string;
  state: string;
  round: number;
  commit_sha: string | null;
  runbook_hash: string | null;
  runbook_version: number | null;
  request_id: string | null;
  detail: string | null;
  rung1_path?: string | null;
  rung1_commit_sha?: string | null;
}

const TERMINAL: ReadonlySet<BootstrapStampState> = new Set<BootstrapStampState>(['proven', 'failed']);

/** Narrowing helper — the CHECK constraint guarantees this, a hand-edited DB does not. */
function isStampState(value: string): value is BootstrapStampState {
  return (
    value === 'claimed' ||
    value === 'drafted' ||
    value === 'proving' ||
    value === 'proven' ||
    value === 'failed'
  );
}

export class RunbookBootstrapStampStore {
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
  ) {}

  /**
   * Win, re-enter, or lose the single-flight for this (run, project, modality).
   *
   * THE INSERT IS THE LOCK. `INSERT ... ON CONFLICT DO NOTHING` either creates
   * the row (this lane won) or changes nothing (someone got there first), in one
   * atomic statement — so there is no read-then-write window for a sibling lane
   * to slip through. Only when the insert reports zero changes does this read
   * the existing row, and by then the question is merely "whose is it?", which
   * is no longer racy: an owner never changes.
   *
   * A row whose `state` is unrecognized (a hand-edited DB) is reported as
   * `'held'` rather than resumed or overwritten — an unreadable cursor is the
   * one case where doing nothing is unambiguously right.
   */
  claim(args: {
    runId: string;
    projectId: number;
    modality: VerificationModality;
    ownerTaskRef: string;
  }): BootstrapClaim {
    const { runId, projectId, modality, ownerTaskRef } = args;
    try {
      const inserted = this.db
        .prepare(
          `INSERT INTO verify_runbook_bootstrap
             (run_id, project_id, modality, owner_task_ref, state, round, claimed_at, updated_at)
           VALUES (?, ?, ?, ?, 'claimed', 1, ?, ?)
           ON CONFLICT(run_id, project_id, modality) DO NOTHING`,
        )
        .run(runId, projectId, modality, ownerTaskRef, nowIso(), nowIso());

      if (inserted.changes > 0) {
        const fresh = this.read(runId, projectId, modality);
        // The row was just written by this statement; a null here means the
        // read itself failed, and inventing a stamp would be worse than
        // declining.
        return fresh ? { kind: 'claimed', stamp: fresh } : { kind: 'unavailable' };
      }

      const existing = this.read(runId, projectId, modality);
      if (!existing) return { kind: 'unavailable' };
      if (TERMINAL.has(existing.state)) return { kind: 'settled', stamp: existing };
      if (existing.ownerTaskRef === ownerTaskRef) return { kind: 'resumed', stamp: existing };
      return { kind: 'held', stamp: existing };
    } catch (err) {
      this.logger?.warn('[RunbookBootstrapStampStore] claim failed (fail-soft)', {
        runId,
        projectId,
        modality,
        error: err instanceof Error ? err.message : String(err),
      });
      return { kind: 'unavailable' };
    }
  }

  /** The stamp for this (run, project, modality), or `null` when absent/unreadable. */
  read(
    runId: string,
    projectId: number,
    modality: VerificationModality,
  ): BootstrapStamp | null {
    try {
      // The migration-107 rung-1 columns are read through the widen-then-fall-
      // back ladder every other defensive read in verify/ uses: a pre-107 DB
      // throws on `prepare` (before any read), and losing the WHOLE stamp to
      // that throw would make the resume cursor unreadable on a binary that has
      // one. The fallback drops only the two columns such a DB never had.
      let row: StampRow | undefined;
      try {
        row = this.db
          .prepare(
            `SELECT run_id, project_id, modality, owner_task_ref, state, round,
                    commit_sha, runbook_hash, runbook_version, request_id, detail,
                    rung1_path, rung1_commit_sha
             FROM verify_runbook_bootstrap
             WHERE run_id = ? AND project_id = ? AND modality = ?`,
          )
          .get(runId, projectId, modality) as StampRow | undefined;
      } catch {
        row = this.db
          .prepare(
            `SELECT run_id, project_id, modality, owner_task_ref, state, round,
                    commit_sha, runbook_hash, runbook_version, request_id, detail
             FROM verify_runbook_bootstrap
             WHERE run_id = ? AND project_id = ? AND modality = ?`,
          )
          .get(runId, projectId, modality) as StampRow | undefined;
      }
      if (!row) return null;
      if (!isStampState(row.state)) {
        this.logger?.warn('[RunbookBootstrapStampStore] unrecognized stamp state', {
          runId,
          projectId,
          modality,
          state: row.state,
        });
        return null;
      }
      return {
        runId: row.run_id,
        projectId: row.project_id,
        modality: row.modality as VerificationModality,
        ownerTaskRef: row.owner_task_ref,
        state: row.state,
        round: row.round,
        commitSha: row.commit_sha,
        runbookHash: row.runbook_hash,
        runbookVersion: row.runbook_version,
        requestId: row.request_id,
        detail: row.detail,
        rung1Path: row.rung1_path ?? null,
        rung1CommitSha: row.rung1_commit_sha ?? null,
      };
    } catch (err) {
      this.logger?.warn('[RunbookBootstrapStampStore] read failed (fail-soft)', {
        runId,
        projectId,
        modality,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Move the cursor forward and record what the completed step produced.
   *
   * GUARDED BY OWNER, not just by key: the UPDATE's WHERE includes
   * `owner_task_ref`, so a lane that somehow reached here without owning the
   * stamp writes nothing rather than stomping the owner's progress. Returns
   * whether the write landed, which is the caller's signal that its assumption
   * about ownership was wrong.
   *
   * Fields are patched, never cleared: passing `undefined` for one leaves the
   * stored value alone. This matters on the ≤2-round retry path (§12 step 7),
   * where round 2 must keep round 1's `commit_sha` — the draft commit is still
   * on the branch and still has to be excluded from every sibling lane's commit
   * probe (§9), whatever happens to the proof.
   */
  advance(args: {
    runId: string;
    projectId: number;
    modality: VerificationModality;
    ownerTaskRef: string;
    state: BootstrapStampState;
    round?: number;
    commitSha?: string;
    runbookHash?: string;
    runbookVersion?: number;
    requestId?: string;
    detail?: string;
    /** The rung-1 edit's repo-relative path and its own commit (migration 109). */
    rung1Path?: string;
    rung1CommitSha?: string;
  }): boolean {
    const tail = [
      nowIso(),
      args.runId,
      args.projectId,
      args.modality,
      args.ownerTaskRef,
    ] as const;
    const head = [
      args.state,
      args.round ?? null,
      args.commitSha ?? null,
      args.runbookHash ?? null,
      args.runbookVersion ?? null,
      args.requestId ?? null,
      args.detail ?? null,
    ] as const;
    try {
      // Same widen-then-fall-back ladder as `read`. Note the asymmetry with a
      // read: a pre-107 DB that cannot store the rung-1 columns STILL records
      // the state transition, because losing the cursor move would strand the
      // bootstrap mid-sequence. What such a DB loses is only the provenance of
      // an edit it could not have applied through this build anyway.
      let result: { changes: number };
      try {
        result = this.db
          .prepare(
            `UPDATE verify_runbook_bootstrap
             SET state            = ?,
                 round            = COALESCE(?, round),
                 commit_sha       = COALESCE(?, commit_sha),
                 runbook_hash     = COALESCE(?, runbook_hash),
                 runbook_version  = COALESCE(?, runbook_version),
                 request_id       = COALESCE(?, request_id),
                 detail           = COALESCE(?, detail),
                 rung1_path       = COALESCE(?, rung1_path),
                 rung1_commit_sha = COALESCE(?, rung1_commit_sha),
                 updated_at       = ?
             WHERE run_id = ? AND project_id = ? AND modality = ? AND owner_task_ref = ?`,
          )
          .run(...head, args.rung1Path ?? null, args.rung1CommitSha ?? null, ...tail);
      } catch {
        result = this.db
          .prepare(
            `UPDATE verify_runbook_bootstrap
             SET state           = ?,
                 round           = COALESCE(?, round),
                 commit_sha      = COALESCE(?, commit_sha),
                 runbook_hash    = COALESCE(?, runbook_hash),
                 runbook_version = COALESCE(?, runbook_version),
                 request_id      = COALESCE(?, request_id),
                 detail          = COALESCE(?, detail),
                 updated_at      = ?
             WHERE run_id = ? AND project_id = ? AND modality = ? AND owner_task_ref = ?`,
          )
          .run(...head, ...tail);
      }
      return result.changes > 0;
    } catch (err) {
      this.logger?.warn('[RunbookBootstrapStampStore] advance failed (fail-soft)', {
        runId: args.runId,
        projectId: args.projectId,
        modality: args.modality,
        state: args.state,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Every repo path this run's bootstrap WROTE — the §11 excision list.
   *
   * PATH-scoped rather than commit-scoped, because its two consumers both work
   * in paths: the eval diff drops these files' hunks so a sprint is not
   * rubric-graded on machine-written JSON its agents did not author, and
   * address-review is told not to touch them (a reviewer "fixing" the runbook
   * demotes it by hash drift, and one reverting the rung-1 edit silently
   * un-proves the environment).
   *
   * Gated on `commit_sha`, not on the stamp existing. A claimed-but-never-written
   * bootstrap has changed nothing, and listing the runbook path for it would
   * excise a file some OTHER actor wrote — the one way a path-scoped exclusion
   * can remove work that is not the bootstrap's.
   *
   * Empty (never throws) when nothing was written or the table is unreadable,
   * which is the pre-bootstrap behavior exactly.
   */
  writtenPathsForRun(runId: string): string[] {
    try {
      let rows: Array<{ commit_sha: string | null; rung1_path?: string | null }>;
      try {
        rows = this.db
          .prepare('SELECT commit_sha, rung1_path FROM verify_runbook_bootstrap WHERE run_id = ?')
          .all(runId) as Array<{ commit_sha: string | null; rung1_path: string | null }>;
      } catch {
        rows = this.db
          .prepare('SELECT commit_sha FROM verify_runbook_bootstrap WHERE run_id = ?')
          .all(runId) as Array<{ commit_sha: string | null }>;
      }
      const paths = new Set<string>();
      for (const row of rows) {
        if (typeof row.commit_sha !== 'string' || row.commit_sha.trim().length === 0) continue;
        paths.add(VERIFY_RUNBOOK_RELATIVE_PATH);
        if (typeof row.rung1_path === 'string' && row.rung1_path.trim().length > 0) {
          paths.add(row.rung1_path);
        }
      }
      return [...paths];
    } catch (err) {
      this.logger?.debug('[RunbookBootstrapStampStore] written-path read failed (fail-soft)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Every bootstrap commit this run made, for the §9 commit-integrity-probe
   * exclusion. Returns shas across ALL modalities of the run, because the probe
   * asks "did HEAD move for a reason that is not this lane?" and a bootstrap
   * commit for any modality is such a reason.
   *
   * Fail-soft to `[]`, which is the pre-106 behavior: no exclusions, the probe
   * as it shipped.
   */
  commitShasForRun(runId: string): string[] {
    try {
      // BOTH commits, because §8.1 splits them: the runbook lands in one commit
      // and the rung-1 config edit in its own, so a human reviewing the branch
      // can revert the config change on its own. A probe that excluded only the
      // first would still see the second and reach the same wrong conclusion.
      let rows: Array<{ commit_sha: string | null; rung1_commit_sha?: string | null }>;
      try {
        rows = this.db
          .prepare(
            `SELECT commit_sha, rung1_commit_sha FROM verify_runbook_bootstrap WHERE run_id = ?`,
          )
          .all(runId) as Array<{ commit_sha: string | null; rung1_commit_sha: string | null }>;
      } catch {
        rows = this.db
          .prepare(`SELECT commit_sha FROM verify_runbook_bootstrap WHERE run_id = ?`)
          .all(runId) as Array<{ commit_sha: string | null }>;
      }
      return rows
        .flatMap((r) => [r.commit_sha, r.rung1_commit_sha ?? null])
        .filter((sha): sha is string => typeof sha === 'string' && sha.trim().length > 0);
    } catch (err) {
      this.logger?.warn('[RunbookBootstrapStampStore] commit sha read failed (fail-soft)', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}
