/**
 * BootstrapSuppressionStore — "stop paying for a project that cannot be
 * bootstrapped" (docs/proposals/lane-runbook-bootstrap.md §10, migration 109).
 *
 * THE COST THIS EXISTS TO STOP. A bootstrap that ends in `NOT-POSSIBLE` — no dev
 * server, a build nobody scripted, a surface this harness cannot stand up — still
 * spent an agent deployment and the owning lane's wall clock to reach that
 * answer. Without a record, every sprint on that project pays it again to
 * re-derive the same refusal.
 *
 * KEYED BY WHAT WOULD MAKE THE ANSWER CHANGE, NOT BY TIME. The suppression holds
 * the project's §5.3 input hash (package scripts, lockfile, node/electron ABI)
 * and the host fingerprint AS THEY WERE when the attempt failed, and it is
 * honored only while BOTH still match. A project that adds a `dev` script, or a
 * host that grows a chromium, reopens the question on the very next request — no
 * TTL to wait out. A time-based expiry would get both directions wrong: it keeps
 * charging a dead project until the clock runs down, and keeps refusing a fixed
 * one for the same interval.
 *
 * FAILS OPEN, ALWAYS. Every unreadable state — a pre-107 DB, a SQL error, a NULL
 * hash on either side — answers "not suppressed". The cost of failing open is
 * one bootstrap attempt; the cost of failing closed would be a project silently
 * never verifying again because a hash column could not be read once.
 *
 * v1 WROTE ITS SUPPRESSION WHERE NOTHING WOULD READ IT (§16 defect 8): under the
 * draft's runbook hash, while the capability ledger keys unpinned no-runbook
 * requests to the `''` bucket. That is why this is a dedicated table with its own
 * key rather than a reuse of the ledger.
 */
import type { DatabaseLike, LoggerLike } from '../types';
import type { VerificationModality } from '../../../../shared/types/visualVerification';

/** A stored suppression, as {@link BootstrapSuppressionStore.read} returns it. */
export interface BootstrapSuppression {
  projectId: number;
  modality: VerificationModality;
  inputHash: string | null;
  hostFingerprint: string | null;
  reason: string | null;
  createdAt: string | null;
}

export class BootstrapSuppressionStore {
  constructor(
    private readonly db: DatabaseLike,
    private readonly logger?: LoggerLike,
  ) {}

  /**
   * Is this (project, modality) currently suppressed for THESE inputs?
   *
   * Both hashes must be present and equal. A null on either side — the caller
   * could not compute one, or the stored row predates one — is treated as "does
   * not match", so an unobservable environment reopens the question rather than
   * inheriting a suppression that describes some other state of the world.
   */
  isSuppressed(args: {
    projectId: number;
    modality: VerificationModality;
    inputHash: string | null;
    hostFingerprint: string | null;
  }): boolean {
    if (args.inputHash === null || args.hostFingerprint === null) return false;
    const row = this.read(args.projectId, args.modality);
    if (row === null) return false;
    return row.inputHash === args.inputHash && row.hostFingerprint === args.hostFingerprint;
  }

  /** The stored suppression for this (project, modality), or `null`. Fail-soft. */
  read(projectId: number, modality: VerificationModality): BootstrapSuppression | null {
    try {
      const row = this.db
        .prepare(
          `SELECT project_id, modality, input_hash, host_fingerprint, reason, created_at
             FROM verify_runbook_bootstrap_suppression
            WHERE project_id = ? AND modality = ?`,
        )
        .get(projectId, modality) as
        | {
            project_id: number;
            modality: string;
            input_hash: string | null;
            host_fingerprint: string | null;
            reason: string | null;
            created_at: string | null;
          }
        | undefined;
      if (!row) return null;
      return {
        projectId: row.project_id,
        modality: row.modality as VerificationModality,
        inputHash: row.input_hash,
        hostFingerprint: row.host_fingerprint,
        reason: row.reason,
        createdAt: row.created_at,
      };
    } catch (err) {
      this.logger?.debug('[BootstrapSuppressionStore] read failed (treating as not suppressed)', {
        projectId,
        modality,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Record (or replace) a suppression.
   *
   * REPLACES rather than accumulates: only the most recent observation describes
   * the project as it is now, and a history of refusals is not something any
   * reader here needs.
   *
   * Called ONLY for the structural refusals — the drafting agent's
   * `NOT-POSSIBLE` and the controller's validation rejections. Deliberately NOT
   * called for a proof FAILURE: a proof that failed says the derived commands did
   * not stand the project up on this attempt, which is a much weaker claim than
   * "this project cannot be bootstrapped", and suppressing on it would let one
   * flaky build silence a project whose runbook is nearly right. The run-scoped
   * stamp already stops the retry loop WITHIN a run; the next run gets a fresh
   * attempt on purpose.
   */
  suppress(args: {
    projectId: number;
    modality: VerificationModality;
    inputHash: string | null;
    hostFingerprint: string | null;
    reason: string;
  }): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO verify_runbook_bootstrap_suppression
             (project_id, modality, input_hash, host_fingerprint, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(project_id, modality) DO UPDATE SET
             input_hash       = excluded.input_hash,
             host_fingerprint = excluded.host_fingerprint,
             reason           = excluded.reason,
             created_at       = excluded.created_at`,
        )
        .run(
          args.projectId,
          args.modality,
          args.inputHash,
          args.hostFingerprint,
          args.reason,
          new Date().toISOString(),
        );
      return true;
    } catch (err) {
      this.logger?.warn('[BootstrapSuppressionStore] suppress failed (fail-soft)', {
        projectId: args.projectId,
        modality: args.modality,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /**
   * Drop a suppression outright. Used when a bootstrap SUCCEEDS on a project that
   * had one — the record's whole claim has just been falsified, and leaving it to
   * expire by hash drift would be leaving a false statement in the table.
   */
  clear(projectId: number, modality: VerificationModality): void {
    try {
      this.db
        .prepare('DELETE FROM verify_runbook_bootstrap_suppression WHERE project_id = ? AND modality = ?')
        .run(projectId, modality);
    } catch (err) {
      this.logger?.debug('[BootstrapSuppressionStore] clear failed (fail-soft)', {
        projectId,
        modality,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
