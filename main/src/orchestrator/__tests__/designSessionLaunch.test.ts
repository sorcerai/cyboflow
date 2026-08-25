/**
 * Unit tests for launchDesignSessionForFork (designSessionLaunch.ts) — the
 * design-mode-fork launch saga QuestionRouter.respond() delegates to when a
 * human answers the planner's `approve-idea` gate with "Approve → design
 * mode". Pure fake-deps tests, no DB / Electron involved — mirrors
 * proposalExecutor.test.ts's idiom for its launch-run saga.
 *
 * Covers:
 *  - a successful launch creates the design-linked session (createDesignSession
 *    + kickoffDesignPanel both called, in order; no compensation, no failure
 *    report).
 *  - a stale/invalid idea link is rejected cleanly (validateIdeaLink fails):
 *    createDesignSession is NEVER called, the failure is reported, no session
 *    is created.
 *  - a failure AFTER the session is minted (kickoffDesignPanel throws)
 *    compensates via dismissSession rather than orphaning the session, and
 *    still reports the failure.
 *  - a failure BEFORE any session is minted (createDesignSession itself
 *    throws) reports the failure WITHOUT calling dismissSession (there is no
 *    session id to compensate) — mirrors the accepted risk documented in
 *    ipc/session.ts's own defensive branch.
 *
 * Plus a second describe block for finishDesignSessionCreate — the
 * post-mint tail extracted from index.ts's `createDesignSession` dep (the
 * belt-guard + `design_idea_id` stamp that run AFTER createQuickSessionCore
 * has already minted a real session/run/worktree) — proving its internal
 * mid-create compensation (the ROB-2 fix: a throw in this window used to
 * orphan the session because the saga above never captured a sessionId to
 * dismiss).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  launchDesignSessionForFork,
  finishDesignSessionCreate,
  type DesignSessionLaunchDeps,
} from '../designSessionLaunch';

function makeDeps(overrides: Partial<DesignSessionLaunchDeps> = {}): {
  deps: DesignSessionLaunchDeps;
  validateIdeaLink: ReturnType<typeof vi.fn>;
  createDesignSession: ReturnType<typeof vi.fn>;
  kickoffDesignPanel: ReturnType<typeof vi.fn>;
  dismissSession: ReturnType<typeof vi.fn>;
  reportLaunchFailure: ReturnType<typeof vi.fn>;
} {
  // Build each collaborator as override-if-given, else a default mock — NOT a
  // spread-after-defaults merge, which would leave the returned handle pointing
  // at the (unused) default mock instead of the override actually wired into
  // `deps`.
  const validateIdeaLink = overrides.validateIdeaLink ?? vi.fn().mockReturnValue({ ok: true });
  const createDesignSession =
    overrides.createDesignSession ??
    vi.fn().mockResolvedValue({ sessionId: 'sess-1', runId: 'run-design-1', worktreePath: '/tmp/wt-1' });
  const kickoffDesignPanel = overrides.kickoffDesignPanel ?? vi.fn().mockResolvedValue(undefined);
  const dismissSession = overrides.dismissSession ?? vi.fn().mockResolvedValue(undefined);
  const reportLaunchFailure = overrides.reportLaunchFailure ?? vi.fn();

  const deps: DesignSessionLaunchDeps = {
    validateIdeaLink,
    createDesignSession,
    kickoffDesignPanel,
    dismissSession,
    reportLaunchFailure,
  };
  return {
    deps,
    validateIdeaLink: validateIdeaLink as ReturnType<typeof vi.fn>,
    createDesignSession: createDesignSession as ReturnType<typeof vi.fn>,
    kickoffDesignPanel: kickoffDesignPanel as ReturnType<typeof vi.fn>,
    dismissSession: dismissSession as ReturnType<typeof vi.fn>,
    reportLaunchFailure: reportLaunchFailure as ReturnType<typeof vi.fn>,
  };
}

const ARGS = { projectId: 1, ideaId: 'idea-42', runId: 'run-planner-1', nameHint: 'design-idea-42-run-planner-1' };

describe('launchDesignSessionForFork', () => {
  it('a successful launch creates the design-linked session (validate → create → kickoff, no compensation, no failure report)', async () => {
    const { deps, validateIdeaLink, createDesignSession, kickoffDesignPanel, dismissSession, reportLaunchFailure } =
      makeDeps();

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: true, sessionId: 'sess-1', runId: 'run-design-1' });
    expect(validateIdeaLink).toHaveBeenCalledWith('idea-42', 1);
    expect(createDesignSession).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      nameHint: 'design-idea-42-run-planner-1',
    });
    expect(kickoffDesignPanel).toHaveBeenCalledWith({ sessionId: 'sess-1', worktreePath: '/tmp/wt-1' });
    expect(dismissSession).not.toHaveBeenCalled();
    expect(reportLaunchFailure).not.toHaveBeenCalled();
  });

  it('a stale/invalid idea link is rejected cleanly — createDesignSession is never called, no session is created', async () => {
    const { deps, createDesignSession, kickoffDesignPanel, dismissSession, reportLaunchFailure } = makeDeps({
      validateIdeaLink: vi.fn().mockReturnValue({ ok: false, error: 'Idea idea-42 is archived.' }),
    });

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'invalid-idea-link', error: 'Idea idea-42 is archived.' });
    expect(createDesignSession).not.toHaveBeenCalled();
    expect(kickoffDesignPanel).not.toHaveBeenCalled();
    expect(dismissSession).not.toHaveBeenCalled();
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'Idea idea-42 is archived.',
    });
  });

  it('a failure AFTER the session is minted (kickoffDesignPanel throws) compensates via dismissSession rather than orphaning it', async () => {
    const { deps, createDesignSession, kickoffDesignPanel, dismissSession, reportLaunchFailure } = makeDeps({
      kickoffDesignPanel: vi.fn().mockRejectedValue(new Error('panel creation failed')),
    });

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'launch-failed', error: 'panel creation failed' });
    expect(createDesignSession).toHaveBeenCalledOnce();
    expect(kickoffDesignPanel).toHaveBeenCalledOnce();
    // Compensated with the sessionId createDesignSession actually minted — no orphan.
    expect(dismissSession).toHaveBeenCalledWith('sess-1');
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'panel creation failed',
    });
  });

  it('a failure BEFORE any session is minted (createDesignSession throws) reports the failure WITHOUT calling dismissSession', async () => {
    const { deps, kickoffDesignPanel, dismissSession, reportLaunchFailure } = makeDeps({
      createDesignSession: vi.fn().mockRejectedValue(new Error('session-create timed out')),
    });

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'launch-failed', error: 'session-create timed out' });
    expect(kickoffDesignPanel).not.toHaveBeenCalled();
    // No sessionId was ever minted — nothing to compensate.
    expect(dismissSession).not.toHaveBeenCalled();
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'session-create timed out',
    });
  });

  it('a dismissSession compensation failure does not mask the original failure report', async () => {
    const { deps, dismissSession, reportLaunchFailure } = makeDeps({
      kickoffDesignPanel: vi.fn().mockRejectedValue(new Error('panel creation failed')),
      dismissSession: vi.fn().mockRejectedValue(new Error('dismiss also failed')),
    });

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'launch-failed', error: 'panel creation failed' });
    expect(dismissSession).toHaveBeenCalledWith('sess-1');
    // The reported error is the ORIGINAL launch failure, not the compensation failure.
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'panel creation failed',
    });
  });
});

// ---------------------------------------------------------------------------
// finishDesignSessionCreate — the post-mint tail (belt-guard + design_idea_id
// stamp) that runs AFTER createQuickSessionCore has already minted a real
// session/run/worktree. A throw here used to orphan that session, because
// launchDesignSessionForFork's saga never captures `created.sessionId` until
// the WHOLE createDesignSession promise resolves — see designSessionLaunch.ts.
// ---------------------------------------------------------------------------

describe('finishDesignSessionCreate', () => {
  it('resolves cleanly on the sdk substrate once the stamp succeeds — no dismiss', async () => {
    const stampDesignIdeaId = vi.fn();
    const dismissSession = vi.fn().mockResolvedValue(undefined);

    await expect(
      finishDesignSessionCreate({
        sessionId: 'sess-1',
        resolvedSubstrate: 'sdk',
        stampDesignIdeaId,
        dismissSession,
      }),
    ).resolves.toBeUndefined();

    expect(stampDesignIdeaId).toHaveBeenCalledOnce();
    expect(dismissSession).not.toHaveBeenCalled();
  });

  it('a throwing design_idea_id stamp compensates via a full dismiss AND still surfaces the failure', async () => {
    const stampErr = new Error('SQLITE_BUSY: database is locked');
    const stampDesignIdeaId = vi.fn(() => {
      throw stampErr;
    });
    const dismissSession = vi.fn().mockResolvedValue(undefined);

    await expect(
      finishDesignSessionCreate({
        sessionId: 'sess-1',
        resolvedSubstrate: 'sdk',
        stampDesignIdeaId,
        dismissSession,
      }),
    ).rejects.toThrow(stampErr);

    // The already-minted session/run/worktree is fully dismissed rather than orphaned.
    expect(dismissSession).toHaveBeenCalledWith('sess-1');
    expect(dismissSession).toHaveBeenCalledOnce();
  });

  it('a resolvedSubstrate mismatch (belt-guard) also compensates via a full dismiss AND surfaces', async () => {
    const stampDesignIdeaId = vi.fn();
    const dismissSession = vi.fn().mockResolvedValue(undefined);

    await expect(
      finishDesignSessionCreate({
        sessionId: 'sess-1',
        resolvedSubstrate: 'pty',
        stampDesignIdeaId,
        dismissSession,
      }),
    ).rejects.toThrow("resolved to substrate 'pty' instead of 'sdk'");

    // The stamp must never run past a failed belt-guard.
    expect(stampDesignIdeaId).not.toHaveBeenCalled();
    expect(dismissSession).toHaveBeenCalledWith('sess-1');
  });

  it('a dismiss-compensation failure is reported via onCompensationFailure but does not mask the original error', async () => {
    const stampErr = new Error('SQLITE_BUSY: database is locked');
    const dismissErr = new Error('dismiss also failed');
    const stampDesignIdeaId = vi.fn(() => {
      throw stampErr;
    });
    const dismissSession = vi.fn().mockRejectedValue(dismissErr);
    const onCompensationFailure = vi.fn();

    await expect(
      finishDesignSessionCreate({
        sessionId: 'sess-1',
        resolvedSubstrate: 'sdk',
        stampDesignIdeaId,
        dismissSession,
        onCompensationFailure,
      }),
    ).rejects.toThrow(stampErr);

    expect(onCompensationFailure).toHaveBeenCalledWith(dismissErr);
  });

  it('composed with launchDesignSessionForFork (mirrors index.ts wiring): a mid-create stamp failure is fully dismissed exactly once, never double-dismissed', async () => {
    // Mirrors how index.ts wires createDesignSession: createQuickSessionCore
    // "mints" the session, then finishDesignSessionCreate runs the tail and,
    // on failure, compensates internally before rethrowing — so the outer
    // saga's own dismissSession dep must NEVER also fire for this path.
    const sagaDismissSession = vi.fn().mockResolvedValue(undefined);
    const innerDismissSession = vi.fn().mockResolvedValue(undefined);
    const reportLaunchFailure = vi.fn();
    const kickoffDesignPanel = vi.fn();

    const deps: DesignSessionLaunchDeps = {
      validateIdeaLink: () => ({ ok: true }),
      createDesignSession: async () => {
        // The session/run/worktree already exist by this point (createQuickSessionCore
        // ran inside this closure, exactly like index.ts's real dep).
        await finishDesignSessionCreate({
          sessionId: 'sess-1',
          resolvedSubstrate: 'sdk',
          stampDesignIdeaId: () => {
            throw new Error('SQLITE_BUSY: database is locked');
          },
          dismissSession: innerDismissSession,
        });
        // Unreachable — finishDesignSessionCreate rethrows above.
        return { sessionId: 'sess-1', runId: 'run-design-1', worktreePath: '/tmp/wt-1' };
      },
      kickoffDesignPanel,
      dismissSession: sagaDismissSession,
      reportLaunchFailure,
    };

    const result = await launchDesignSessionForFork(deps, ARGS);

    expect(result).toEqual({ ok: false, reason: 'launch-failed', error: 'SQLITE_BUSY: database is locked' });
    // Dismissed exactly once, by the INNER compensation — never by the saga
    // (which never captured a sessionId for this failure window).
    expect(innerDismissSession).toHaveBeenCalledWith('sess-1');
    expect(innerDismissSession).toHaveBeenCalledOnce();
    expect(sagaDismissSession).not.toHaveBeenCalled();
    expect(kickoffDesignPanel).not.toHaveBeenCalled();
    expect(reportLaunchFailure).toHaveBeenCalledWith({
      projectId: 1,
      ideaId: 'idea-42',
      runId: 'run-planner-1',
      error: 'SQLITE_BUSY: database is locked',
    });
  });
});
