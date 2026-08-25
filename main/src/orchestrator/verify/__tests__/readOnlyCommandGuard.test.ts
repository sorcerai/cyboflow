/**
 * Unit tests for the drafting agent's read-only Bash guard
 * (docs/proposals/lane-runbook-bootstrap.md §8).
 *
 * WHY THESE MATTER MORE THAN THE §7.2 GUARD'S TESTS. The dependency guard is the
 * cheap layer on top of a structural control (the snapshot provisioner clones
 * node_modules, so a contained write is discarded with the snapshot). This guard
 * has no such backstop: the drafting agent surveys the LIVE run worktree, which
 * five sibling lanes are writing to at the same time. So the rule is inverted
 * into an allowlist, and the tests below are mostly about the escapes an
 * allowlist has to close to mean anything.
 *
 * The honest limit is documented in the module and not overclaimed here: this is
 * a strong narrowing, not a sandbox. The structural guarantee lives in §8's
 * inversion — the agent's output is DATA the controller validates and applies —
 * so nothing it could smuggle onto disk reaches the runbook, the commit, or the
 * proof.
 */
import { describe, it, expect } from 'vitest';
import { readOnlyCommandDenyMessage, readOnlyCommandRejection } from '../readOnlyCommandGuard';

describe('readOnlyCommandRejection — allowed', () => {
  it.each([
    'cat package.json',
    'ls -la src',
    'find . -name "vite.config.*"',
    'grep -rn "strictPort" .',
    'head -50 README.md',
    'wc -l src/index.ts',
    'node --version',
    'which pnpm',
    'stat package.json',
    'git log --oneline -5',
    'git show HEAD:package.json',
    'git ls-files "*.config.ts"',
    'git status --porcelain',
    'cat package.json | grep scripts',
    'ls src && cat package.json',
  ])('allows `%s`', (command) => {
    expect(readOnlyCommandRejection(command)).toBeNull();
  });
});

describe('readOnlyCommandRejection — writes', () => {
  it.each([
    ['an unlisted head', 'pnpm install'],
    ['a build', 'pnpm run build'],
    ['a delete', 'rm -rf node_modules'],
    ['a move', 'mv a b'],
    ['a copy', 'cp a b'],
    ['a tee', 'cat x | tee out.txt'],
    ['a writing python', 'python3 -c "open(1,2)"'],
  ])('refuses %s', (_label, command) => {
    expect(readOnlyCommandRejection(command)).not.toBeNull();
  });

  it.each([
    ['redirection', 'cat package.json > stolen.json'],
    ['append redirection', 'echo x >> package.json'],
    ['command substitution', 'cat $(find . -name secret)'],
    ['backticks', 'cat `ls`'],
    ['process substitution', 'diff <(cat a) <(cat b)'],
  ])('refuses %s regardless of an allowlisted head', (_label, command) => {
    // The head of `cat x > y` is `cat`, which is on the list. Checked BEFORE the
    // head so the list cannot be used as a write primitive.
    expect(readOnlyCommandRejection(command)).not.toBeNull();
  });

  it('refuses a writing command hidden after an allowlisted one', () => {
    // Every segment is checked independently — a chain is only as read-only as
    // its worst member.
    expect(readOnlyCommandRejection('ls && rm -rf src')).not.toBeNull();
    expect(readOnlyCommandRejection('cat a; pnpm install')).not.toBeNull();
    expect(readOnlyCommandRejection('cat a\nrm b')).not.toBeNull();
  });

  it('refuses an environment-assignment prefix', () => {
    // `VAR=x cmd` hides the real head, and `LD_PRELOAD=`/`NODE_OPTIONS=` change
    // what the "reader" actually does.
    expect(readOnlyCommandRejection('NODE_OPTIONS=--require=./evil.js node --version')).not.toBeNull();
  });

  it('refuses a path-qualified binary', () => {
    // `./node_modules/.bin/vite` sidesteps the head list entirely.
    expect(readOnlyCommandRejection('./scripts/build.sh')).not.toBeNull();
    expect(readOnlyCommandRejection('/bin/rm -rf .')).not.toBeNull();
  });
});

