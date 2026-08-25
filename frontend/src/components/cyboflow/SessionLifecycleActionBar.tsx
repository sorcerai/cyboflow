import { useRef, useState } from 'react';
import { GitMerge, ExternalLink, Trash2, X } from 'lucide-react';
import { useLifecycleTarget } from '../../hooks/useLifecycleTarget';
import { useSessionStore } from '../../stores/sessionStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { anyIdeaChildSessionActive } from '../../utils/ideaSessionGrouping';
import { trpc } from '../../trpc/client';
import { useErrorStore } from '../../stores/errorStore';
import { findGuardedExperimentForSession } from '../../utils/armDismissGuard';
import type { GuardedAction } from '../../utils/armDismissGuard';
import { experimentDisplayName } from '../../utils/experimentDisplay';
import { ArmDismissGuardDialog } from './ArmDismissGuardDialog';
import type { ExperimentArm, ExperimentRow, ExperimentStatus } from '../../../../shared/types/experiments';
import type { SessionSettleState } from '../../../../shared/types/cyboflow';

interface SessionLifecycleActionBarProps {
  onMerge?: () => void;
  onCreatePR?: () => void;
  onDismiss?: () => void;
  /**
   * Close an idea HOME session (session.homeIdeaId set). Distinct from Dismiss:
   * the home session is in-place (nothing to merge, nothing lost), so the caller
   * closes it directly — no merge-warning dialog. The bar only offers Close
   * while none of the idea's launched child sessions is actively working.
   */
  onCloseSession?: () => void;
}

interface ArmGuardState {
  experimentId: string;
  arm: ExperimentArm;
  status: ExperimentStatus;
  experimentName?: string;
  /** Which lifecycle action triggered the guard — drives the dialog's copy/label. */
  action: GuardedAction;
  /** The original action's continuation, invoked once the user confirms. */
  proceed: () => void;
}

