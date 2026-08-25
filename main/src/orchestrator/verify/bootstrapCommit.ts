/**
 * The bootstrap's PATHSPEC COMMIT (docs/proposals/lane-runbook-bootstrap.md §8
 * check 4, §9).
 *
 * WHY THIS IS NOT `git add . && git commit`. The bootstrap commits into a
 * worktree that up to five sprint lanes are editing CONCURRENTLY. v1 used
 * `git add -f` plus a bare `git commit`, and both reviews found the same defect:
 * a bare commit sweeps up whatever sibling implement agents happen to have
 * staged at that instant, so the "runbook commit" silently carries another
 * lane's half-finished work — and the guard that was supposed to make this safe
 * would then have "safely" reverted it.
 *
 * THE RECIPE, and why it is two commands rather than one:
 *
 *   1. `git add -f -- <paths>` stages ONLY these paths. It has to exist because
 *      `git commit -- <path>` refuses a path git has never seen, and the runbook
 *      is a new file. `-f` is required for a real reason rather than a hunch:
 *      many repos ignore or locally-exclude `.cyboflow/` (it is where cyboflow
 *      keeps its own worktrees and local state), which makes a plain `git add`
 *      of the runbook a silent no-op — observed live 2026-07-31 on the setup
 *      flow, where it surfaced ten minutes later as an inexplicable proof
 *      failure against a snapshot that did not contain the file.
 *   2. `git commit -- <paths>` is a PARTIAL commit: git builds a temporary index
 *      from HEAD plus exactly these paths, so whatever else sits staged in the
 *      real index is neither committed nor disturbed.
 *
 * Adding our own paths to the shared index is the one unavoidable interaction,
 * and it is additive — it cannot remove or alter a sibling's staged entry.
 *
 * INDEX.LOCK IS EXPECTED, NOT EXCEPTIONAL. Concurrent lanes run git constantly,
 * and `.git/index.lock` is held for the duration of each of those commands. A
 * collision here is an ordinary event on a busy worktree, so it is retried with
 * backoff rather than reported as a failure — a bootstrap that gave up because
 * another lane was mid-`git status` would fail for a reason that has nothing to
 * do with the project.
 *
 * IO-free: the git invocation is injected, so every rule above is testable
 * against a fake.
 */
import type { LoggerLike } from '../types';

/** Runs `git <args>` in the worktree and resolves its stdout. Rejects on non-zero exit. */
export type GitRunner = (args: string[]) => Promise<string>;

/** How many times a lock collision is retried before it is reported as a failure. */
export const INDEX_LOCK_MAX_ATTEMPTS = 5;

/** Base backoff; attempt N waits `INDEX_LOCK_BACKOFF_MS * N`. */
export const INDEX_LOCK_BACKOFF_MS = 250;

/**
 * True for the family of errors that mean "another git process holds the index",
 * which is a WAIT rather than a failure.
 *
 * Matched on the message because that is the only channel git offers — the exit
 * code for a lock collision is the same 128 as for a dozen unrelated errors, so
 * keying on the code would retry things that will never succeed.
 */
export function isIndexLockContention(message: string): boolean {
  return (
    message.includes('index.lock') ||
    message.includes('Another git process seems to be running') ||
    message.includes('Unable to create') && message.includes('.lock')
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  });
}

/**
 * Run one git command, retrying only on index-lock contention.
 *
 * Every other failure propagates on the FIRST attempt: a missing author
 * identity, a detached HEAD, a path that does not exist — none of those become
 * true by waiting, and retrying them would turn a two-second error into a
 * ten-second one while the owning lane is parked.
 */
async function runWithLockRetry(
  git: GitRunner,
  args: string[],
  logger?: LoggerLike,
  backoffMs: number = INDEX_LOCK_BACKOFF_MS,
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= INDEX_LOCK_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await git(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isIndexLockContention(message)) throw err;
      lastError = err instanceof Error ? err : new Error(message);
      logger?.debug('[bootstrapCommit] git index is locked by another lane; retrying', {
        args: args.join(' '),
        attempt,
      });
      if (attempt < INDEX_LOCK_MAX_ATTEMPTS) await sleep(backoffMs * attempt);
    }
  }
  throw lastError ?? new Error('git index remained locked');
}

/**
 * Stage and commit EXACTLY `paths`, returning the resulting HEAD sha.
 *
 * Returns the sha rather than nothing because the sha is load-bearing
 * downstream: it is recorded on the bootstrap stamp and EXCLUDED from every
 * sibling lane's commit-integrity probe (§9), which reports "HEAD moved" on the
 * shared worktree and would otherwise let a lane that committed nothing
 * integrate anyway.
 *
 * A commit that turns out to be EMPTY (the content on disk already matches HEAD
 * — a re-run after a crash between write and commit) is not an error: the tree
 * already says what this was trying to say. HEAD is returned unchanged, and the
 * caller records that sha, which is exactly right — it IS the commit carrying
 * this content.
 */
export async function commitPathspec(args: {
  git: GitRunner;
  paths: readonly string[];
  message: string;
  logger?: LoggerLike;
  /** Test seam: the lock backoff base, so a retry test does not sleep for real. */
  backoffMs?: number;
}): Promise<string> {
  const { git, paths, message, logger } = args;
  const backoffMs = args.backoffMs ?? INDEX_LOCK_BACKOFF_MS;
  if (paths.length === 0) throw new Error('commitPathspec requires at least one path');

  // `--` separates paths from revisions, so a file named like a branch cannot be
  // reinterpreted as one.
  await runWithLockRetry(git, ['add', '-f', '--', ...paths], logger, backoffMs);

  const headBefore = (await git(['rev-parse', 'HEAD'])).trim();
  try {
    await runWithLockRetry(git, ['commit', '-m', message, '--', ...paths], logger, backoffMs);
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // git says "nothing to commit" / "no changes added" when the paths already
    // match HEAD. Idempotent by construction — see the doc above.
    if (/nothing to commit|no changes added|nothing added to commit/i.test(text)) {
      logger?.debug('[bootstrapCommit] paths already match HEAD; nothing to commit', {
        paths: paths.join(', '),
      });
      return headBefore;
    }
    throw err;
  }
  return (await git(['rev-parse', 'HEAD'])).trim();
}
