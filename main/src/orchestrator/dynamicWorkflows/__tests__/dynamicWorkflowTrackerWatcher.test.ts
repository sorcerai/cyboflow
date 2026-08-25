/**
 * Unit tests for DynamicWorkflowTracker's launch-watcher WIRING and the
 * `hasRunningForRun` lifecycle predicate.
 *
 * Kept separate from dynamicWorkflowTracker.test.ts because this file mocks the
 * WorkflowScriptWatcher module wholesale (to assert the key dir it is handed
 * without touching the real `~/.claude/projects`), which the sibling suite
 * deliberately exercises for real.
 *
 * The regression under test: a FLOW run has NO `sessions` row — the orchestrator
 * invariant is `panelId === runId === sessionId` and `getDbSession(sessionId)`
 * is undefined for it — so the tracker's `sessions`-keyed worktree lookup
 * resolved null and NO launch watcher started. Combined with stream detection
 * being inoperative on the interactive transcript layout, a dynamic workflow
 * launched inside a PTY workflow run was invisible to the tracker entirely.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventRouter } from '../../../services/streamParser/eventRouter';
import { encodeCwd } from '../../../services/panels/claude/transcript/encodeCwd';
import type { DatabaseLike } from '../../types';

// Mock the watcher module so construction is observable and no fs polling starts.
const watcherCtor = vi.fn();
const watcherStart = vi.fn();
const watcherStop = vi.fn();
vi.mock('../workflowScriptWatcher', () => ({
  WorkflowScriptWatcher: class {
    constructor(...args: unknown[]) {
      watcherCtor(...args);
    }
    start(): void {
      watcherStart();
    }
    stop(): void {
      watcherStop();
    }
  },
}));

// Imported AFTER the mock declaration (vi.mock is hoisted, so this is fine).
import { DynamicWorkflowTracker } from '../dynamicWorkflowTracker';

/**
 * Minimal DatabaseLike stub. `sessionRows` maps a session id to the row the
 * tracker's lookups return; an id that is absent returns undefined — exactly how
 * a flow run's non-existent `sessions` row behaves.
 */
function buildDb(sessionRows: Record<string, { worktree_path?: string | null; name?: string; project_id?: number }>): DatabaseLike {
  return {
    prepare: (sql: string) => ({
      get: (id?: unknown) => {
        if (typeof id !== 'string') return undefined;
        const row = sessionRows[id];
        if (row === undefined) return undefined;
        if (sql.includes('worktree_path')) return { worktree_path: row.worktree_path ?? null };
        return { name: row.name ?? 'sess', project_id: row.project_id ?? 1 };
      },
      all: () => [],
      run: () => ({ changes: 0 }),
    }),
  } as unknown as DatabaseLike;
}

/** The key dir the tracker should derive for a given worktree path. */
function expectedKeyDir(worktreePath: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(worktreePath));
}

