/**
 * sessions:stop — pending-gate settlement hardening.
 *
 * Stop is a user cancel: any pending human gates on the session's gate run
 * (the __quick__ chat_run_id sentinel — AskUserQuestion decisions + permission
 * approvals) must be settled BEFORE the panel processes are killed. A turn
 * parked inside the AskUserQuestion PreToolUse hook is blocked on the
 * QuestionRouter promise; settling it first unparks the hook so the abort can
 * never hang on it, and guarantees the gate cannot outlive the stop.
 *
 * Covered:
 *  - both routers' clearPendingForRun fire with the chat_run_id sentinel,
 *    BEFORE claudeCodeManager.stopPanel;
 *  - chat_run_id falls back to run_id when the sentinel is absent;
 *  - no gate run at all → no router calls, stop still succeeds;
 *  - uninitialized routers (getInstance throws) are fail-soft — stop succeeds.
 *
 * Follows the sessionDelete harness: electron/panelManager/database singletons
 * are module-mocked; the routers are the REAL singletons initialized on a
 * throwaway test DB with spies on clearPendingForRun.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => []),
  },
}));

vi.mock('../../services/database', () => ({
  databaseService: { getSession: vi.fn(() => undefined) },
}));

import type Database from 'better-sqlite3';
import { registerSessionHandlers } from '../session';
import type { AppServices } from '../types';
import { panelManager } from '../../services/panelManager';
import { QuestionRouter } from '../../orchestrator/questionRouter';
import { ApprovalRouter } from '../../orchestrator/approvalRouter';
import { dbAdapter } from '../../orchestrator/__test_fixtures__/dbAdapter';
import { createTestDb } from '../../orchestrator/__test_fixtures__/orchestratorTestDb';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler for channel: ${channel}`);
  return fn({} as unknown, ...args);
}

interface DbRow {
  id: string;
  chat_run_id?: string | null;
  run_id?: string | null;
  agent_runtime?: string;
  substrate?: string;
}

function makeServices(dbSession: DbRow | undefined) {
  const stopClaudePanel = vi.fn(async () => {});
  const codexSdkManager = { on: vi.fn(), stopPanel: vi.fn(async () => {}) };
  const codexPtyManager = { on: vi.fn(), stopPanel: vi.fn(async () => {}) };
  const ompSdkManager = { on: vi.fn(), stopPanel: vi.fn(async () => {}) };
  const ompPtyManager = { on: vi.fn(), stopPanel: vi.fn(async () => {}) };
  const services = {
    sessionManager: {
      addSessionOutput: vi.fn(),
      addPanelOutput: vi.fn(),
      emit: vi.fn(),
      stopSession: vi.fn(),
    },
    databaseService: {
      getSession: vi.fn(() => dbSession),
    },
    claudeCodeManager: { stopPanel: stopClaudePanel, stopSession: vi.fn() },
    codexSdkManager,
    codexPtyManager,
    ompSdkManager,
    ompPtyManager,
    configManager: { isDemoMode: () => false },
  } as unknown as AppServices;
  return { services, stopClaudePanel, codexSdkManager, codexPtyManager, ompSdkManager, ompPtyManager };
}

function register(services: AppServices) {
  const { ipcMain, handlers } = makeHandlerCapture();
  registerSessionHandlers(ipcMain as unknown as Parameters<typeof registerSessionHandlers>[0], services);
  return handlers;
}

const CLAUDE_PANEL = { id: 'panel-1', sessionId: 's1', type: 'claude' } as never;

describe('sessions:stop — pending-gate settlement', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([CLAUDE_PANEL]);
    db = createTestDb();
    QuestionRouter.initialize(dbAdapter(db));
    ApprovalRouter.initialize(dbAdapter(db));
  });

  afterEach(() => {
    QuestionRouter._resetForTesting();
    ApprovalRouter._resetForTesting();
    db.close();
  });

  it('settles question + approval gates on the chat_run_id sentinel BEFORE stopping the panel', async () => {
    const questionClear = vi.spyOn(QuestionRouter.getInstance(), 'clearPendingForRun');
    const approvalClear = vi.spyOn(ApprovalRouter.getInstance(), 'clearPendingForRun');
    const { services, stopClaudePanel } = makeServices({ id: 's1', chat_run_id: 'gate-run-1', run_id: 'flow-run-1' });
    const handlers = register(services);

    const result = (await invoke(handlers, 'sessions:stop', 's1')) as { success: boolean };

    expect(result.success).toBe(true);
    // Keyed on the SENTINEL, not the latest flow run.
    expect(questionClear).toHaveBeenCalledWith('gate-run-1');
    expect(approvalClear).toHaveBeenCalledWith('gate-run-1');
    expect(stopClaudePanel).toHaveBeenCalledWith('panel-1');
    // Gates settle FIRST so the abort can never hang on a parked question hook.
    expect(questionClear.mock.invocationCallOrder[0]).toBeLessThan(
      stopClaudePanel.mock.invocationCallOrder[0],
    );
  });

  it('falls back to run_id when the session has no chat_run_id sentinel', async () => {
    const questionClear = vi.spyOn(QuestionRouter.getInstance(), 'clearPendingForRun');
    const { services } = makeServices({ id: 's1', chat_run_id: null, run_id: 'flow-run-1' });
    const handlers = register(services);

    await invoke(handlers, 'sessions:stop', 's1');

    expect(questionClear).toHaveBeenCalledWith('flow-run-1');
  });

  it('makes no router calls (and still succeeds) when the session has no gate run', async () => {
    const questionClear = vi.spyOn(QuestionRouter.getInstance(), 'clearPendingForRun');
    const approvalClear = vi.spyOn(ApprovalRouter.getInstance(), 'clearPendingForRun');
    const { services } = makeServices({ id: 's1', chat_run_id: null, run_id: null });
    const handlers = register(services);

    const result = (await invoke(handlers, 'sessions:stop', 's1')) as { success: boolean };

    expect(result.success).toBe(true);
    expect(questionClear).not.toHaveBeenCalled();
    expect(approvalClear).not.toHaveBeenCalled();
  });

  it('is fail-soft when the routers are not initialized (getInstance throws)', async () => {
    QuestionRouter._resetForTesting();
    ApprovalRouter._resetForTesting();
    const { services, stopClaudePanel } = makeServices({ id: 's1', chat_run_id: 'gate-run-1' });
    const handlers = register(services);

    const result = (await invoke(handlers, 'sessions:stop', 's1')) as { success: boolean };

    expect(result.success).toBe(true);
    expect(stopClaudePanel).toHaveBeenCalledWith('panel-1');
  });
});

/**
 * Stop dispatches per PANEL LANE. A session-level test would send a mixed
 * session's odd panel to the wrong manager, and the switch this replaces knew
 * only the two Codex lanes — so an OMP panel's process survived its own Stop.
 */
