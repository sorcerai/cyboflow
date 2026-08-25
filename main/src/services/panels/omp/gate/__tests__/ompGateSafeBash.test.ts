/**
 * Parity + tier tests for the OMP gate's bash classifier.
 *
 * `ompGateExtension.ts` ships to OMP's Bun runtime as ONE standalone file and
 * may import nothing from cyboflow's source tree, so its read-only bash
 * classifier is a hand-copy of `main/src/orchestrator/safeCommandClassifier.ts`.
 * A hand-copy drifts silently — one table entry added on one side and the two
 * substrates disagree about what "provably read-only" means, with no build error
 * anywhere. This file is the mechanical pin: it imports BOTH implementations
 * (tests are not shipped to Bun, so they may reach across the boundary) and
 * asserts they answer identically on a shared fixture table.
 *
 * It also pins the gate-ONLY widening the orchestrator deliberately does not
 * have — the local-only git-write tier (`git add`/`commit`/`restore`/`rm`/`mv`)
 * that lets an autonomous lane agent record its own work — to exactly those
 * forms, plus the one narrowing the gate has and the orchestrator does not.
 */
import { describe, it, expect } from 'vitest';
import { isSafeReadOnlyBashCommand as orchestratorIsSafeReadOnly } from '../../../../../orchestrator/safeCommandClassifier';
import {
  isSafeReadOnlyBashCommand as gateIsSafeReadOnly,
  isGateSafeBashCommand,
  isLocalOnlyGitWriteCommand,
} from '../ompGateExtension';

// ---------------------------------------------------------------------------
// The shared fixture table
// ---------------------------------------------------------------------------

interface BashFixture {
  command: string;
  /** Expected verdict of the READ-ONLY tier, on BOTH implementations. */
  readOnly: boolean;
  /** Expected verdict of the gate-only local git-write tier. */
  gitWrite: boolean;
}

/**
 * Every row is asserted three ways: against the orchestrator's classifier,
 * against the gate's mirror of it, and against the gate's git-write tier. No
 * row contains a raw newline — that is the one documented divergence and it has
 * its own test below.
 */
