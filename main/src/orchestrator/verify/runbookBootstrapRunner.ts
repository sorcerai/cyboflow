/**
 * runRunbookBootstrap — the controller-side sequence that turns "this lane's
 * verification would be skipped for want of a runbook" into a PROVEN runbook, or
 * into an honest refusal (docs/proposals/lane-runbook-bootstrap.md §12).
 *
 * THE SHAPE, AND WHY IT IS THIS SHAPE:
 *
 *   claim → draft → validate → apply rung-1 → commit → register → PROVE → re-enqueue
 *
 * Only two of those steps involve an agent's judgment, and NEITHER of them
 * writes anything. The drafting agent proposes a data structure (§8); the
 * verification agent runs a proof it cannot promote (§5.3 — `markProven` lives on
 * the engine's own terminal path and no agent can reach it). Every mutation in
 * between is performed by this function against a validated value. That is the
 * §1 bar restated as control flow: this feature may convert `skipped` into
 * `actually ran`, and has no path by which it can manufacture a PASS. The one
 * exception is the rung-1 config edit, which §15A keeps as a REVIEW-BACKED
 * rather than structural guarantee — see `rung1Operations.ts`.
 *
 * WHY THE PROOF IS ATTESTATION-ONLY. v1 fired the LANE's task as the proof and
 * then a probe to disambiguate failures. Both reviews independently destroyed
 * that: the probe builds and serves the same lane snapshot, so a lane edit that
 * breaks compilation, startup or routing breaks the probe too, and the table
 * inferred causality it could not observe — in both directions. v2 asks exactly
 * one question, `behaviors: []`: does this project stand up and identify itself
 * as this deliverable? That is the minimal claim a runbook needs and the ONLY
 * claim this proof is allowed to make. The lane's own task is enqueued afterward
 * as an ordinary request, so no failure is ever attributed to the wrong thing and
 * the lane's attempt budget is never charged for a runbook defect.
 *
 * EVERY EXIT IS SAFE. There is no path out of here that leaves a promoted record
 * this run did not prove, and no path that throws — the enqueue seam's contract
 * is never-throws, and a bootstrap that fails costs exactly today's behavior plus
 * what §10 states plainly (up to two commits, budget, and the owning lane's
 * wall clock).
 *
 * RESUMABLE, because the controller restarts lanes at inner step zero. The stamp
 * is the cursor: a returning owner reads which step completed and continues from
 * the first incomplete one instead of re-running the agent and racing rows that
 * already exist (§9).
 *
 * IO-FREE — every effect is an injected closure, so the whole sequence is
 * testable without a worktree, a git binary, an SDK, or a scheduler.
 */
import {
  VERIFY_RUNBOOK_RELATIVE_PATH,
  isVerifyRunbookModality,
  type VerifyRunbookModality,
  type VerifyRunbookV1,
} from '../../../../shared/types/verifyRunbook';
import type { VerificationModality, VerificationTaskV1 } from '../../../../shared/types/visualVerification';
import type { LoggerLike } from '../types';
import type { BootstrapStamp, RunbookBootstrapStampStore } from './bootstrapStampStore';
import type { BootstrapSuppressionStore } from './bootstrapSuppressionStore';
import { parseRunbookDraftResult, type Rung1Operation } from './runbookDraft';
import { applyRung1Operation, describeRung1Operation, validateRung1Target } from './rung1Operations';
import { validateDraftedRunbook } from './runbookDraftValidation';
import { renderBootstrapArtifact, renderRung1Finding } from './bootstrapArtifact';

/**
 * The §12 step-7 draft-round cap. Two, not more: a second round re-drafts with
 * the first proof's failure feedback, which is where nearly all of the value is
 * (a wrong port lever, a missing ready check). A third would spend another agent
 * deployment and another verification budget charge on a project that has now
 * failed to stand up twice, while the owning lane waits — and the honest outcome
 * of that is an unproven draft a human can look at, not a third guess.
 */
export const MAX_BOOTSTRAP_ROUNDS = 2;

/**
 * How long the controller waits for one proof to reach a terminal.
 *
 * A proof builds and serves a real project, so it is a MINUTES-scale operation,
 * and the owning lane is parked for it. This is deliberately below the
 * scheduler's own 20-minute ceiling: `awaitTerminal` expiring does NOT cancel
 * the request (it keeps draining and still delivers its verdict through the
 * normal path), so the cost of stopping waiting is that this run treats the
 * bootstrap as unproven — one round wasted — rather than losing anything.
 */
export const BOOTSTRAP_PROOF_AWAIT_MS = 15 * 60 * 1000;

/** Why a bootstrap did not happen. Each is a different sentence to a human. */
export type BootstrapDeclineKind =
  /** The modality has no portable-runbook representation at all ('mobile', §4 defers it). */
  | 'undeclarable-modality'
  /** A prior attempt on THESE inputs and THIS host already answered "not possible" (§10). */
  | 'suppressed'
  /** Another lane in this run holds the single-flight (§9). */
  | 'in-flight'
  /** This run already settled — proven elsewhere in the run, or already failed. */
  | 'already-settled'
  /** The stamp store could not answer (pre-106 DB, SQL error). */
  | 'unavailable'
  /** The drafting agent said the project cannot be stood up (a SUCCESS for that agent). */
  | 'not-possible'
  /** The draft failed the controller's validation (§8 checks 1–3) or a rung-1 rule (§8.1). */
  | 'rejected'
  /** A step that should have worked did not — a commit, a registration, an enqueue. */
  | 'infrastructure';

