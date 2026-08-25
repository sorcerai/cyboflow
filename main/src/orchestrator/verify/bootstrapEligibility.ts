/**
 * The ONE decision behind "should this project's runbook be bootstrapped for
 * this request?" — and the ONE definition of "this task derives an environment"
 * that both the §3.2 degrade gate and the bootstrap preflight must agree on
 * (docs/proposals/lane-runbook-bootstrap.md §4, §12 step 1, §13 phase 2).
 *
 * WHY THIS IS A MODULE AND NOT TWO INLINE `if`s. There are two seams that ask
 * overlapping questions about the same request, at different moments:
 *
 *   - the PREFLIGHT, in `enqueueTaskVerification`, BEFORE a row exists: "is this
 *     a request that would be skipped for want of a runbook, on a project where
 *     deriving one is safe?";
 *   - the GATE, in `evaluateAgentGates`, AFTER the row is leased: "should this
 *     request run, and if not, what do I tell the human?".
 *
 * If they compute `derivesEnvironment` differently by even one clause, the
 * feature silently misfires in both directions: a preflight that is stricter
 * than the gate bootstraps nothing while the gate keeps skipping, and a
 * preflight that is looser spends an agent and a deployment on requests the gate
 * would have let through anyway. The same is true of the runbook-status reading:
 * two seams that disagree about which situations are safe to write over is
 * precisely how `registerDraft`'s singleton row gets clobbered (§4).
 *
 * NOTHING HERE TOUCHES IO OR STATE. Every export is a pure function of values
 * the callers already hold, which is what lets the gate call it while holding a
 * lease and the preflight call it before anything exists.
 */
import type { VerificationTaskV1 } from '../../../../shared/types/visualVerification';
import type { VerifyRunbookStatusDetail, VerifyRunbookStatusReason } from './runbookStore';

/**
 * Does this task need an ENVIRONMENT derived for it — something built, or
 * something served — as opposed to a degenerate task that merely points a driver
 * at an already-live URL?
 *
 * This is the §3.2 predicate verbatim, extracted so the gate and the preflight
 * cannot drift. The asymmetry between the two clauses is deliberate and load
 * bearing: `build` must be a NON-EMPTY array (a composed `build: []` derives
 * nothing and must not gate), while `serve` counts by mere PRESENCE (there is no
 * empty serve — the object itself is the command).
 */
export function taskDerivesEnvironment(task: Pick<VerificationTaskV1, 'build' | 'serve'>): boolean {
  return (Array.isArray(task.build) && task.build.length > 0) || task.serve !== undefined;
}

/**
 * Why a bootstrap declined. Each maps to a DIFFERENT remedy, which is the whole
 * reason this is not a boolean — a human told "run verification setup" when the
 * real fix is "merge the branch carrying the runbook" will do the wrong thing
 * and conclude the feature is broken.
 */
export type BootstrapDeclineReason =
  /** The toggle is off, or the kill switch is set. Nothing to explain. */
  | 'disabled'
  /** A degenerate task: it derives no environment, so the gate lets it through. */
  | 'no-environment'
  /** Already proven for the probed tree. The ordinary path applies. */
  | 'already-proven'
  /**
   * A record is PROVEN and this tree simply lacks the portable file — §4's
   * pre-merge case. Deriving here would UPSERT over the singleton record every
   * other branch depends on, so the answer is never "bootstrap", it is "merge".
   */
  | 'proof-belongs-elsewhere'
  /**
   * A proven record just drifted (inputs, host, or content moved). Its runbook
   * is presumably still correct and human-authored; what it needs is to be
   * re-PROVEN, not re-DERIVED, and re-deriving would throw away a working one.
   */
  | 'stale-proof'
  /** The store could not observe enough to answer. Never write on a guess. */
  | 'unobservable';

/**
 * `proceed: true` means the preflight may derive a runbook for this request.
 * `adopt` distinguishes the two ways that happens: `false` = author one from
 * scratch, `true` = this tree already CARRIES a parseable runbook (a teammate
 * committed it; this host merely never proved it), so the honest action is to
 * prove what is there rather than overwrite it with a machine-authored rival.
 */