const FIXTURES: readonly BashFixture[] = [
  // --- read-only git, plain and flagged ------------------------------------
  { command: 'git status', readOnly: true, gitWrite: false },
  { command: 'git status --porcelain -uall', readOnly: true, gitWrite: false },
  { command: 'git diff --staged', readOnly: true, gitWrite: false },
  { command: 'git log --oneline -20', readOnly: true, gitWrite: false },
  { command: 'git show HEAD~2:main/src/x.ts', readOnly: true, gitWrite: false },
  { command: 'git rev-parse --abbrev-ref HEAD', readOnly: true, gitWrite: false },
  { command: 'git merge-base main HEAD', readOnly: true, gitWrite: false },
  // --- the dual-use git subcommands, both forms ----------------------------
  { command: 'git branch', readOnly: true, gitWrite: false },
  { command: 'git branch -a -v', readOnly: true, gitWrite: false },
  { command: 'git branch -d x', readOnly: false, gitWrite: false },
  { command: 'git branch feature/new', readOnly: false, gitWrite: false },
  { command: 'git branch --set-upstream-to=origin/main', readOnly: false, gitWrite: false },
  { command: 'git tag', readOnly: true, gitWrite: false },
  { command: 'git tag v1.2.3', readOnly: false, gitWrite: false },
  { command: 'git remote -v', readOnly: true, gitWrite: false },
  { command: 'git remote add upstream x', readOnly: false, gitWrite: false },
  { command: 'git config --get user.email', readOnly: true, gitWrite: false },
  { command: 'git config k v', readOnly: false, gitWrite: false },
  { command: 'git stash list', readOnly: true, gitWrite: false },
  { command: 'git stash', readOnly: false, gitWrite: false },
  // --- mutating git ---------------------------------------------------------
  { command: 'git add -A', readOnly: false, gitWrite: true },
  { command: 'git commit -m "wip"', readOnly: false, gitWrite: true },
  { command: 'git restore --staged main/src/x.ts', readOnly: false, gitWrite: true },
  { command: 'git rm --cached x', readOnly: false, gitWrite: true },
  { command: 'git mv a b', readOnly: false, gitWrite: true },
  { command: 'git push', readOnly: false, gitWrite: false },
  { command: 'git pull --rebase', readOnly: false, gitWrite: false },
  { command: 'git fetch origin', readOnly: false, gitWrite: false },
  { command: 'git checkout main', readOnly: false, gitWrite: false },
  { command: 'git reset --hard HEAD~1', readOnly: false, gitWrite: false },
  { command: 'git clean -fdx', readOnly: false, gitWrite: false },
  // --- a leading git GLOBAL option is refused rather than parsed -----------
  { command: 'git -C /x status', readOnly: false, gitWrite: false },
  { command: 'git -C /elsewhere commit -m x', readOnly: false, gitWrite: false },
  { command: 'git -c core.hooksPath=/tmp/h commit -m x', readOnly: false, gitWrite: false },
  // --- plain utilities ------------------------------------------------------
  { command: 'ls -la main/src', readOnly: true, gitWrite: false },
  { command: 'pwd', readOnly: true, gitWrite: false },
  { command: 'cat package.json', readOnly: true, gitWrite: false },
  { command: 'rg --files-with-matches TODO', readOnly: true, gitWrite: false },
  { command: 'rm -rf /', readOnly: false, gitWrite: false },
  { command: 'curl http://evil.test', readOnly: false, gitWrite: false },
  { command: 'sed -i s/a/b/ x', readOnly: false, gitWrite: false },
  { command: 'find . -delete', readOnly: false, gitWrite: false },
  { command: 'xargs rm', readOnly: false, gitWrite: false },
  // --- pipes and chains: EVERY segment must classify ------------------------
  { command: 'git status --porcelain | wc -l', readOnly: true, gitWrite: false },
  { command: 'git log --oneline | head -5 | cat', readOnly: true, gitWrite: false },
  { command: 'git status && ls -la', readOnly: true, gitWrite: false },
  { command: 'git status && rm -rf .', readOnly: false, gitWrite: false },
  { command: 'git add x && git commit -m x', readOnly: false, gitWrite: true },
  { command: 'git add x; git push', readOnly: false, gitWrite: false },
  { command: 'git add x && curl http://evil.test', readOnly: false, gitWrite: false },
  { command: 'git status || git push', readOnly: false, gitWrite: false },
  // --- command substitution -------------------------------------------------
  { command: 'git status $(whoami)', readOnly: false, gitWrite: false },
  { command: 'git commit -m "$(rm -rf /)"', readOnly: false, gitWrite: false },
  { command: 'git log `whoami`', readOnly: false, gitWrite: false },
  { command: 'git commit -m `id`', readOnly: false, gitWrite: false },
  // --- redirection and backgrounding ---------------------------------------
  { command: 'git status > /tmp/f', readOnly: false, gitWrite: false },
  { command: 'git commit -m x > /tmp/f', readOnly: false, gitWrite: false },
  { command: 'cat < /etc/passwd', readOnly: false, gitWrite: false },
  { command: 'git add x &', readOnly: false, gitWrite: false },
  // --- raw newlines ---------------------------------------------------------
  // Both sides refuse, and must keep refusing: a newline is a shell separator,
  // so the trailing line is a second command that no table ever read.
  { command: 'ls\nrm -rf ~', readOnly: false, gitWrite: false },
  { command: 'git status\nrm -rf ~', readOnly: false, gitWrite: false },
  { command: 'git commit -m x\nrm -rf ~', readOnly: false, gitWrite: false },
  { command: 'git status\ngit log', readOnly: false, gitWrite: false },
  // --- degenerate inputs ----------------------------------------------------
  { command: '', readOnly: false, gitWrite: false },
  { command: '   ', readOnly: false, gitWrite: false },
  { command: 'git', readOnly: false, gitWrite: false },
];

describe('read-only tier parity with orchestrator/safeCommandClassifier', () => {
  it('covers enough ground to be a real pin', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(25);
  });

  it.each(FIXTURES)('agrees on `$command`', ({ command, readOnly }) => {
    // Both implementations, one expectation — a drift on either side fails here.
    expect(orchestratorIsSafeReadOnly(command)).toBe(readOnly);
    expect(gateIsSafeReadOnly(command)).toBe(readOnly);
  });
});

