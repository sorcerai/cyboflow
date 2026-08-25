/**
 * The renderer-facing git handlers, driven with hostile inputs.
 *
 * These handlers take no free-form git arguments from the renderer — every
 * channel is keyed by sessionId and builds its own command — so the injection
 * surface is the repo-derived main branch name plus the renderer-supplied commit
 * MESSAGE. Both are asserted at the argv level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock'), getName: () => 'Cyboflow', getVersion: () => '0.1.0' },
}));
vi.mock('../../index', () => ({ mainWindow: null }));
vi.mock('../../services/panelManager', () => ({
  panelManager: { createPanel: vi.fn(), getPanelsForSession: vi.fn(() => []) },
}));

vi.mock('../../utils/runGit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/runGit')>()),
  runGit: vi.fn(() => ''),
  runGitAsync: vi.fn(async () => ''),
}));

import { runGit, END_OF_OPTIONS } from '../../utils/runGit';
import { registerGitHandlers } from '../git';
import type { AppServices } from '../types';

const OPTION_REF = '--upload-pack=touch /tmp/cyboflow-git-handler-injection';

type Handler = (...args: unknown[]) => Promise<unknown>;

function inertDb() {
  const stmt = { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
  return { prepare: () => stmt, transaction: <T>(fn: (...a: unknown[]) => T) => fn };
}

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  const services = {
    sessionManager: {
      getSession: vi.fn(async () => ({ id: 's1', worktreePath: '/wt', archived: false, isMainRepo: false })),
      getProjectForSession: vi.fn(() => ({ id: 1, name: 'Proj', path: '/repo' })),
    },
    worktreeManager: {
      getProjectMainBranch: vi.fn(async () => OPTION_REF),
      getOriginBranch: vi.fn(async () => null),
      generateRebaseCommands: () => [],
      generateSquashCommands: () => [],
      generateMergeCommands: () => [],
    },
    gitDiffManager: {},
    gitStatusManager: { refreshSessionGitStatus: vi.fn(async () => {}) },
    databaseService: { getDb: () => inertDb() },
    configManager: { getConfig: () => ({ enableCyboflowFooter: false }), isDemoMode: () => false },
    claudeCodeManager: {},
  } as unknown as AppServices;
  registerGitHandlers(ipcMain as unknown as Parameters<typeof registerGitHandlers>[0], services);
  return handlers;
}

function argsFor(subcommand: string): string[][] {
  return vi.mocked(runGit).mock.calls.map(([, args]) => args).filter(args => args[0] === subcommand);
}

beforeEach(() => {
  vi.mocked(runGit).mockReset().mockReturnValue('');
});

describe('renderer-facing git handlers with hostile inputs', () => {
  it('get-branch-commit-subjects guards the repo-derived main branch', async () => {
    const handlers = register();
    await handlers.get('sessions:get-branch-commit-subjects')!({}, 's1');

    const [args] = argsFor('log');
    expect(args.slice(0, 2)).toEqual(['log', '--pretty=%s']);
    expect(args.slice(args.indexOf(END_OF_OPTIONS) + 1)).toEqual([`${OPTION_REF}..HEAD`]);
  });

  it('git-commit passes the message as its own argv element, not a quoted shell fragment', async () => {
    // A message that terminates a shell string and appends a command; as argv it
    // is inert, and it must reach git verbatim rather than escaped.
    const message = `fix: thing'; touch /tmp/cyboflow-commit-injection; echo '`;
    vi.mocked(runGit).mockImplementation((_cwd, args) => (args[0] === 'status' ? ' M a.txt\n' : ''));

    const handlers = register();
    const result = (await handlers.get('sessions:git-commit')!({}, 's1', message)) as { success: boolean };
    expect(result.success).toBe(true);

    const [args] = argsFor('commit');
    expect(args).toEqual(['commit', '-m', message]);
  });

  it('git-commit refuses when the worktree is clean, without staging anything', async () => {
    const handlers = register();
    const result = (await handlers.get('sessions:git-commit')!({}, 's1', 'msg')) as { success: boolean };

    expect(result.success).toBe(false);
    expect(argsFor('add')).toEqual([]);
    expect(argsFor('commit')).toEqual([]);
  });
});
