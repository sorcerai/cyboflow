/**
 * VerifyRunbookStore — the MACHINE-LOCAL half of the verification runbook
 * contract (docs/proposals/verification-setup-flow.md §5.2 seam 1 + §5.3),
 * persisted on migration 096's `verify_runbook_local` table.
 *
 * WHAT THIS REPLACES. The phase-0 degrade gate already asks "does this
 * (project, modality) have a PROVEN runbook?" — and until now the answer was a
 * hard-coded `'absent'` for every project, because the concept did not exist
 * (`verificationScheduler.ts`: `deps.runbookStatus ?? (() => 'absent')`). This
 * store is the real answer. It owns the four verbs of §5's "derive → prove →
 * persist → reuse → re-derive on drift" that touch persistence:
 * {@link VerifyRunbookStore.registerDraft} (persist a derived revision),
 * {@link VerifyRunbookStore.markProven} (the engine's proof flip),
 * {@link VerifyRunbookStore.status} (reuse + drift detection — and its
 * situation-preserving sibling {@link VerifyRunbookStore.statusDetail}), and
 * {@link VerifyRunbookStore.getByHash} (the runner's pin resolution).
 *
 * THE ONE INVARIANT WORTH RE-READING: `'proven'` is not a flag someone sets, it
 * is a CONJUNCTION re-checked on every read. `status()` answers `'proven'` only
 * when ALL of the following hold — record present and marked proven, AND the
 * portable file at the probe path parses and hashes to the record's
 * `portable_hash`, AND a freshly computed project input-hash equals the stored
 * one, AND the host fingerprint equals the stored one. §5.3: "Any component
 * changing demotes." §1 is the reason: the failed `.cyboflow/verify.json` era
 * proved that a config which is merely WRITTEN is worth nothing, and a config
 * that was once proven but whose inputs have since moved is the same thing
 * wearing a green badge.
 *
 * DEMOTION IS A WRITE-THROUGH ON READ, WITH ONE DELIBERATE EXCEPTION.
 * A hash / input-hash / host-fingerprint mismatch DEMOTES the record to
 * `'unproven-draft'` right there in the read path — the drift is discovered by
 * whichever request asks next, and the record is corrected then rather than left
 * lying until someone re-runs setup. But a MISSING FILE with an existing record
 * does NOT demote: that is the ordinary pre-merge state (the setup flow commits
 * the portable half on its own branch; every OTHER branch legitimately lacks the
 * file until the merge lands). Demoting there would make a proof evaporate the
 * first time an unrelated lane asked — the read answers `'unproven-draft'` for
 * THIS probe path (correctly: this tree cannot be verified with a runbook it
 * does not contain) while leaving the record intact for the trees that do have
 * it. That asymmetry is the whole difference between "this tree lacks it" and
 * "this runbook changed".
 *
 * IO IS INJECTED, NOT IMPORTED (see {@link VerifyRunbookStoreDeps}). Reading the
 * portable file, hashing project inputs, and fingerprinting the host are all
 * environment-specific and all needed by `status()`, but importing `node:fs`
 * here would break the standalone-typecheck invariant this module shares with
 * capabilityStore.ts (narrow DatabaseLike/LoggerLike only — no electron, no
 * better-sqlite3, no fs, no services/*), and would make every store test need a
 * real filesystem to exercise a DB state machine.
 *
 * FAIL-SOFT BY DESIGN, exactly as capabilityStore.ts: every method catches its
 * own SQL/IO errors (a pre-096 DB missing the table, a locked file, a malformed
 * row, an injected dep that throws) and degrades to the SAFE answer rather than
 * throwing. For `status()` the safe answer is `'absent'` — the degrade gate then
 * skips with a setup CTA, which is a bad day, not a broken one. There is no
 * failure mode of this store that may produce a spurious `'proven'`.
 */
import type { DatabaseLike, LoggerLike } from '../types';
import type { VerificationModality } from '../../../../shared/types/visualVerification';
import {
  parseVerifyRunbookV1,
  type VerifyRunbookV1,
  type VerifyRunbookModality,
} from '../../../../shared/types/verifyRunbook';
import { runbookPortableHash } from './runbookHash';