describe('DynamicWorkflowTracker — launch-watcher wiring', () => {
  beforeEach(() => {
    watcherCtor.mockClear();
    watcherStart.mockClear();
    watcherStop.mockClear();
  });

  afterEach(() => {
    DynamicWorkflowTracker._resetForTesting();
  });

  it('starts a watcher for a FLOW run (no sessions row) from the supplied worktreePath', () => {
    // The regression: sessionRows is EMPTY, exactly as for a flow run whose
    // sessionId === runId and which owns no `sessions` row.
    const tracker = DynamicWorkflowTracker.initialize(buildDb({}));
    const worktreePath = '/tmp/worktrees/run-flow-1';

    tracker.attachToRouter(new EventRouter(), {
      runId: 'run-flow-1',
      sessionId: 'run-flow-1',
      worktreePath,
    });

    expect(watcherCtor).toHaveBeenCalledTimes(1);
    expect(watcherCtor.mock.calls[0][0]).toBe(expectedKeyDir(worktreePath));
    expect(watcherStart).toHaveBeenCalledTimes(1);
  });

  it('starts NO watcher for a flow run when no worktreePath is supplied (the pre-fix behaviour)', () => {
    const tracker = DynamicWorkflowTracker.initialize(buildDb({}));

    tracker.attachToRouter(new EventRouter(), { runId: 'run-flow-2', sessionId: 'run-flow-2' });

    expect(watcherCtor).not.toHaveBeenCalled();
    expect(watcherStart).not.toHaveBeenCalled();
  });

  it('falls back to the sessions lookup for a QUICK session that supplies no path', () => {
    const tracker = DynamicWorkflowTracker.initialize(
      buildDb({ 'sess-1': { worktree_path: '/tmp/worktrees/quick-1' } }),
    );

    tracker.attachToRouter(new EventRouter(), { runId: 'chat-run-1', sessionId: 'sess-1' });

    expect(watcherCtor).toHaveBeenCalledTimes(1);
    expect(watcherCtor.mock.calls[0][0]).toBe(expectedKeyDir('/tmp/worktrees/quick-1'));
  });

  it('prefers the supplied worktreePath over the sessions row', () => {
    const tracker = DynamicWorkflowTracker.initialize(
      buildDb({ 'sess-2': { worktree_path: '/tmp/worktrees/stale' } }),
    );

    tracker.attachToRouter(new EventRouter(), {
      runId: 'chat-run-2',
      sessionId: 'sess-2',
      worktreePath: '/tmp/worktrees/authoritative',
    });

    expect(watcherCtor.mock.calls[0][0]).toBe(expectedKeyDir('/tmp/worktrees/authoritative'));
  });

  it('treats a blank supplied worktreePath as absent and falls back', () => {
    const tracker = DynamicWorkflowTracker.initialize(
      buildDb({ 'sess-3': { worktree_path: '/tmp/worktrees/quick-3' } }),
    );

    tracker.attachToRouter(new EventRouter(), {
      runId: 'chat-run-3',
      sessionId: 'sess-3',
      worktreePath: '   ',
    });

    expect(watcherCtor.mock.calls[0][0]).toBe(expectedKeyDir('/tmp/worktrees/quick-3'));
  });

  it('replaces (stops) a prior watcher when the same runId re-attaches', () => {
    const tracker = DynamicWorkflowTracker.initialize(buildDb({}));
    const ctx = { runId: 'run-flow-3', sessionId: 'run-flow-3', worktreePath: '/tmp/w/3' };

    tracker.attachToRouter(new EventRouter(), ctx);
    tracker.attachToRouter(new EventRouter(), ctx);

    expect(watcherCtor).toHaveBeenCalledTimes(2);
    expect(watcherStop).toHaveBeenCalledTimes(1);
  });
});

describe('DynamicWorkflowTracker.hasRunningForRun', () => {
  afterEach(() => {
    DynamicWorkflowTracker._resetForTesting();
  });

  it('is false for an unknown run', () => {
    const tracker = DynamicWorkflowTracker.initialize(buildDb({}));
    expect(tracker.hasRunningForRun('nope')).toBe(false);
  });

  it('is true while a tracked workflow for the run is running, false once terminal', () => {
    const tracker = DynamicWorkflowTracker.initialize(buildDb({}));
    // injectDemoWorkflow is the only public seam that materializes state without
    // an on-disk journal; it registers as 'running' synchronously.
    tracker.injectDemoWorkflow({ runId: 'run-a', sessionId: 'sess-a' });

    expect(tracker.hasRunningForRun('run-a')).toBe(true);
    // Scoped to the run — a sibling run is unaffected.
    expect(tracker.hasRunningForRun('run-b')).toBe(false);

    // Dismissal drops the state entirely (the terminal card's dismiss CTA).
    const state = tracker.list('sess-a')[0];
    tracker.dismiss(state.wfRunId);
    expect(tracker.hasRunningForRun('run-a')).toBe(false);
  });
});
