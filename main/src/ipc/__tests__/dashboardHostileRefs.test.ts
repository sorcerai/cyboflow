/**
 * The dashboard handlers read a project's branch and remote names off disk and
 * feed them straight back into git — `getRemoteStatuses` fetches every remote by
 * name, and each session's branch is compared against the main branch. That is
 * the path a hostile repository reaches on an ordinary dashboard refresh, so
 * every value is asserted at the argv level: shell-free is not enough on its own,
 * the ref also has to sit behind `--end-of-options`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '../../__test_fixtures__/tmp';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { isPackaged: false, getPath: vi.fn(() => '/mock') },
}));

vi.mock('../../utils/runGit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/runGit')>()),
  runGit: vi.fn(() => ''),
  runGitCapture: vi.fn(async () => ({ stdout: '', stderr: '' })),
  runToolCapture: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

import { runGit, runGitCapture, runToolCapture, END_OF_OPTIONS } from '../../utils/runGit';
import { registerDashboardHandlers } from '../dashboard';
import type { AppServices } from '../types';

/** A branch/remote name that git would parse as an option in a flag position. */
const OPTION_REF = '--upload-pack=touch /tmp/cyboflow-dashboard-injection';

type Handler = (...args: unknown[]) => Promise<unknown>;

function register(services: AppServices): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) };
  registerDashboardHandlers(ipcMain as unknown as Parameters<typeof registerDashboardHandlers>[0], services);
  return handlers;
}

function makeServices(projectPath: string, worktreePath: string): AppServices {
  return {
    databaseService: {
      getProject: () => ({ id: 1, name: 'Proj', path: projectPath }),
      getAllSessions: () => [
        { id: 's1', name: 'S1', worktree_path: worktreePath, archived: false, base_branch: OPTION_REF },
      ],
    },
    worktreeManager: { getProjectMainBranch: vi.fn(async () => OPTION_REF) },
  } as unknown as AppServices;
}

/** All git argv arrays the handler produced, from both the sync and async runners. */
function allGitArgs(): string[][] {
  return [
    ...vi.mocked(runGit).mock.calls.map(([, args]) => args),
    ...vi.mocked(runGitCapture).mock.calls.map(([, args]) => args),
  ];
}

beforeEach(() => {
  vi.mocked(runGit).mockReset().mockReturnValue('');
  vi.mocked(runGitCapture).mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  vi.mocked(runToolCapture).mockReset().mockResolvedValue({ stdout: '', stderr: '' });
});

describe('dashboard:get-project-status with hostile branch/remote names', () => {
  it('every git argument carrying the hostile ref sits after --end-of-options', async () => {
    await withTempDir('dashboard-hostile-', async (dir) => {
      const projectPath = join(dir, 'project');
      mkdirSync(join(projectPath, '.git'), { recursive: true });
      mkdirSync(join(dir, 'wt'), { recursive: true });

      // One remote, named the same hostile string, so getRemoteStatuses fetches it.
      vi.mocked(runGitCapture).mockImplementation(async (_cwd, args) => {
        if (args[0] === 'remote') return { stdout: `${OPTION_REF}\thttps://example.test/r (fetch)`, stderr: '' };
        if (args[0] === 'branch') return { stdout: 'feature\n', stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const handlers = register(makeServices(projectPath, join(dir, 'wt')));
      const result = (await handlers.get('dashboard:get-project-status')!({}, 1)) as { success: boolean };
      expect(result.success).toBe(true);

      const argvs = allGitArgs();
      const hostileArgvs = argvs.filter(args => args.some(a => a.includes(OPTION_REF)));
      expect(hostileArgvs.length).toBeGreaterThan(0);

      for (const args of hostileArgvs) {
        const marker = args.indexOf(END_OF_OPTIONS);
        expect(marker, `no --end-of-options in: ${JSON.stringify(args)}`).toBeGreaterThan(-1);
        const firstHostile = args.findIndex(a => a.includes(OPTION_REF));
        expect(firstHostile).toBeGreaterThan(marker);
      }
    });
  });

  it('passes the branch to gh as --head=<branch>, never as a bare positional', async () => {
    await withTempDir('dashboard-gh-', async (dir) => {
      const projectPath = join(dir, 'project');
      mkdirSync(join(projectPath, '.git'), { recursive: true });
      mkdirSync(join(dir, 'wt'), { recursive: true });

      vi.mocked(runGitCapture).mockImplementation(async (_cwd, args) => {
        if (args[0] === 'branch') return { stdout: `${OPTION_REF}\n`, stderr: '' };
        return { stdout: '', stderr: '' };
      });

      const handlers = register(makeServices(projectPath, join(dir, 'wt')));
      await handlers.get('dashboard:get-project-status')!({}, 1);

      const ghCalls = vi.mocked(runToolCapture).mock.calls;
      expect(ghCalls.length).toBeGreaterThan(0);
      for (const [bin, , args] of ghCalls) {
        expect(bin).toBe('gh');
        expect(args).toContain(`--head=${OPTION_REF}`);
        expect(args).not.toContain(OPTION_REF);
      }
    });
  });
});