/**
 * The persisted state of one (project, modality) runbook record — the same
 * three-valued answer the scheduler's `RunbookStatus` dependency expects
 * (§3.2). `'absent'` covers both "no record at all" and every fail-soft
 * degradation; `'unproven-draft'` is deliberately NOT a pass.
 */
export type VerifyRunbookStatus = 'proven' | 'unproven-draft' | 'absent';

/**
 * WHY the same answer is not always the same situation.
 *
 * `status()` is deliberately three-valued because that is all its one consumer
 * — the §3.2 degrade gate — can act on: proven, or not. But `'unproven-draft'`
 * is a collapse of genuinely different facts, and a caller that intends to
 * *write* rather than merely gate has to tell them apart. The motivating case
 * (lane-runbook-bootstrap.md §4): `registerDraft` UPSERTs a SINGLETON
 * `(project_id, modality)` row, so a caller that reacts to `'unproven-draft'`
 * by deriving a fresh runbook would, on a branch that merely predates the
 * runbook merge, overwrite the proven record every OTHER branch depends on —
 * breaking verification precisely for the projects that set it up properly.
 *
 * The discriminant, by situation:
 *
 *  - `'proven'` — the full conjunction holds. The only reason paired with a
 *    `'proven'` status.
 *  - `'no-record'` — nothing persisted and no usable portable file. Nothing was
 *    ever derived for this (project, modality); there is no proof to endanger.
 *  - `'file-only'` — no record, but THIS tree carries a portable file that
 *    parses and declares the modality (a teammate's committed runbook, freshly
 *    cloned). Distinct from `'no-record'` because the right response is to
 *    ADOPT and prove what is already there, not to author a competing one.
 *  - `'draft'` — a record exists and is marked `'unproven-draft'`. There is no
 *    proof to endanger, so re-deriving over it is safe.
 *  - `'proven-file-absent-here'` — a record is PROVEN and this tree simply
 *    lacks the portable file. The documented pre-merge case (see the class
 *    doc's deliberate exception): the honest answer for this probe path is
 *    `'unproven-draft'`, but the record is live and someone else's. **Never
 *    write over this one** — the resolution is to merge the branch carrying
 *    the file, not to derive a new runbook.
 *  - `'drifted'` — a proven record was just DEMOTED by this very read (hash,
 *    project-input, or host-fingerprint mismatch). The proof is already gone;
 *    the record now reads `'unproven-draft'` for everyone.
 *  - `'indeterminate'` — the store could not observe enough to answer (a
 *    pre-096 DB, a SQL error, an input hash that would not compute). Fails soft
 *    to `'absent'` like everything else here, but is NOT evidence that nothing
 *    exists, and a writing caller must treat it as "do not touch".
 *
 * Note this is a superset of the four discriminants the proposal named: two
 * situations `status()` already distinguishes internally (`'file-only'`, and
 * the two fail-soft `'absent'` paths) collapse to the wrong answer if folded
 * into the others, and the whole point of this type is not to collapse things.
 */
export type VerifyRunbookStatusReason =
  | 'proven'
  | 'no-record'
  | 'file-only'
  | 'draft'
  | 'proven-file-absent-here'
  | 'drifted'
  | 'indeterminate';

/** The three-valued gate answer plus the situation that produced it. */
export interface VerifyRunbookStatusDetail {
  status: VerifyRunbookStatus;
  reason: VerifyRunbookStatusReason;
}

/**
 * Environment-specific IO the store needs but must not import (see the class
 * doc's IO IS INJECTED note). All three are expected to be TOTAL — they report
 * failure by returning `null` / rejecting, and the store treats a rejection as
 * a fail-soft `'absent'`, never as a reason to demote a record.
 */