/**
 * What the bootstrap produced. The caller's job is small and identical in the
 * two non-`proven` cases: carry on to the ordinary enqueue, which the §3.2 gate
 * will skip with a reason naming this situation.
 */
export type BootstrapRunOutcome =
  | {
      kind: 'proven';
      runbookHash: string;
      runbookVersion: number;
      commitSha: string | null;
      rung1: { path: string; description: string } | null;
    }
  | { kind: 'declined'; reason: BootstrapDeclineKind; detail: string }
  | {
      kind: 'unproven';
      detail: string;
      commitSha: string | null;
      rung1: { path: string; description: string } | null;
    };

/** What the drafting agent is asked, per round. */
export interface RunbookDraftRequest {
  projectId: number;
  runId: string;
  laneTaskRef: string;
  modality: VerifyRunbookModality;
  worktreePath: string;
  /** 1-based draft round; >1 carries `feedback` from the previous proof. */
  round: number;
  /**
   * §4's `'file-only'` case: this tree already carries a parseable runbook a
   * teammate committed, which this host merely never proved. The agent is asked
   * to ADOPT it — confirm or minimally correct — rather than author a competing
   * one, because overwriting human intent with a machine-authored rival buys
   * nothing.
   */
  adopt: boolean;
  /** The committed runbook's raw JSON when adopting; null otherwise. */
  existingRunbookRaw: string | null;
  /** The previous round's proof failure, verbatim, so round 2 is informed. */
  feedback: string | null;
}

/** The terminal a proof reached, as `awaitTerminal` reports it. */
export interface BootstrapProofOutcome {
  status: string;
  errorMessage: string | null;
  failureClass: string | null;
  feedback: string | null;
}

/**
 * What consuming one proof decided: a terminal outcome, or the failure text the
 * NEXT draft round is handed.
 *
 * Modelled as a union rather than `outcome | null` so the retry feedback travels
 * with the decision that produced it. The alternative — re-reading the request
 * afterwards to reconstruct why it failed — is a second read of a row that has
 * already been read, and one more place for the two readings to disagree.
 */
type ProofConsumption = { settled: BootstrapRunOutcome } | { retryWith: string };

export interface RunbookBootstrapDeps {
  stamps: RunbookBootstrapStampStore;
  suppression: BootstrapSuppressionStore;
  /** Deploy the READ-ONLY drafting agent; returns its raw structured output. */
  draft: (request: RunbookDraftRequest) => Promise<unknown>;
  /** Read a repo-relative file from the run's worktree; null when absent/unreadable. */
  readFile: (worktreePath: string, relativePath: string) => Promise<string | null>;
  /** Write a repo-relative file into the run's worktree. */
  writeFile: (worktreePath: string, relativePath: string, content: string) => Promise<void>;
  /**
   * Stage and commit EXACTLY these paths, returning the resulting HEAD sha.
   *
   * By pathspec, never a bare `git commit` — §8's finding is that `git add -f`
   * plus a bare commit sweeps whatever sibling implement agents have staged into
   * the bootstrap commit, in a worktree five lanes are writing to concurrently.
   */
  commitPaths: (worktreePath: string, paths: string[], message: string) => Promise<string>;
  /** `VerifyRunbookStore.registerDraft` — CAS'd, returns the pin or an error. */
  registerDraft: (
    projectId: number,
    worktreePath: string,
    modality: VerificationModality,
  ) => Promise<{ hash: string; version: number } | { error: string }>;
  /** Stamp migration 105's provenance column on the record just registered. */
  setOrigin: (projectId: number, modality: VerificationModality, origin: string) => void;
  /** Enqueue the attestation-only `bootstrap_proof`, pinned to the registered revision. */
  enqueueProof: (args: {
    runId: string;
    laneTaskRef: string;
    task: VerificationTaskV1;
    round: number;
    runbookHash: string;
    runbookLocalVersion: number;
  }) => Promise<{ requestId: string } | { error: string }>;
  /** Block until the proof reaches a terminal (the scheduler's `awaitTerminal`). */
  awaitProof: (requestId: string, timeoutMs: number) => Promise<BootstrapProofOutcome>;
  /** The §5.3 project input hash + host fingerprint, for suppression keying. */
  computeInputHash: (worktreePath: string) => Promise<string | null>;
  hostFingerprint: () => Promise<string | null>;
  /**
   * Publish the `verify-runbook` artifact (§12 step 10) — what was derived, what
   * was proven, and what a human is being asked to look at.
   *
   * Optional so the sequence stays testable without an artifact router, and
   * never awaited for its effect on the outcome: a reporting failure must not
   * turn a proven runbook into an unproven one.
   */
  /**
   * Does the RECORD now resolve proven? Asked after a passing proof, because a
   * passing proof and a proven record are two different facts: the engine
   * legitimately declines to promote one that ran in the dirty-worktree
   * fallback, carried no pin, or lost its CAS. Without this the runner would
   * report "proven" and the lane's next enqueue would find a draft and skip.
   *
   * Optional: a caller that cannot answer gets the old, trusting behaviour.
   */
  confirmProven?: () => boolean | Promise<boolean>;
  reportArtifact?: (args: { projectId: number; runId: string; label: string; markdown: string }) => Promise<void>;
  /**
   * File the §8.1 review-queue finding naming an auto-edited config file. This
   * is the REVIEW-BACKED half of §15A's trade, so it is the one surface whose
   * absence would make the rung-1 concession unearned.
   */
  reportFinding?: (args: {
    projectId: number;
    runId: string;
    laneTaskRef: string;
    title: string;
    body: string;
    locations: Array<{ path: string }>;
  }) => Promise<void>;
  logger?: LoggerLike;
}