export function SessionLifecycleActionBar({ onMerge, onCreatePR, onDismiss, onCloseSession }: SessionLifecycleActionBarProps) {
  const target = useLifecycleTarget();
  // Idea-home Close gating inputs. Subscribed unconditionally (hooks-before-
  // early-return); only read on the idea-home branch below.
  const allSessions = useSessionStore((s) => s.sessions);
  const targetProjectId = target?.session.projectId;
  const runsForProject = useActiveRunsStore((s) =>
    targetProjectId !== undefined ? s.runsByProject[targetProjectId] : undefined,
  );
  // Experiment-aware dismiss guard (S2). Held here so the interception lives on
  // the Dismiss trigger itself; null = no guard shown.
  const [armGuard, setArmGuard] = useState<ArmGuardState | null>(null);
  const [checkingArm, setCheckingArm] = useState(false);
  // True while the click-time settle read (runs.sessionSettleState) is in flight.
  const [checkingSettle, setCheckingSettle] = useState(false);
  // Latest selected-session id, read INSIDE the async guard's continuation so a
  // selection change during the (async) arm-check window aborts the action
  // rather than firing it against whatever session is selected when the read
  // resolves. The close-out dialogs (SessionMergeDialog etc.) bind to the
  // CURRENT lifecycle target, so proceeding after a drift would act on the wrong
  // session — see runGuardedAction.
  const targetSessionIdRef = useRef<string | undefined>(target?.session.id);
  targetSessionIdRef.current = target?.session.id;
  if (!target) return null;

  // In-place sessions work directly in the project checkout — there is no
  // worktree to merge or open a PR from, so those accept actions are hidden.
  // Dismiss stays (it just closes the session), with copy that reflects the
  // checkout is left untouched.
  const inPlace = target.session.inPlace === true;

  const session = target.session;

  // An idea's HOME session (backlog "Open" → in-place find-or-create door) gets
  // Close instead of the whole Merge/PR/Dismiss close-out: it works in-place on
  // the project checkout, so there is nothing to merge and nothing to lose —
  // the merge-warning dismiss dialog would be pure noise (and reopening from
  // the backlog recreates the home). Close is offered ONLY while none of the
  // idea's launched child sessions is actively working; while one is, the bar
  // renders nothing (closing the home would orphan the live children's sidebar
  // grouping mid-run). No arm guard either — a home session is never an A/B arm.
  if (session.homeIdeaId) {
    const childActive = anyIdeaChildSessionActive(
      allSessions,
      runsForProject,
      session.homeIdeaId,
      session.id,
    );
    if (childActive) return null;
    return (
      <div className="flex items-center gap-1.5" data-testid="session-lifecycle-action-bar">
        <div className="mx-2 h-4 w-px bg-border-primary" />
        <button
          data-testid="session-action-close"
          onClick={() => onCloseSession?.()}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
          title="Close this idea session. Nothing is merged or discarded — reopen it any time from the backlog."
        >
          <X size={14} />
          Close
        </button>
      </div>
    );
  }

  // Intercept Dismiss/Merge/Create-PR when the session is one arm of a LIVE A/B
  // experiment. Tearing down (or accepting) a single arm strands the experiment
  // undecided — merged/dismissed arm sessions drop out of the rail group (see
  // railExperimentGrouping.ts), losing the decide CTAs (promote/rerun/switch-to
  // -randomized) reachable only from the comparison view. So we prompt instead.
  // On ANY read failure (or a session with no project) we fall through to the
  // normal action: the action must never be BLOCKED by a failed guard read.
  const runGuardedAction = (action: GuardedAction, rawProceed: () => void) => {
    const projectId = session.projectId;
    // The close-out dialog opened by rawProceed reads the CURRENT lifecycle
    // target, not this click's session. The synchronous no-guard path below
    // fires before any selection change is possible, so it uses rawProceed
    // directly. Every DEFERRED path (after the async arm-check, or after the
    // guard dialog is confirmed) instead goes through this drift guard: if the
    // selection changed while we waited, abort silently — acting would merge/PR/
    // dismiss the wrong session. The user simply re-clicks on the intended one.
    const clickedSessionId = session.id;
    const proceed = () => {
      if (targetSessionIdRef.current === clickedSessionId) rawProceed();
    };
    if (projectId === undefined) {
      rawProceed();
      return;
    }
    // Initiate the read inside a synchronous try/catch: an unavailable/unwired
    // experiments route throws right here (not as a rejection), and that must
    // fall through to the normal action SYNCHRONOUSLY, same as a rejected read.
    let queryPromise: Promise<ExperimentRow[]>;
    try {
      queryPromise = trpc.cyboflow.experiments.listForProject.query({ projectId });
    } catch {
      // Synchronous failure — same tick as the click, no drift possible; fire the
      // raw action unconditionally (the "never block on a failed read" contract).
      rawProceed();
      return;
    }
    setCheckingArm(true);
    void queryPromise
      .then(async (experiments) => {
        const match = findGuardedExperimentForSession(session.id, experiments);
        if (!match) {
          proceed();
          return;
        }
        // Best-effort enrichment: resolve the experiment's display name from the
        // dashboard summaries (arm labels live there, not on ExperimentRow). Any
        // failure just drops the name — the guard works without it.
        let experimentName: string | undefined;
        try {
          const summaries = await trpc.cyboflow.experiments.listForDashboard.query({ projectId });
          const summary = summaries.find((s) => s.experimentId === match.experiment.id);
          if (summary) {
            experimentName = experimentDisplayName(
              summary.workflowId,
              { variantId: summary.variantAId, label: summary.armALabel },
              { variantId: summary.variantBId, label: summary.armBLabel },
            );
          }
        } catch {
          // Enrichment only; ignore.
        }
        setArmGuard({
          experimentId: match.experiment.id,
          arm: match.arm,
          status: match.experiment.status,
          experimentName,
          action,
          proceed,
        });
      })
      .catch(() => {
        // Never block the action on a failed read — proceed with the normal flow.
        proceed();
      })
      .finally(() => setCheckingArm(false));
  };

  // Accept actions (Merge / Create-PR) gate on LIVE settle state at click time
  // (runs.sessionSettleState) instead of the persisted session.status. That
  // status wedges at 'running' on flow sessions with chats — the chat sentinel's
  // run-scoped turn-ends never reset it — and, symmetrically, a secondary chat
  // finishing a turn must never read as "the flow is ready to merge". The live
  // read answers the only question that matters: is anything (flow run or chat
  // turn) actively driving this worktree right now? Same fail-open contract as
  // the arm guard: a failed read must never block the action.
  const runSettleGatedAction = (action: 'merge' | 'create-pr', proceed: () => void) => {
    const clickedSessionId = session.id;
    let settlePromise: Promise<SessionSettleState>;
    try {
      settlePromise = trpc.cyboflow.runs.sessionSettleState.query({ sessionId: clickedSessionId });
    } catch {
      runGuardedAction(action, proceed);
      return;
    }
    setCheckingSettle(true);
    void settlePromise
      .then((settle) => {
        // Selection drift during the async read: abort silently (the user
        // re-clicks on the intended session) — runGuardedAction's own drift
        // guard only covers ITS deferred paths, not its synchronous one.
        if (targetSessionIdRef.current !== clickedSessionId) return;
        if (settle.flowBusy || settle.chatTurnInFlight) {
          const actionLabel = action === 'merge' ? 'Merge' : 'Create PR';
          useErrorStore.getState().showError({
            title: `${actionLabel} is waiting on live work`,
            error: settle.flowBusy
              ? 'A workflow run on this session is still executing. Let it finish (or cancel it) before accepting the work.'
              : 'A chat on this session has an agent turn in flight. Wait for the turn to finish before accepting the work.',
          });
          return;
        }
        runGuardedAction(action, proceed);
      })
      .catch(() => {
        if (targetSessionIdRef.current === clickedSessionId) runGuardedAction(action, proceed);
      })
      .finally(() => setCheckingSettle(false));
  };

  const handleMergeClick = () => runSettleGatedAction('merge', () => onMerge?.());
  const handleCreatePRClick = () => runSettleGatedAction('create-pr', () => onCreatePR?.());
  const handleDismissClick = () => runGuardedAction('dismiss', () => onDismiss?.());

  return (
    <>
    <div className="flex items-center gap-1.5" data-testid="session-lifecycle-action-bar">
      <div className="mx-2 h-4 w-px bg-border-primary" />

      {!inPlace && (
        <button
          data-testid="session-action-merge"
          disabled={checkingSettle || checkingArm}
          onClick={handleMergeClick}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title="Merge changes into base branch (checks for live work first)"
        >
          <GitMerge size={14} />
          Merge
        </button>
      )}

      {!inPlace && (
        <button
          data-testid="session-action-create-pr"
          disabled={checkingSettle || checkingArm}
          onClick={handleCreatePRClick}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          title="Create a pull request (checks for live work first)"
        >
          <ExternalLink size={14} />
          Create PR
        </button>
      )}

      <button
        data-testid="session-action-dismiss"
        onClick={handleDismissClick}
        disabled={checkingArm}
        className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-text-secondary hover:bg-bg-tertiary hover:text-status-error disabled:cursor-not-allowed disabled:opacity-50"
        title={inPlace ? 'Close this session. Your project checkout is untouched.' : 'Dismiss this session and remove its worktree'}
      >
        <Trash2 size={14} />
        Dismiss
      </button>
    </div>

    {armGuard && (
      <ArmDismissGuardDialog
        isOpen
        onClose={() => setArmGuard(null)}
        experimentId={armGuard.experimentId}
        arm={armGuard.arm}
        status={armGuard.status}
        experimentName={armGuard.experimentName}
        action={armGuard.action}
        onConfirm={() => {
          // Proceed with the original action's continuation unchanged (act on
          // THIS arm only, leaving the other arm + experiment intact).
          const proceed = armGuard.proceed;
          setArmGuard(null);
          proceed();
        }}
      />
    )}
    </>
  );
}