export type BootstrapDecision =
  | { proceed: true; adopt: boolean }
  | { proceed: false; reason: BootstrapDeclineReason };

/**
 * The situations in which deriving a runbook is safe.
 *
 * Stated as an explicit allow-list rather than "not proven", because the unsafe
 * cases are the ones that ANSWER `'unproven-draft'` too (§4): the collapse is
 * exactly what makes a naive `status() !== 'proven'` test wrong. A reason added
 * to {@link VerifyRunbookStatusReason} later therefore defaults to NOT
 * bootstrapping, which is the correct direction to fail.
 */
const BOOTSTRAPPABLE: ReadonlySet<VerifyRunbookStatusReason> = new Set([
  'no-record',
  'file-only',
  'draft',
]);

/**
 * The runbook-state half of the decision, on its own: why deriving is refused
 * for this status, or `null` when it is allowed.
 *
 * Split out from {@link decideRunbookBootstrap} because the GATE needs exactly
 * this and nothing else. The gate has no opinion on the bootstrap toggle and
 * has already established that the task derives an environment; what it wants is
 * the SITUATION, so the reason it writes onto the skipped row names the same
 * fact the preflight would have declined for. Two seams, one classification.
 */
export function declineForRunbookStatus(
  status: VerifyRunbookStatusDetail,
): BootstrapDeclineReason | null {
  const { reason } = status;
  if (reason === 'proven') return 'already-proven';
  if (reason === 'proven-file-absent-here') return 'proof-belongs-elsewhere';
  if (reason === 'drifted') return 'stale-proof';
  if (!BOOTSTRAPPABLE.has(reason)) return 'unobservable';
  return null;
}

/**
 * Should the bootstrap fire for this request?
 *
 * Order matters for the QUALITY of the answer, not its correctness: `disabled`
 * and `no-environment` are checked first so a project with the feature off, or a
 * request that never needed a runbook at all, is never described in terms of its
 * runbook state — logging "no proven runbook" for a degenerate target-only task
 * would be true and completely misleading.
 */
export function decideRunbookBootstrap(args: {
  /** The resolved toggle AND kill switch, already combined by the caller. */
  enabled: boolean;
  derivesEnvironment: boolean;
  status: VerifyRunbookStatusDetail;
}): BootstrapDecision {
  if (!args.enabled) return { proceed: false, reason: 'disabled' };
  if (!args.derivesEnvironment) return { proceed: false, reason: 'no-environment' };

  const decline = declineForRunbookStatus(args.status);
  if (decline !== null) return { proceed: false, reason: decline };
  return { proceed: true, adopt: args.status.reason === 'file-only' };
}

/**
 * The human-facing remedy for a runbook-shaped skip.
 *
 * Lives here rather than in verdictDelivery because the sentence and the
 * decision are the same fact: whatever `decideRunbookBootstrap` declined for is
 * what the human has to fix, and separating them is how the finding ends up
 * confidently recommending the wrong action. Returns `null` for the reasons a
 * human cannot act on — a disabled toggle and a degenerate task are not
 * problems, and `already-proven` never reaches a skip at all.
 */
export function bootstrapRemedyText(reason: BootstrapDeclineReason): string | null {
  switch (reason) {
    case 'proof-belongs-elsewhere':
      return (
        'This project HAS a proven verification runbook — this branch just does not carry ' +
        '`.cyboflow/verify-runbook.json` yet. Merge (or rebase onto) the branch that added it and ' +
        'verification will run here without any further setup. Do NOT re-run verification setup: ' +
        'the record is shared across branches, and re-deriving would overwrite the proven one.'
      );
    case 'stale-proof':
      return (
        "This project's verification runbook was proven, but something it depended on has since " +
        'moved — its own content, the package scripts/lockfile it builds through, or this host. ' +
        'The runbook itself is probably still right; it needs to be re-proven. Re-run verification ' +
        'setup to prove the current revision.'
      );
    case 'unobservable':
      return (
        'The verification runbook record could not be read for this project, so verification ' +
        'declined to guess rather than run against an unknown environment. Check the app log for a ' +
        'VerifyRunbookStore warning.'
      );
    case 'disabled':
    case 'no-environment':
    case 'already-proven':
      return null;
  }
}