export interface VerifyRunbookStoreDeps {
  /**
   * Read `<dirPath>/.cyboflow/verify-runbook.json` (the portable half). Returns
   * the raw file text, or `null` when the file is ABSENT — a distinction the
   * store depends on: absent is the benign pre-merge case that must not demote,
   * while unparseable/mismatched content is real drift that must.
   */
  readPortableFile: (dirPath: string) => Promise<string | null>;
  /**
   * The §5.3 project INPUT hash for the tree at `dirPath` — dev/build scripts,
   * lockfile, electron/node versions. `null` means "could not compute", which
   * fails soft to `'absent'` WITHOUT demoting: an inability to observe the
   * inputs is not evidence that they changed.
   */
  computeInputHash: (dirPath: string) => Promise<string | null>;
  /**
   * The §5.3 host fingerprint — chromium binary, TCC grant state, node major,
   * app binary path — serialized to a comparable string. Shares the shape
   * `VerifyCapabilityStore.bumpHostGeneration(fingerprintJson)` records for
   * diagnostics; here it is compared for EQUALITY, so its serialization must be
   * stable across calls on an unchanged host.
   */
  hostFingerprint: () => Promise<string>;
  logger?: LoggerLike;
}

/** Raw `verify_runbook_local` row shape, as read back from SQLite. */
interface RunbookLocalRow {
  portable_hash: string;
  portable_json: string;
  version: number;
  status: string;
  bindings_json: string | null;
  proof_json: string | null;
  input_hash: string | null;
  host_fingerprint_json: string | null;
}

/** The subset of a row `getByHash` hands the runner for §5.2 pin execution. */
export interface PinnedRunbookRecord {
  runbook: VerifyRunbookV1;
  version: number;
  status: 'proven' | 'unproven-draft';
}

/** Narrowing helper — the CHECK constraint guarantees this, a hand-edited DB does not. */
function isPersistedStatus(value: string): value is 'proven' | 'unproven-draft' {
  return value === 'proven' || value === 'unproven-draft';
}

export class VerifyRunbookStore {
  constructor(
    private readonly db: DatabaseLike,
    private readonly deps: VerifyRunbookStoreDeps,
  ) {}

  /**
   * The §3.2/§5.3 status provider — the function the scheduler's
   * `runbookStatus` dependency is meant to become.
   *
   * `probePath` is the tree whose portable half is checked: the REQUESTING
   * RUN's worktree when it has one, else the project root — worktree-first,
   * mirroring `verifyConfigLoader`'s resolution ladder for the same reason (a
   * run's verification must be described by the tree that run is actually
   * changing, not by the project's main checkout). The caller resolves that
   * ladder; this method just probes what it is handed.
   *
   * Answers, in order:
   *   - no record AND no file            → `'absent'` (nothing was ever derived).
   *   - no record BUT a file that parses
   *     and declares this modality       → `'unproven-draft'` (derived in the
   *     repo, never proven ON THIS HOST — e.g. a teammate's committed runbook
   *     freshly cloned). Behaves exactly like `'absent'` at the gate; the
   *     distinction only sharpens the CTA.
   *   - record marked `'unproven-draft'` → `'unproven-draft'`, unconditionally
   *     (already the lowest non-absent state — nothing to re-check, nothing to
   *     demote).
   *   - record marked `'proven'`:
   *       * file absent                  → `'unproven-draft'`, NO demotion (the
   *         pre-merge case — see the class doc's deliberate exception).
   *       * file unparseable, or hashes
   *         to something else            → DEMOTE, `'unproven-draft'`.
   *       * fresh input-hash differs     → DEMOTE, `'unproven-draft'`.
   *       * host fingerprint differs     → DEMOTE, `'unproven-draft'`.
   *       * all four agree               → `'proven'`.
   *
   * A stored `input_hash` / `host_fingerprint_json` of NULL against a freshly
   * computed non-null value counts as a DIFFERENCE and demotes. That is the
   * conservative reading of "any component changing demotes": a proven record
   * whose provenance was never captured cannot be shown to still hold, and the
   * cost of being wrong here is one re-proof, versus shipping against a runbook
   * proven on inputs nobody recorded.
   */
  async status(
    projectId: number,
    probePath: string,
    modality: VerificationModality,
  ): Promise<VerifyRunbookStatus> {
    return (await this.statusDetail(projectId, probePath, modality)).status;
  }