describe('readOnlyCommandRejection — the readers that can write', () => {
  it.each([
    ['sed -i', 'sed -i "s/a/b/" package.json'],
    ['sed --in-place', 'sed --in-place=bak "s/a/b/" x'],
    ['find -exec', 'find . -name "*.ts" -exec rm {} ;'],
    ['find -delete', 'find . -name "*.log" -delete'],
    ['node -e', 'node -e "require(\'fs\').writeFileSync(\'x\',\'y\')"'],
    ['node --eval=', 'node --eval="process.exit(0)"'],
    ['node -p', 'node -p "1+1"'],
  ])('refuses %s even though its head is allowlisted', (_label, command) => {
    // These are the specific flags that turn a reader into a writer or an
    // executor. `node -e` in particular is the entire shell escape in one flag.
    expect(readOnlyCommandRejection(command)).not.toBeNull();
  });

  it('still allows the read-only forms of those same heads', () => {
    expect(readOnlyCommandRejection('find . -name "*.config.ts"')).toBeNull();
    expect(readOnlyCommandRejection('node --version')).toBeNull();
    expect(readOnlyCommandRejection('grep -rn scripts package.json')).toBeNull();
  });

  it.each([
    // Exec wrappers: the real command is an ARGUMENT, and this guard reads heads.
    'env sh -c "rm -rf x"',
    'env node -e "require(\'fs\').unlinkSync(\'x\')"',
    'command rm -rf x',
    // Interpreters carrying their own write/exec primitives, needing none of the
    // syntax rejected elsewhere in this module.
    'awk \'BEGIN{system("rm -rf x")}\'',
    "sed 'w /tmp/out' package.json",
    // `node <file>` executes whatever that file says, and every repo ships files.
    'node scripts/ensure-sqlite-abi.mjs electron',
    'find . -fls /tmp/out',
  ])('refuses `%s` — the head is not the command', (command) => {
    expect(readOnlyCommandRejection(command)).not.toBeNull();
  });
});

describe('readOnlyCommandRejection — git subcommands whose write form is an argument', () => {
  it.each([
    // Flag-carried writes on a subcommand allowlisted as a read.
    'git branch -D main',
    'git branch -m hijacked',
    'git branch --set-upstream-to=origin/main',
    // Operand-carried writes — `git config user.email x` contains no flag at
    // all, which is why a flag denylist could never have caught it.
    'git config user.email attacker@example.com',
    'git config core.hooksPath /tmp/hooks',
    'git remote remove origin',
    'git remote add evil https://example.com/x.git',
    'git remote set-url origin https://example.com/x.git',
    // Creating a branch is a write too, and it is a bare operand.
    'git branch newbranch',
  ])('refuses `%s`', (command) => {
    expect(readOnlyCommandRejection(command)).not.toBeNull();
  });

  it.each([
    'git config --get user.email',
    'git config --list',
    'git remote show origin',
    'git remote get-url origin',
    'git remote -v',
    'git branch --show-current',
    'git branch -a',
  ])('still allows `%s`', (command) => {
    expect(readOnlyCommandRejection(command)).toBeNull();
  });
});

describe('readOnlyCommandRejection — git', () => {
  it.each([
    'git checkout .',
    'git clean -fd',
    'git stash',
    'git reset --hard',
    'git commit -m x',
    'git add .',
    'git push',
  ])('refuses `%s`', (command) => {
    // `git` is on the head list because reading history is genuinely useful, and
    // it is the single most dangerous head there: checkout/clean/stash/reset all
    // destroy a sibling lane's uncommitted work in a shared worktree.
    expect(readOnlyCommandRejection(command)).not.toBeNull();
  });

  it('refuses a bare `git`', () => {
    expect(readOnlyCommandRejection('git')).not.toBeNull();
  });

  it('refuses the writing forms of an otherwise-readable subcommand', () => {
    expect(readOnlyCommandRejection('git config --unset user.email')).not.toBeNull();
    expect(readOnlyCommandRejection('git config user.email')).toBeNull();
  });
});

describe('readOnlyCommandDenyMessage', () => {
  it('names the command, the rule, and the sanctioned exit', () => {
    // Every clause is load-bearing, in the style of the §7.2 guard's message: an
    // agent denied a shell with no named exit reaches for a different shell. The
    // exit here is `not-possible`, which this whole design is built to accept.
    const message = readOnlyCommandDenyMessage('pnpm install', 'not read-only');
    expect(message).toContain('pnpm install');
    expect(message).toContain('not-possible');
    expect(message).toContain('Read/Grep/Glob');
  });
});