describe('sessions:stop — per-lane teardown', () => {
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(panelManager.getPanelsForSession).mockReturnValue([CLAUDE_PANEL]);
    db = createTestDb();
    QuestionRouter.initialize(dbAdapter(db));
    ApprovalRouter.initialize(dbAdapter(db));
  });

  afterEach(() => {
    QuestionRouter._resetForTesting();
    ApprovalRouter._resetForTesting();
    db.close();
  });

  it.each([
    ['codex-sdk', 'sdk', 'codexSdkManager'],
    ['codex-pty', 'interactive', 'codexPtyManager'],
    ['omp-sdk', 'sdk', 'ompSdkManager'],
    ['omp-pty', 'interactive', 'ompPtyManager'],
  ] as const)('routes a %s panel to its own manager', async (agentRuntime, substrate, ownerKey) => {
    const made = makeServices({ id: 's1', chat_run_id: 'gate-run-1', agent_runtime: agentRuntime, substrate });
    const handlers = register(made.services);

    const result = (await invoke(handlers, 'sessions:stop', 's1')) as { success: boolean };

    expect(result.success).toBe(true);
    expect(made[ownerKey].stopPanel).toHaveBeenCalledWith('panel-1');
    // Claude must never answer for another vendor's panel.
    expect(made.stopClaudePanel).not.toHaveBeenCalled();
    for (const other of ['codexSdkManager', 'codexPtyManager', 'ompSdkManager', 'ompPtyManager'] as const) {
      if (other === ownerKey) continue;
      expect(made[other].stopPanel).not.toHaveBeenCalled();
    }
  });

  it('keeps a Claude panel on claudeCodeManager', async () => {
    const made = makeServices({ id: 's1', chat_run_id: 'gate-run-1', agent_runtime: 'claude-sdk' });
    const handlers = register(made.services);

    await invoke(handlers, 'sessions:stop', 's1');

    expect(made.stopClaudePanel).toHaveBeenCalledWith('panel-1');
    expect(made.ompSdkManager.stopPanel).not.toHaveBeenCalled();
  });
});