  /**
   * {@link VerifyRunbookStore.status}, plus WHICH of the situations behind the
   * answer produced it — see {@link VerifyRunbookStatusReason} for the full
   * enumeration and why the collapse is unsafe for a caller that writes.
   *
   * This is the real implementation; `status()` is a projection of it, so the
   * gate's answer and a writing caller's answer can never be computed by two
   * code paths that drift. It has the same side effect the three-valued version
   * always had — a drift check that fails DEMOTES the record write-through — so
   * asking for the detail is not a cheaper or more passive read.
   */
  async statusDetail(
    projectId: number,
    probePath: string,
    modality: VerificationModality,
  ): Promise<VerifyRunbookStatusDetail> {
    try {
      const row = this.readRow(projectId, modality);

      const rawFile = await this.deps.readPortableFile(probePath);
      const parsedFile = rawFile === null ? null : this.parsePortable(rawFile, probePath);

      if (!row) {
        // Nothing persisted. A parseable file that declares this modality is a
        // derived-but-never-proven runbook; anything else is genuinely absent.
        if (parsedFile && this.declaresModality(parsedFile, modality)) {
          return { status: 'unproven-draft', reason: 'file-only' };
        }
        return { status: 'absent', reason: 'no-record' };
      }

      if (row.status !== 'proven') return { status: 'unproven-draft', reason: 'draft' };

      // The pre-merge case: this tree simply does not carry the file. Report
      // honestly for THIS probe path without touching the record.
      if (rawFile === null) {
        return { status: 'unproven-draft', reason: 'proven-file-absent-here' };
      }

      if (!parsedFile) {
        return this.demoted(projectId, modality, 'portable file no longer parses');
      }
      const freshHash = runbookPortableHash(parsedFile);
      if (freshHash !== row.portable_hash) {
        return this.demoted(projectId, modality, 'portable runbook hash drift');
      }

      const freshInputHash = await this.deps.computeInputHash(probePath);
      if (freshInputHash === null) {
        // Could not observe the inputs — not evidence that they changed.
        this.deps.logger?.warn('[VerifyRunbookStore] input hash unavailable (fail-soft)', {
          projectId,
          modality,
          probePath,
        });
        return { status: 'absent', reason: 'indeterminate' };
      }
      if (freshInputHash !== row.input_hash) {
        return this.demoted(projectId, modality, 'project input hash drift');
      }

      const freshFingerprint = await this.deps.hostFingerprint();
      if (freshFingerprint !== row.host_fingerprint_json) {
        return this.demoted(projectId, modality, 'host fingerprint drift');
      }

      return { status: 'proven', reason: 'proven' };
    } catch (err) {
      this.deps.logger?.warn('[VerifyRunbookStore] status failed (fail-soft)', {
        projectId,
        modality,
        probePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return { status: 'absent', reason: 'indeterminate' };
    }
  }

  /**
   * Persist a DERIVED revision (§5's "derive → … → persist"): read the portable
   * half from `worktreePath`, validate it, hash it, and UPSERT the (project,
   * modality) record as `'unproven-draft'` at `version + 1`, stamping the
   * caller's `bindingsJson` plus a fresh input-hash and host fingerprint as the
   * baseline the drift checks will later compare against.
   *
   * ALWAYS `'unproven-draft'`, even when re-registering over a proven record:
   * new portable content is by definition unproven content. The version bump is
   * what makes a mid-flight pin (§5.2 seam 3) fail its CAS check rather than
   * silently execute against a revision that was swapped underneath it — and
   * the CAS predicate on the UPDATE means two concurrent registrations cannot
   * both believe they won.
   *
   * Errors are RETURNED, not thrown — the setup flow surfaces them to the human
   * inline (a missing/malformed runbook is a normal wizard state, not a crash).
   */
  async registerDraft(
    projectId: number,
    worktreePath: string,
    modality: VerificationModality,
    bindingsJson?: string,
  ): Promise<{ hash: string; version: number } | { error: string }> {
    try {
      const raw = await this.deps.readPortableFile(worktreePath);
      if (raw === null) {
        return { error: `no portable runbook found under ${worktreePath}` };
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (err) {
        return { error: `portable runbook is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
      }
      const parsed = parseVerifyRunbookV1(decoded);
      if (!parsed.ok) return { error: `portable runbook is invalid — ${parsed.error}` };

      // Registering a modality the runbook never declared would persist a
      // record no execution path could ever satisfy (and, for 'mobile', one the
      // portable contract cannot even express — §4 defers it).
      if (!this.declaresModality(parsed.runbook, modality)) {
        return { error: `portable runbook declares no "${modality}" modality` };
      }

      const hash = runbookPortableHash(parsed.runbook);
      const portableJson = JSON.stringify(parsed.runbook);
      const inputHash = await this.deps.computeInputHash(worktreePath);
      const fingerprint = await this.deps.hostFingerprint();
      const now = new Date().toISOString();

      const txn = this.db.transaction(() => {
        const current = this.readRow(projectId, modality);
        const currentVersion = current?.version ?? 0;
        const nextVersion = currentVersion + 1;

        const result = this.db
          .prepare(
            `INSERT INTO verify_runbook_local
               (project_id, modality, portable_hash, portable_json, version, status,
                bindings_json, proof_json, input_hash, host_fingerprint_json, updated_at)
             VALUES (?, ?, ?, ?, ?, 'unproven-draft', ?, NULL, ?, ?, ?)
             ON CONFLICT(project_id, modality) DO UPDATE SET
               portable_hash = excluded.portable_hash,
               portable_json = excluded.portable_json,
               version = excluded.version,
               status = 'unproven-draft',
               bindings_json = excluded.bindings_json,
               proof_json = NULL,
               input_hash = excluded.input_hash,
               host_fingerprint_json = excluded.host_fingerprint_json,
               updated_at = excluded.updated_at
             WHERE verify_runbook_local.version = ?`,
          )
          .run(
            projectId,
            modality,
            hash,
            portableJson,
            nextVersion,
            bindingsJson ?? null,
            inputHash,
            fingerprint,
            now,
            currentVersion,
          );
        return result.changes > 0 ? nextVersion : null;
      });
      const version = (txn as () => number | null)();
      if (version === null) {
        return { error: 'cas-conflict' };
      }
      return { hash, version };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn('[VerifyRunbookStore] registerDraft failed (fail-soft)', {
        projectId,
        modality,
        worktreePath,
        error: message,
      });
      return { error: message };
    }
  }

  /**
   * The ENGINE-DRIVEN proof flip (§5.3) — the only transition into `'proven'`,
   * and deliberately not something the setup agent can perform by asserting it.
   * The caller reaches here having actually stood the deliverable up and
   * captured it through the real verification path, in the VERIFIER's
   * environment class (detached snapshot + prepared deps — "a proof obtained in
   * environment X asserted about environment Y is not a proof"), and passes the
   * assembled provenance as `proofJson`.
   *
   * Double CAS: the UPDATE matches on BOTH `portable_hash` and `version`, so a
   * proof can only land on the exact record revision the proof run executed. A
   * concurrent `registerDraft` between the run and this call bumps the version
   * and the flip is rejected — the proof attests to content that is no longer
   * what the record holds.
   *
   * Synchronous (no injected IO on this path), and the one method whose failure
   * is REPORTED rather than swallowed: silently declining to record a proof
   * would strand the wizard in a loop that can never exit.
   */
  markProven(
    projectId: number,
    modality: VerificationModality,
    hash: string,
    expectedVersion: number,
    proofJson: string,
  ): { ok: true } | { ok: false; error: 'cas-conflict' | 'hash-mismatch' | 'not-found' | string } {
    try {
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          `UPDATE verify_runbook_local
           SET status = 'proven', proof_json = ?, updated_at = ?
           WHERE project_id = ? AND modality = ? AND portable_hash = ? AND version = ?`,
        )
        .run(proofJson, now, projectId, modality, hash, expectedVersion);
      if (result.changes > 0) return { ok: true };

      // Nothing matched — say WHICH predicate failed, so the caller can decide
      // between re-registering (content moved) and re-proving (version moved).
      const row = this.readRow(projectId, modality);
      if (!row) return { ok: false, error: 'not-found' };
      if (row.portable_hash !== hash) return { ok: false, error: 'hash-mismatch' };
      return { ok: false, error: 'cas-conflict' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn('[VerifyRunbookStore] markProven failed (fail-soft)', {
        projectId,
        modality,
        hash,
        error: message,
      });
      return { ok: false, error: message };
    }
  }

  /**
   * Stamp migration 105's `origin` on a record — WHO derived it.
   *
   * WHY THIS IS NOT COSMETIC. Two things can produce a proven runbook: the
   * Verify Setup flow, where a human sees the proposal and every repo change it
   * wants before anything is touched, and the lane bootstrap
   * (docs/proposals/lane-runbook-bootstrap.md), where an agent derives one
   * mid-sprint and the engine proves it with nobody watching. Both are proven by
   * the same engine-enforced run and they did NOT earn the same amount of trust.
   * Collapsing them would erase the only durable record of which happened, and a
   * human deciding whether to keep a machine-authored runbook has no other way to
   * find out.
   *
   * Deliberately NOT a parameter of {@link VerifyRunbookStore.registerDraft}:
   * that method's UPSERT is the CAS'd content write and adding a column to it
   * would mean a pre-105 DB losing the REGISTRATION rather than just the
   * provenance. Here, a pre-105 DB fails soft and loses only the badge.
   *
   * Never throws — a provenance stamp that failed must not undo a registration
   * that succeeded.
   */
  setOrigin(projectId: number, modality: VerificationModality, origin: string): void {
    try {
      this.db
        .prepare('UPDATE verify_runbook_local SET origin = ? WHERE project_id = ? AND modality = ?')
        .run(origin, projectId, modality);
    } catch (err) {
      this.deps.logger?.debug('[VerifyRunbookStore] origin stamp failed (fail-soft)', {
        projectId,
        modality,
        origin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Content-addressed fetch for the runner's §5.2 seam-3 pin validation: given
   * the `runbook_hash` + `runbook_local_version` stamped on the request row at
   * enqueue, resolve the EXACT revision to execute.
   *
   * This is why `portable_json` is stored verbatim rather than just its hash —
   * the snapshot the runner executes in may predate the runbook file entirely,
   * so the content has to come from here. A miss (`null`) is not a lookup
   * failure to retry; it is the mismatch condition itself, and the runner's
   * response is a structured "runbook/sha mismatch" rejection (env-class,
   * non-attempt-charging), never an improvisation against live state.
   *
   * Returns the record's CURRENT `version`/`status`; the runner compares them
   * against its pin rather than this method pre-judging (a record that drifted
   * to `'unproven-draft'` between enqueue and execution is exactly the case the
   * pin exists to catch, and the runner needs to see it to report it).
   */
  getByHash(
    projectId: number,
    modality: VerificationModality,
    hash: string,
  ): PinnedRunbookRecord | null {
    try {
      const row = this.db
        .prepare(
          `SELECT portable_hash, portable_json, version, status, bindings_json, proof_json,
                  input_hash, host_fingerprint_json
           FROM verify_runbook_local
           WHERE project_id = ? AND modality = ? AND portable_hash = ?`,
        )
        .get(projectId, modality, hash) as RunbookLocalRow | undefined;
      if (!row) return null;
      if (!isPersistedStatus(row.status)) return null;

      const parsed = this.parsePortable(row.portable_json, `db:${projectId}/${modality}`);
      if (!parsed) return null;
      return { runbook: parsed, version: row.version, status: row.status };
    } catch (err) {
      this.deps.logger?.warn('[VerifyRunbookStore] getByHash failed (fail-soft)', {
        projectId,
        modality,
        hash,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * The (project, modality) record as it stands RIGHT NOW, hash included — the
   * enqueue-side companion to {@link VerifyRunbookStore.getByHash}.
   *
   * §5.2 seam 3 is content-addressed in BOTH directions and the two directions
   * need different lookups. At EXECUTION the runner already holds a hash and
   * asks "resolve exactly this revision" (`getByHash`). At ENQUEUE nobody holds
   * a hash yet: the seam has just been told by {@link VerifyRunbookStore.status}
   * that this (project, modality) is `'proven'`, and it needs the revision that
   * verdict was about — its content to merge into the composed task, and its
   * hash + version to STAMP on the request row as the pin. Re-deriving the hash
   * by re-reading and re-hashing the probe path's file would be a second,
   * separately-racing answer; reading it off the record is the same answer
   * `status()` just validated the file against.
   *
   * Returns `null` for no record, an unrecognized `status`, or unparseable
   * stored content — the same fail-soft posture as `getByHash`, and with the
   * same consequence at the call site: no pin, no injection, and the §3.2
   * degrade gate handles it honestly rather than a half-applied runbook
   * executing.
   */
  getCurrent(
    projectId: number,
    modality: VerificationModality,
  ): (PinnedRunbookRecord & { hash: string }) | null {
    try {
      const row = this.readRow(projectId, modality);
      if (!row) return null;
      if (!isPersistedStatus(row.status)) return null;
      const parsed = this.parsePortable(row.portable_json, `db:${projectId}/${modality}`);
      if (!parsed) return null;
      return { runbook: parsed, version: row.version, status: row.status, hash: row.portable_hash };
    } catch (err) {
      this.deps.logger?.warn('[VerifyRunbookStore] getCurrent failed (fail-soft)', {
        projectId,
        modality,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Read the (project, modality) record, or `undefined` when absent. NOT
   * fail-soft on its own — callers wrap it, so a genuine SQL error (a pre-096
   * DB) surfaces to the caller's single catch and its single degraded answer,
   * rather than being confused with "no such record".
   */
  private readRow(projectId: number, modality: VerificationModality): RunbookLocalRow | undefined {
    return this.db
      .prepare(
        `SELECT portable_hash, portable_json, version, status, bindings_json, proof_json,
                input_hash, host_fingerprint_json
         FROM verify_runbook_local
         WHERE project_id = ? AND modality = ?`,
      )
      .get(projectId, modality) as RunbookLocalRow | undefined;
  }

  /** Parse + validate portable-half text; `null` (with a warn) on malformed content. */
  private parsePortable(raw: string, source: string): VerifyRunbookV1 | null {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (err) {
      this.deps.logger?.warn('[VerifyRunbookStore] portable runbook is not valid JSON', {
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    const parsed = parseVerifyRunbookV1(decoded);
    if (!parsed.ok) {
      this.deps.logger?.warn('[VerifyRunbookStore] portable runbook failed validation', {
        source,
        error: parsed.error,
      });
      return null;
    }
    return parsed.runbook;
  }

  /**
   * Whether the parsed portable half declares an entry for this modality. The
   * cast is safe by construction: `parseVerifyRunbookV1` only ever populates
   * keys from {@link VERIFY_RUNBOOK_MODALITIES}, so a `VerificationModality`
   * outside that subset (`'mobile'`, §4-deferred) simply misses.
   */
  private declaresModality(runbook: VerifyRunbookV1, modality: VerificationModality): boolean {
    return runbook.modalities[modality as VerifyRunbookModality] !== undefined;
  }

  /**
   * Write-through demotion (§5.3 "Any component changing demotes"): flip a
   * proven record to `'unproven-draft'` and clear its proof, so the next reader
   * — and the phase-3 health panel — sees the honest state without waiting for
   * someone to re-run setup.
   *
   * Deliberately does NOT bump `version`. The version is the CONTENT CAS token
   * (owned by `registerDraft`); bumping it here would make a pin taken against
   * this record unresolvable, when what the runner actually needs is to resolve
   * it and discover the status is no longer `'proven'`. Also does not clear
   * `input_hash`/`host_fingerprint_json` — they stay as the record of what the
   * proof WAS taken against, which is what makes a subsequent re-proof
   * diagnosable.
   *
   * Fail-soft: a failed demotion still returns `'unproven-draft'`/`'drifted'`
   * to the caller. The read answer is correct either way; only the persisted
   * correction is lost, and the next read re-detects the same drift.
   */
  private demoted(
    projectId: number,
    modality: VerificationModality,
    reason: string,
  ): VerifyRunbookStatusDetail {
    try {
      this.db
        .prepare(
          `UPDATE verify_runbook_local
           SET status = 'unproven-draft', proof_json = NULL, updated_at = ?
           WHERE project_id = ? AND modality = ? AND status = 'proven'`,
        )
        .run(new Date().toISOString(), projectId, modality);
      this.deps.logger?.warn('[VerifyRunbookStore] demoted proven runbook to unproven-draft', {
        projectId,
        modality,
        reason,
      });
    } catch (err) {
      this.deps.logger?.warn('[VerifyRunbookStore] demotion write failed (fail-soft)', {
        projectId,
        modality,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { status: 'unproven-draft', reason: 'drifted' };
  }
}
