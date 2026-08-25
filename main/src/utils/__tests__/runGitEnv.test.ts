/**
 * runGit's environment handling — the piece that lets the whole shell-git
 * migration land.
 *
 * The exec()-based call sites this migration replaced got the user's login-shell
 * PATH from utils/shellPath (macOS GUI apps inherit a minimal PATH, so a plain
 * execFile('git') can miss a Homebrew/nvm git). runGit has to resolve git the
 * same way, or migrating a call site would break git discovery in a packaged
 * app. These tests prove the resolved PATH actually drives the spawn by putting
 * a `git` shim on it and asserting the shim runs.
 *
 * getShellPath is mocked, so this file must stay separate from runGit.test.ts
 * (which spawns real git).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chmodSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { withTempDir } from '../../__test_fixtures__/tmp';

vi.mock('../shellPath', () => ({ getShellPath: vi.fn() }));

import { getShellPath } from '../shellPath';
import { runGit, runGitAsync, runGitCapture, buildCommandEnv, assertNotOptionLike } from '../runGit';

/** Write an executable `git` shim that reports how it was invoked. */
function installGitShim(dir: string, body: string): string {
  const binDir = join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const shim = join(binDir, 'git');
  writeFileSync(shim, `#!/bin/sh\n${body}\n`);
  chmodSync(shim, 0o755);
  return binDir;
}

beforeEach(() => {
  vi.mocked(getShellPath).mockReset();
});

describe('buildCommandEnv', () => {
  it('replaces PATH with the login-shell PATH while keeping the inherited env', () => {
    vi.mocked(getShellPath).mockReturnValue('/shell/one:/shell/two');
    process.env.CYBOFLOW_RUNGIT_ENV_PROBE = 'inherited';
    try {
      const env = buildCommandEnv();
      expect(env.PATH).toBe('/shell/one:/shell/two');
      expect(env.CYBOFLOW_RUNGIT_ENV_PROBE).toBe('inherited');
    } finally {
      delete process.env.CYBOFLOW_RUNGIT_ENV_PROBE;
    }
  });

  it('lets a caller-supplied env win, including an explicit PATH override', () => {
    vi.mocked(getShellPath).mockReturnValue('/shell/one');
    const env = buildCommandEnv({ GIT_AUTHOR_NAME: 'TestAuthor', PATH: '/caller/bin' });
    expect(env.GIT_AUTHOR_NAME).toBe('TestAuthor');
    expect(env.PATH).toBe('/caller/bin');
  });

  it('degrades to the inherited PATH when shell PATH resolution throws', () => {
    vi.mocked(getShellPath).mockImplementation(() => {
      throw new Error('no shell');
    });
    expect(buildCommandEnv().PATH).toBe(process.env.PATH);
  });
});

describe('assertNotOptionLike', () => {
  it('passes an ordinary ref through unchanged', () => {
    expect(assertNotOptionLike('feature/login', 'branch')).toBe('feature/login');
    expect(assertNotOptionLike('deadbeef', 'merge base')).toBe('deadbeef');
  });

  it('rejects a ref that git would parse as an option, naming the value', () => {
    expect(() => assertNotOptionLike('--upload-pack=touch /tmp/x', 'main branch')).toThrow(
      /main branch.*--upload-pack=touch \/tmp\/x/,
    );
  });
});

describe('git is resolved through the login-shell PATH', () => {
  it('runGit spawns the git found on the resolved shell PATH', async () => {
    await withTempDir('rungit-path-sync-', async (dir) => {
      vi.mocked(getShellPath).mockReturnValue(installGitShim(dir, 'echo SHIM_SYNC'));
      expect(runGit(dir, ['--version']).trim()).toBe('SHIM_SYNC');
    });
  });

  it('runGitAsync spawns the git found on the resolved shell PATH', async () => {
    await withTempDir('rungit-path-async-', async (dir) => {
      vi.mocked(getShellPath).mockReturnValue(installGitShim(dir, 'echo SHIM_ASYNC'));
      expect((await runGitAsync(dir, ['--version'])).trim()).toBe('SHIM_ASYNC');
    });
  });

  it('runGitCapture returns stderr as well as stdout', async () => {
    await withTempDir('rungit-capture-', async (dir) => {
      vi.mocked(getShellPath).mockReturnValue(
        installGitShim(dir, 'echo to-stdout\necho to-stderr 1>&2'),
      );
      const { stdout, stderr } = await runGitCapture(dir, ['status']);
      expect(stdout.trim()).toBe('to-stdout');
      expect(stderr.trim()).toBe('to-stderr');
    });
  });

  it('passes arguments as argv, so a hostile ref never reaches a shell', async () => {
    await withTempDir('rungit-argv-', async (dir) => {
      // The shim prints one argument per line; a shell would have split or
      // expanded these instead of passing them through intact.
      vi.mocked(getShellPath).mockReturnValue(installGitShim(dir, 'for a in "$@"; do echo "[$a]"; done'));
      const out = await runGitAsync(dir, ['log', '--end-of-options', '$(touch /tmp/pwned) branch']);
      expect(out.split('\n').filter(Boolean)).toEqual([
        '[log]',
        '[--end-of-options]',
        '[$(touch /tmp/pwned) branch]',
      ]);
    });
  });
});
