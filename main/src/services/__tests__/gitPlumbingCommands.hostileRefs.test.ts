/**
 * The plumbing helpers run on every git-status poll, with the session's base
 * branch and arbitrary worktree paths as inputs. Argv-level assertions here;
 * the real-git behavior of these helpers lives in gitPlumbingCommands.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/runGit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/runGit')>()),
  runGit: vi.fn(() => ''),
  runGitAsync: vi.fn(async () => '0\t0'),
}));

import { runGit, runGitAsync, END_OF_OPTIONS } from '../../utils/runGit';
import { fastGetAheadBehind, isPathModified, getCurrentBranch } from '../gitPlumbingCommands';

const OPTION_REF = '--upload-pack=touch /tmp/cyboflow-plumbing-injection';
/** An existing dir so each helper's fs.accessSync guard passes. */
const EXISTING_DIR = process.cwd();

beforeEach(() => {
  vi.mocked(runGit).mockReset().mockReturnValue('');
  vi.mocked(runGitAsync).mockReset().mockResolvedValue('0\t0');
});

describe('gitPlumbingCommands with hostile inputs', () => {
  it('fastGetAheadBehind puts the base-branch range behind --end-of-options', async () => {
    await fastGetAheadBehind(EXISTING_DIR, OPTION_REF);

    const [[, args]] = vi.mocked(runGitAsync).mock.calls;
    expect(args.slice(args.indexOf(END_OF_OPTIONS) + 1)).toEqual([`${OPTION_REF}...HEAD`]);
  });

  it('isPathModified keeps a leading-dash path in the pathspec position', () => {
    isPathModified(EXISTING_DIR, '--output=/tmp/cyboflow-plumbing-path');

    const [[, args]] = vi.mocked(runGit).mock.calls;
    expect(args.slice(args.indexOf('--'))).toEqual(['--', '--output=/tmp/cyboflow-plumbing-path']);
  });

  it('getCurrentBranch reads HEAD through argv, with no interpolated command', () => {
    vi.mocked(runGit).mockReturnValue(`${OPTION_REF}\n`);

    expect(getCurrentBranch(EXISTING_DIR)).toBe(OPTION_REF);
    expect(vi.mocked(runGit).mock.calls[0][1]).toEqual(['symbolic-ref', '--short', 'HEAD']);
  });
});