export interface RunbookBootstrapArgs {
  projectId: number;
  runId: string;
  laneTaskRef: string;
  modality: VerificationModality;
  worktreePath: string;
  /** §4's adopt-vs-author distinction, decided by the preflight. */
  adopt: boolean;
}

/** A rung-1 edit that was actually applied and committed. */
interface AppliedRung1 {
  path: string;
  description: string;
  commitSha: string | null;
}

function declined(reason: BootstrapDeclineKind, detail: string): BootstrapRunOutcome {
  return { kind: 'declined', reason, detail };
}

/**
 * The attestation-only proof task (§7).
 *
 * `behaviors: []` is legal by the task contract and is the entire point: this
 * asks whether the project stands up and identifies itself, and nothing else. It
 * carries the runbook's own build/serve verbatim, because what is being proven
 * IS those commands — the merge that an ordinary request gets from
 * `prepareVerificationEnqueue` would be a no-op here, and the caller pins the
 * revision directly rather than waiting for a proven record that by definition
 * does not exist yet.
 */
export function composeBootstrapProofTask(
  runbook: VerifyRunbookV1,
  modality: VerifyRunbookModality,
): VerificationTaskV1 | null {
  const entry = runbook.modalities[modality];
  if (entry === undefined) return null;
  return {
    version: 1,
    summary:
      `Runbook bootstrap proof (${modality}): stand this project up with its derived build/serve ` +
      'commands and confirm the surface identifies itself as this deliverable. No behaviors are checked.',
    behaviors: [],
    modality,
    attestation: entry.attestation,
    ...(entry.build !== undefined ? { build: entry.build } : {}),
    ...(entry.serve !== undefined ? { serve: entry.serve } : {}),
  };
}

/**
 * Publish the two human-facing surfaces for a terminal bootstrap (§8.1, §12
 * step 10).
 *
 * BEST-EFFORT AND NEVER LOAD-BEARING. A reporting failure must not change the
 * outcome: turning a proven runbook into an unproven one because an artifact
 * write hiccuped would be strictly worse than a missing tab. Every call is
 * caught individually so one failing surface does not take the other with it.
 *
 * The rung-1 finding is filed on BOTH terminal outcomes, including the failed
 * one — arguably especially the failed one, where the branch is carrying a
 * machine-authored config change that bought nothing and a human should be told
 * so rather than discovering it in a diff.
 */
/**
 * What the bootstrap has already DONE to the branch, carried alongside the
 * control flow so a failure path can still say it.
 *
 * WHY THIS EXISTS. The rung-1 config edit is committed at step (6), and several
 * later steps can fail — the runbook commit, the draft registration, the proof
 * enqueue — each of which returned `declined` and published nothing. That left a
 * machine-authored commit on a human's branch with no artifact and no finding
 * naming it, which is exactly the compensating control rung 1 was accepted on
 * (§15A): the edit is narrow, reviewable, separately committed, AND surfaced. An
 * edit nobody is told about satisfies three of those four.
 *
 * Mutated in place as the sequence advances, so both `refuse` and the top-level
 * catch can publish whatever was true at the moment things stopped.
 */
interface BootstrapProgress {
  modality: VerifyRunbookModality | null;
  rung1: AppliedRung1 | null;
  runbookJson: string | null;
  notes: string | null;
  commitSha: string | null;
  runbookHash: string | null;
  runbookVersion: number | null;
  rounds: number;
}

function newProgress(): BootstrapProgress {
  return {
    modality: null,
    rung1: null,
    runbookJson: null,
    notes: null,
    commitSha: null,
    runbookHash: null,
    runbookVersion: null,
    rounds: 0,
  };
}

/**
 * Publish the surfaces for a bootstrap that ENDED BADLY, when it had already
 * changed the branch. A no-op when it had not — a bootstrap that declined before
 * committing anything owes a human nothing.
 *
 * "CHANGED THE BRANCH" IS EITHER COMMIT, NOT JUST THE RUNG-1 ONE. §8.1 splits the
 * rung-1 config edit into its own commit, so a rung-0 bootstrap still leaves one
 * machine-authored commit behind: the runbook itself. Keying this on `rung1`
 * alone was the §15A mistake one level down — it surfaced the edit whose review
 * the rung is conditioned on, and silently dropped every rung-0 bootstrap that
 * committed a runbook and then failed to prove it. Observed live 2026-08-19: a
 * project whose only port literal sat under `scripts/` (denied for every
 * operation) got its runbook committed, its proof failed on the leased port, and
 * NOTHING published — the commit was mentioned only in a log line.
 */