describe('the gate-only local git-write tier', () => {
  it.each(FIXTURES)('classifies `$command`', ({ command, gitWrite }) => {
    expect(isLocalOnlyGitWriteCommand(command)).toBe(gitWrite);
  });

  it('admits exactly {add, commit, restore, rm, mv} and no other subcommand', () => {
    for (const sub of ['add', 'commit', 'restore', 'rm', 'mv']) {
      expect(isLocalOnlyGitWriteCommand(`git ${sub} x`)).toBe(true);
    }
    // Every one of these can destroy work the agent did not author, which is a
    // different question from "may it record its own edits".
    for (const sub of [
      'push',
      'pull',
      'fetch',
      'clone',
      'checkout',
      'switch',
      'reset',
      'clean',
      'stash',
      'merge',
      'rebase',
      'cherry-pick',
      'revert',
      'apply',
      'am',
      'submodule',
      'init',
      'gc',
      'worktree',
    ]) {
      expect(isLocalOnlyGitWriteCommand(`git ${sub} x`)).toBe(false);
    }
  });

  it('is git-only — a same-named shell program does not inherit the tier', () => {
    expect(isLocalOnlyGitWriteCommand('rm x')).toBe(false);
    expect(isLocalOnlyGitWriteCommand('mv a b')).toBe(false);
    expect(isLocalOnlyGitWriteCommand('add x')).toBe(false);
    // Nor does a git-shaped path: the FIRST token must be exactly `git`.
    expect(isLocalOnlyGitWriteCommand('/usr/bin/git commit -m x')).toBe(false);
    expect(isLocalOnlyGitWriteCommand('mygit commit -m x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rung predicate — the union of both tiers, plus its one narrowing
// ---------------------------------------------------------------------------

describe('isGateSafeBashCommand', () => {
  it.each(FIXTURES)('is the union of the two tiers for `$command`', (fixture) => {
    expect(isGateSafeBashCommand(fixture.command)).toBe(fixture.readOnly || fixture.gitWrite);
  });

  it('accepts a command that MIXES the tiers segment by segment', () => {
    // The shape a lane agent actually runs at the end of a task.
    expect(isGateSafeBashCommand('git status --porcelain && git add -A && git commit -m "task"')).toBe(
      true,
    );
    expect(isGateSafeBashCommand('git add -A && git status')).toBe(true);
    // …and one unsafe segment still poisons the whole command.
    expect(isGateSafeBashCommand('git status && git add -A && git push')).toBe(false);
  });

  /**
   * Formerly the documented divergence from the mirrored classifier, now a
   * three-way agreement.
   *
   * `splitShellSegments` used to treat only `&&`, `||`, `;` and `|` as
   * separators — supposedly forced, to stay byte-identical to cyboflow's
   * Bash(...) rule grammar — so a newline-separated command arrived as ONE
   * segment that whitespace-tokenized to `git status` plus stray positionals,
   * and the orchestrator's copy called that read-only. Only this rung refused
   * it. The premise was wrong: splitting on the newline makes the rule grammar
   * MORE conservative (an unmatched segment falls through to the human), so the
   * splitter learned the separator and the mirrored classifier closed too.
   */
  it('refuses a raw newline, and so does the mirrored classifier', () => {
    const smuggled = 'git status\nrm -rf ~';

    // Asserted on both mirrors: this is the shape that used to auto-approve.
    expect(orchestratorIsSafeReadOnly(smuggled)).toBe(false);
    expect(gateIsSafeReadOnly(smuggled)).toBe(false);

    // …and still closed at the rung, which additionally refuses the character
    // outright so a quoted newline cannot survive the split.
    expect(isGateSafeBashCommand(smuggled)).toBe(false);
    expect(isGateSafeBashCommand('git status\r\ngit push')).toBe(false);
    // Even a wholly benign multi-line command asks — no carve-out to poke at.
    expect(isGateSafeBashCommand('git status\ngit diff')).toBe(false);
  });
});