async function publishAbandoned(
  args: RunbookBootstrapArgs,
  deps: RunbookBootstrapDeps,
  progress: BootstrapProgress,
  failureDetail: string,
): Promise<void> {
  if (progress.modality === null) return;
  if (progress.rung1 === null && progress.commitSha === null) return;
  await publishSurfaces({ ...args, modality: progress.modality }, deps, {
    proven: false,
    runbookJson: progress.runbookJson,
    notes: progress.notes,
    commitSha: progress.commitSha,
    runbookHash: progress.runbookHash,
    runbookVersion: progress.runbookVersion,
    rung1: progress.rung1,
    failureDetail,
    rounds: progress.rounds,
  });
}

async function publishSurfaces(
  args: RunbookBootstrapArgs & { modality: VerifyRunbookModality },
  deps: RunbookBootstrapDeps,
  input: {
    proven: boolean;
    runbookJson: string | null;
    notes: string | null;
    commitSha: string | null;
    runbookHash: string | null;
    runbookVersion: number | null;
    rung1: AppliedRung1 | null;
    failureDetail: string | null;
    rounds: number;
  },
): Promise<void> {
  if (deps.reportArtifact) {
    try {
      await deps.reportArtifact({
        projectId: args.projectId,
        runId: args.runId,
        label: 'Verification runbook',
        markdown: renderBootstrapArtifact({
          modality: args.modality,
          laneTaskRef: args.laneTaskRef,
          ...input,
        }),
      });
    } catch (err) {
      deps.logger?.debug('[runbookBootstrap] artifact report failed (outcome unaffected)', {
        runId: args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (input.rung1 !== null && deps.reportFinding) {
    try {
      const finding = renderRung1Finding({
        laneTaskRef: args.laneTaskRef,
        modality: args.modality,
        proven: input.proven,
        rung1: input.rung1,
      });
      await deps.reportFinding({
        projectId: args.projectId,
        runId: args.runId,
        laneTaskRef: args.laneTaskRef,
        title: finding.title,
        body: finding.body,
        locations: [{ path: input.rung1.path }],
      });
    } catch (err) {
      deps.logger?.debug('[runbookBootstrap] rung-1 finding failed (outcome unaffected)', {
        runId: args.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Run the bootstrap for one lane's about-to-be-enqueued verification.
 *
 * NEVER THROWS. The one caller is `enqueueTaskVerification`, whose contract is
 * that it cannot crash a lane; a throw escaping here would do exactly that. Every
 * step's failure is turned into a `declined`/`unproven` outcome instead, and the
 * caller's response to both is to carry on to the ordinary enqueue.
 */
export async function runRunbookBootstrap(
  args: RunbookBootstrapArgs,
  deps: RunbookBootstrapDeps,
): Promise<BootstrapRunOutcome> {
  const progress = newProgress();
  try {
    return await bootstrap(args, deps, progress);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.logger?.warn('[runbookBootstrap] threw; degrading to today\'s skip', {
      runId: args.runId,
      projectId: args.projectId,
      laneTaskRef: args.laneTaskRef,
      error: detail,
    });
    // A throw is the one exit that does not run `refuse`, so it has to do
    // refuse's two jobs itself: settle the claim (an unsettled one reads to the
    // next attempt as an owner still mid-flight) and surface a config edit that
    // is already committed. Both are best-effort — this catch exists to keep the
    // lane's degrade-to-skip contract, and nothing here may re-throw into it.
    try {
      if (progress.modality !== null) {
        deps.stamps.advance({
          runId: args.runId,
          projectId: args.projectId,
          modality: progress.modality,
          ownerTaskRef: args.laneTaskRef,
          state: 'failed',
          detail,
        });
      }
      await publishAbandoned(args, deps, progress, detail);
    } catch (publishErr) {
      deps.logger?.debug('[runbookBootstrap] could not settle surfaces after a throw', {
        runId: args.runId,
        error: publishErr instanceof Error ? publishErr.message : String(publishErr),
      });
    }
    return declined('infrastructure', detail);
  }
}

async function bootstrap(
  args: RunbookBootstrapArgs,
  deps: RunbookBootstrapDeps,
  progress: BootstrapProgress,
): Promise<BootstrapRunOutcome> {
  const { projectId, runId, laneTaskRef, worktreePath } = args;

  // (0) The modality must be one a PORTABLE runbook can express. 'mobile' is
  // deferred by §4 and has no representation at all, so there is nothing to
  // derive — deriving anyway would register a record no execution path could
  // satisfy.
  if (!isVerifyRunbookModality(args.modality)) {
    return declined(
      'undeclarable-modality',
      `a portable runbook cannot declare the "${args.modality}" modality, so there is nothing to derive`,
    );
  }
  const modality: VerifyRunbookModality = args.modality;
  progress.modality = modality;

  // (1) §10 suppression — has this exact project state, on this exact host,
  // already been answered "not possible"? Computed BEFORE the claim so a
  // suppressed project never even takes the single-flight.
  const inputHash = await deps.computeInputHash(worktreePath).catch(() => null);
  const hostFingerprint = await deps.hostFingerprint().catch(() => null);
  if (deps.suppression.isSuppressed({ projectId, modality, inputHash, hostFingerprint })) {
    const stored = deps.suppression.read(projectId, modality);
    return declined(
      'suppressed',
      stored?.reason ??
        'a previous attempt on this project state and host concluded a runbook could not be derived',
    );
  }

  // (2) The single-flight. Exactly one lane per (run, modality) derives.
  const claim = deps.stamps.claim({ runId, projectId, modality, ownerTaskRef: laneTaskRef });
  if (claim.kind === 'unavailable') {
    return declined('unavailable', 'the bootstrap stamp could not be read or written');
  }
  if (claim.kind === 'held') {
    return declined(
      'in-flight',
      `lane ${claim.stamp.ownerTaskRef} is already deriving a verification runbook for this run; ` +
        'this verification skips, and the next run verifies normally',
    );
  }
  if (claim.kind === 'settled') {
    return settledOutcome(claim.stamp);
  }

  const stamp = claim.stamp;
  // Carries a resumed in-flight proof's failure into the draft loop below, so a
  // restarted owner's round 2 is informed by round 1 exactly as an uninterrupted
  // run's would be.
  let resumeFeedback: string | null = null;
  // A RESUMED owner continues from where it got to. The proof branch is the one
  // that matters: re-firing a round that is already in flight would deploy a
  // second verification for the same round under the same enqueue key, which
  // dedups to the first — so awaiting the recorded request is both cheaper and
  // the only correct reading.
  if (claim.kind === 'resumed' && stamp.state === 'proving' && stamp.requestId !== null) {
    deps.logger?.info('[runbookBootstrap] resuming: awaiting the proof this run already fired', {
      runId,
      laneTaskRef,
      requestId: stamp.requestId,
      round: stamp.round,
    });
    const resumed = await consumeProof(
      { ...args, modality },
      deps,
      stamp.requestId,
      stamp.round,
      stamp.runbookHash,
      stamp.runbookVersion,
      stamp.commitSha,
      rung1FromStamp(stamp),
    );
    if ('settled' in resumed) {
      // This call drafted nothing — the runbook it is reporting on was written by
      // the pre-restart attempt, so it is read back off the tree rather than
      // reconstructed. An unreadable file yields an empty body rather than no
      // artifact: the outcome is still worth reporting.
      const committed = (await deps.readFile(worktreePath, VERIFY_RUNBOOK_RELATIVE_PATH)) ?? '';
      await publishSurfaces({ ...args, modality }, deps, {
        proven: resumed.settled.kind === 'proven',
        runbookJson: committed,
        notes: null,
        commitSha: stamp.commitSha,
        runbookHash: stamp.runbookHash,
        runbookVersion: stamp.runbookVersion,
        rung1: rung1FromStamp(stamp),
        failureDetail: resumed.settled.kind === 'unproven' ? resumed.settled.detail : null,
        rounds: stamp.round,
      });
      return resumed.settled;
    }
    // The proof failed and rounds remain: fall through into the draft loop,
    // which starts at the NEXT round, carrying this failure as feedback.
    resumeFeedback = resumed.retryWith;
  }

  const startRound =
    claim.kind === 'resumed' && stamp.state === 'proving' ? Math.min(stamp.round + 1, MAX_BOOTSTRAP_ROUNDS + 1) : 1;
  if (startRound > MAX_BOOTSTRAP_ROUNDS) {
    deps.stamps.advance({
      runId,
      projectId,
      modality,
      ownerTaskRef: laneTaskRef,
      state: 'failed',
      detail: 'draft rounds exhausted',
    });
    return {
      kind: 'unproven',
      detail: 'the derived runbook did not stand this project up within the allowed draft rounds',
      commitSha: stamp.commitSha,
      rung1: rung1Summary(rung1FromStamp(stamp)),
    };
  }

  let feedback: string | null = resumeFeedback ?? stamp.detail;
  let lastCommitSha: string | null = stamp.commitSha;
  let lastRung1: AppliedRung1 | null = rung1FromStamp(stamp);
  // A RESUMED claim may already have committed a rung-1 edit in the attempt that
  // died; the stamp is the only record of it, and it still needs surfacing.
  progress.rung1 = lastRung1;
  progress.commitSha = lastCommitSha;

  for (let round = startRound; round <= MAX_BOOTSTRAP_ROUNDS; round += 1) {
    progress.rounds = round;
    // (3) The read-only drafting agent.
    const existingRunbookRaw = args.adopt
      ? await deps.readFile(worktreePath, VERIFY_RUNBOOK_RELATIVE_PATH)
      : null;
    const raw = await deps.draft({
      projectId,
      runId,
      laneTaskRef,
      modality,
      worktreePath,
      round,
      adopt: args.adopt,
      existingRunbookRaw,
      feedback,
    });

    const parsed = parseRunbookDraftResult(raw);
    if (!parsed.ok) {
      // A malformed draft is an agent contract failure, and retrying costs
      // another deployment for a project whose real problem may be that it
      // cannot be described at all. Refuse, and let the human path have it.
      return await refuse(
        { ...args, modality },
        deps,
        progress,
        'rejected',
        `the drafting agent returned an unusable result: ${parsed.error}`,
        inputHash,
        hostFingerprint,
        /* suppress */ false,
      );
    }
    if (parsed.result.decision === 'not-possible') {
      // A SUCCESS for the drafting agent (§8) — and the one outcome worth
      // remembering, because re-deriving it every sprint is pure cost.
      return await refuse(
        { ...args, modality },
        deps,
        progress,
        'not-possible',
        parsed.result.reason,
        inputHash,
        hostFingerprint,
        /* suppress */ true,
      );
    }

    const draftResult = parsed.result;

    // (4) The rung-1 operation, resolved IN MEMORY first. Its post-edit content
    // is what validation reads: an agent that proposes both "add a `verify:serve`
    // script" and "serve with `pnpm verify:serve`" is self-consistent, and
    // validating against the pre-edit manifest would reject the one shape this
    // feature exists to enable.
    let rung1Pending: { path: string; content: string; operation: Rung1Operation } | null = null;
    if (draftResult.operation !== undefined) {
      const target = validateRung1Target(draftResult.operation);
      if (!target.ok) {
        return await refuse(
          { ...args, modality },
          deps,
          progress,
          'rejected',
          `the proposed config change was refused: ${target.error}`,
          inputHash,
          hostFingerprint,
          false,
        );
      }
      const current = await deps.readFile(worktreePath, target.path);
      if (current === null) {
        return await refuse(
          { ...args, modality },
          deps,
          progress,
          'rejected',
          `the proposed config change targets ${target.path}, which this worktree does not have`,
          inputHash,
          hostFingerprint,
          false,
        );
      }
      const applied = applyRung1Operation(draftResult.operation, current, target.path);
      if (!applied.ok) {
        return await refuse(
          { ...args, modality },
          deps,
          progress,
          'rejected',
          `the proposed config change was refused: ${applied.error}`,
          inputHash,
          hostFingerprint,
          false,
        );
      }
      rung1Pending = { path: target.path, content: applied.content, operation: draftResult.operation };
    }

    // (5) §8 checks 2 + 3 over the commands the runbook would actually execute.
    const manifestRaw =
      rung1Pending !== null && rung1Pending.path === 'package.json'
        ? rung1Pending.content
        : await deps.readFile(worktreePath, 'package.json');
    const validation = validateDraftedRunbook({
      runbook: draftResult.runbook,
      modality,
      packageJsonRaw: manifestRaw,
    });
    if (!validation.ok) {
      return await refuse(
        { ...args, modality },
        deps,
        progress,
        'rejected',
        validation.rejection.message,
        inputHash,
        hostFingerprint,
        // An undeclared command is about THIS draft, not about the project —
        // a different round could propose a declared one. A dependency-mutating
        // command likewise. Neither is the structural "cannot be stood up"
        // claim a suppression makes, so neither writes one.
        false,
      );
    }

    // (6) Apply the rung-1 edit and commit it ON ITS OWN (§8.1), so the human
    // reviewing this branch sees one self-contained, revertible commit rather
    // than a config change buried alongside a JSON blob.
    if (rung1Pending !== null) {
      await deps.writeFile(worktreePath, rung1Pending.path, rung1Pending.content);
      const description = describeRung1Operation(rung1Pending.operation);
      let rung1Sha: string | null = null;
      try {
        rung1Sha = await deps.commitPaths(
          worktreePath,
          [rung1Pending.path],
          `chore: ${description}\n\nApplied automatically so verification can stand this project up ` +
            `(lane ${laneTaskRef}). Review this commit: it changes project configuration.`,
        );
      } catch (err) {
        return await refuse(
          { ...args, modality },
          deps,
          progress,
          'infrastructure',
          `the config change could not be committed: ${err instanceof Error ? err.message : String(err)}`,
          inputHash,
          hostFingerprint,
          false,
        );
      }
      lastRung1 = { path: rung1Pending.path, description, commitSha: rung1Sha };
      progress.rung1 = lastRung1;
      deps.stamps.advance({
        runId,
        projectId,
        modality,
        ownerTaskRef: laneTaskRef,
        state: 'claimed',
        rung1Path: rung1Pending.path,
        ...(rung1Sha !== null ? { rung1CommitSha: rung1Sha } : {}),
      });
    }

    // (7) Write and pathspec-commit the runbook itself.
    const portableJson = `${JSON.stringify(draftResult.runbook, null, 2)}\n`;
    progress.runbookJson = portableJson;
    progress.notes = draftResult.notes ?? null;
    await deps.writeFile(worktreePath, VERIFY_RUNBOOK_RELATIVE_PATH, portableJson);
    try {
      lastCommitSha = await deps.commitPaths(
        worktreePath,
        [VERIFY_RUNBOOK_RELATIVE_PATH],
        `chore: derive a ${modality} verification runbook\n\n` +
          `Derived automatically by lane ${laneTaskRef} so this run's UI changes can be verified. ` +
          'Unproven until the bootstrap proof passes.',
      );
    } catch (err) {
      return await refuse(
        { ...args, modality },
        deps,
        progress,
        'infrastructure',
        `the derived runbook could not be committed: ${err instanceof Error ? err.message : String(err)}`,
        inputHash,
        hostFingerprint,
        false,
      );
    }
    progress.commitSha = lastCommitSha;

    // (8) Register it as a DRAFT. Not proven — nothing here can make it proven;
    // only the engine's own terminal path can (§5.3).
    const registered = await deps.registerDraft(projectId, worktreePath, modality);
    if ('error' in registered) {
      return await refuse(
        { ...args, modality },
        deps,
        progress,
        'infrastructure',
        `the derived runbook could not be registered: ${registered.error}`,
        inputHash,
        hostFingerprint,
        false,
      );
    }
    progress.runbookHash = registered.hash;
    progress.runbookVersion = registered.version;
    // Migration 105 provenance: a human deciding whether to trust this record
    // must be able to see that a lane derived it mid-sprint rather than a human
    // reviewing it at a gate. Both are proven by the same engine-enforced run;
    // they did not earn the same amount of trust.
    deps.setOrigin(projectId, modality, 'lane-bootstrap');

    deps.stamps.advance({
      runId,
      projectId,
      modality,
      ownerTaskRef: laneTaskRef,
      state: 'drafted',
      round,
      ...(lastCommitSha !== null ? { commitSha: lastCommitSha } : {}),
      runbookHash: registered.hash,
      runbookVersion: registered.version,
    });

    // (9) The attestation-only proof.
    const proofTask = composeBootstrapProofTask(draftResult.runbook, modality);
    if (proofTask === null) {
      return await refuse(
        { ...args, modality },
        deps,
        progress,
        'rejected',
        `the drafted runbook declares no "${modality}" entry to prove`,
        inputHash,
        hostFingerprint,
        false,
      );
    }
    const enqueued = await deps.enqueueProof({
      runId,
      laneTaskRef,
      task: proofTask,
      round,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });
    if ('error' in enqueued) {
      return await refuse(
        { ...args, modality },
        deps,
        progress,
        'infrastructure',
        `the bootstrap proof could not be enqueued: ${enqueued.error}`,
        inputHash,
        hostFingerprint,
        false,
      );
    }
    deps.stamps.advance({
      runId,
      projectId,
      modality,
      ownerTaskRef: laneTaskRef,
      state: 'proving',
      round,
      requestId: enqueued.requestId,
    });

    const consumed = await consumeProof(
      { ...args, modality },
      deps,
      enqueued.requestId,
      round,
      registered.hash,
      registered.version,
      lastCommitSha,
      lastRung1,
    );
    if ('settled' in consumed) {
      await publishSurfaces({ ...args, modality }, deps, {
        proven: consumed.settled.kind === 'proven',
        runbookJson: portableJson,
        notes: draftResult.notes ?? null,
        commitSha: lastCommitSha,
        runbookHash: registered.hash,
        runbookVersion: registered.version,
        rung1: lastRung1,
        failureDetail: consumed.settled.kind === 'unproven' ? consumed.settled.detail : null,
        rounds: round,
      });
      return consumed.settled;
    }

    // The proof failed and a round remains: re-draft, informed by why.
    feedback = consumed.retryWith;
  }

  deps.stamps.advance({
    runId,
    projectId,
    modality,
    ownerTaskRef: laneTaskRef,
    state: 'failed',
    detail: feedback ?? 'the derived runbook did not stand this project up',
  });
  return {
    kind: 'unproven',
    detail:
      feedback ??
      `the derived runbook did not stand this project up after ${MAX_BOOTSTRAP_ROUNDS} attempts; ` +
        'it stays committed as an unproven draft for a human to correct',
    commitSha: lastCommitSha,
    rung1: rung1Summary(lastRung1),
  };
}

/**
 * Wait for one proof and decide what it means.
 *
 * Returns a terminal outcome, or `null` meaning "it did not pass and the caller
 * may try another round". A PASS here is NOT this function promoting anything —
 * only the engine's own terminal path can, and it does so before it writes the
 * terminal status this awaits. What happens here is the stamp learning about it,
 * and — because a passing proof is still not the same fact as a proven record —
 * CONFIRMING it before the caller is told the lane can verify from here.
 */
async function consumeProof(
  args: RunbookBootstrapArgs & { modality: VerifyRunbookModality },
  deps: RunbookBootstrapDeps,
  requestId: string,
  round: number,
  runbookHash: string | null,
  runbookVersion: number | null,
  commitSha: string | null,
  rung1: AppliedRung1 | null,
): Promise<ProofConsumption> {
  const { projectId, runId, laneTaskRef, modality } = args;
  const outcome = await deps.awaitProof(requestId, BOOTSTRAP_PROOF_AWAIT_MS);

  if (outcome.status === 'passed' && runbookHash !== null && runbookVersion !== null) {
    // The engine refuses to promote a proof that ran in the dirty-worktree
    // fallback, carried no pin, or lost its CAS — all of which end as `passed`.
    // Reporting "proven" on any of those hands the lane a runbook it will then
    // fail to resolve, which reads as a mysterious skip rather than a failure.
    const confirmed = deps.confirmProven === undefined ? true : await deps.confirmProven();
    if (!confirmed) {
      const detail =
        'the bootstrap proof passed but the runbook record did not become proven ' +
        '(the engine declines to promote a proof that ran without a clean snapshot or a pin)';
      deps.stamps.advance({
        runId,
        projectId,
        modality,
        ownerTaskRef: laneTaskRef,
        state: 'failed',
        round,
        detail,
      });
      return { settled: { kind: 'unproven', detail, commitSha, rung1: rung1Summary(rung1) } };
    }
    deps.stamps.advance({
      runId,
      projectId,
      modality,
      ownerTaskRef: laneTaskRef,
      state: 'proven',
      round,
      detail: 'bootstrap proof passed',
    });
    // The suppression this project may have carried has just been falsified;
    // leaving it to expire by hash drift would leave a false statement behind.
    deps.suppression.clear(projectId, modality);
    deps.logger?.info('[runbookBootstrap] runbook proven — this run will verify normally from here', {
      runId,
      projectId,
      modality,
      laneTaskRef,
      runbookHash,
      runbookVersion,
      round,
    });
    return {
      settled: {
        kind: 'proven',
        runbookHash,
        runbookVersion,
        commitSha,
        rung1: rung1Summary(rung1),
      },
    };
  }

  deps.logger?.info('[runbookBootstrap] bootstrap proof did not pass', {
    runId,
    projectId,
    modality,
    requestId,
    round,
    status: outcome.status,
    failureClass: outcome.failureClass,
    error: outcome.errorMessage,
  });
  const detail = describeProofFailure(outcome);
  if (round >= MAX_BOOTSTRAP_ROUNDS) {
    deps.stamps.advance({
      runId,
      projectId,
      modality,
      ownerTaskRef: laneTaskRef,
      state: 'failed',
      round,
      detail,
    });
    return { settled: { kind: 'unproven', detail, commitSha, rung1: rung1Summary(rung1) } };
  }
  return { retryWith: detail };
}

function describeProofFailure(outcome: BootstrapProofOutcome): string {
  const parts = [`the bootstrap proof ended as \`${outcome.status}\``];
  if (outcome.failureClass !== null) parts.push(`(attributed to: ${outcome.failureClass})`);
  if (outcome.errorMessage !== null) parts.push(`— ${outcome.errorMessage}`);
  if (outcome.feedback !== null) parts.push(`\n\n${outcome.feedback}`);
  return parts.join(' ');
}

/**
 * A settled stamp: this run already reached a terminal for this modality.
 *
 * `proven` is reported as such — with the pin off the stamp — so a lane arriving
 * after the bootstrap finished takes the ordinary path without re-deriving
 * anything. `failed` declines, because the run has decided and re-running the
 * agent would spend a deployment to reach the same answer.
 */
function settledOutcome(stamp: BootstrapStamp): BootstrapRunOutcome {
  if (stamp.state === 'proven' && stamp.runbookHash !== null && stamp.runbookVersion !== null) {
    return {
      kind: 'proven',
      runbookHash: stamp.runbookHash,
      runbookVersion: stamp.runbookVersion,
      commitSha: stamp.commitSha,
      rung1: rung1Summary(rung1FromStamp(stamp)),
    };
  }
  return declined(
    'already-settled',
    stamp.detail ??
      'this run already attempted to derive a verification runbook for this modality and did not succeed',
  );
}

/**
 * The common refusal path: record the outcome on the stamp, optionally write the
 * §10 suppression, and return the decline.
 *
 * `suppress` is TRUE only for the structural refusal — the drafting agent's
 * `NOT-POSSIBLE`. A validation rejection is about THIS draft rather than about
 * the project, and suppressing on it would let one bad draft silence a project
 * whose next draft would have been fine.
 */
async function refuse(
  args: RunbookBootstrapArgs & { modality: VerifyRunbookModality },
  deps: RunbookBootstrapDeps,
  progress: BootstrapProgress,
  reason: BootstrapDeclineKind,
  detail: string,
  inputHash: string | null,
  hostFingerprint: string | null,
  suppress: boolean,
): Promise<BootstrapRunOutcome> {
  deps.stamps.advance({
    runId: args.runId,
    projectId: args.projectId,
    modality: args.modality,
    ownerTaskRef: args.laneTaskRef,
    state: 'failed',
    detail,
  });
  if (suppress) {
    deps.suppression.suppress({
      projectId: args.projectId,
      modality: args.modality,
      inputHash,
      hostFingerprint,
      reason: detail,
    });
  }
  deps.logger?.info(`[runbookBootstrap] declined: ${reason}`, {
    runId: args.runId,
    projectId: args.projectId,
    modality: args.modality,
    laneTaskRef: args.laneTaskRef,
    detail,
    suppressed: suppress,
  });
  // Every decline that happens AFTER the rung-1 commit still owes the branch's
  // owner an artifact and a finding naming the file — see BootstrapProgress.
  await publishAbandoned(args, deps, progress, detail);
  return declined(reason, detail);
}

function rung1FromStamp(stamp: BootstrapStamp): AppliedRung1 | null {
  if (stamp.rung1Path === null) return null;
  return {
    path: stamp.rung1Path,
    description: `a configuration change in ${stamp.rung1Path}`,
    commitSha: stamp.rung1CommitSha,
  };
}

function rung1Summary(rung1: AppliedRung1 | null): { path: string; description: string } | null {
  return rung1 === null ? null : { path: rung1.path, description: rung1.description };
}
