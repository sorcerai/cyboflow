/**
 * The read-only Bash guard for the runbook-DRAFTING agent
 * (docs/proposals/lane-runbook-bootstrap.md §8).
 *
 * WHY AN ALLOWLIST, WHEN THE §7.2 DEPENDENCY GUARD IS A DENYLIST. The dependency
 * guard's own module doc is explicit that a regex over shell strings is
 * bypassable by indirection, and that it is only the cheap layer on top of a
 * STRUCTURAL control — the snapshot provisioner cloning `node_modules`, so a
 * contained write is thrown away with the snapshot. The drafting agent has no
 * such containment: it surveys the LIVE run worktree, because that is the tree
 * whose package scripts and config it has to read, and five sibling lanes are
 * writing there concurrently. A denylist would be the only control, and a
 * denylist as the only control is exactly the posture §8 rejects.
 *
 * So the rule here is inverted: a command runs only if EVERY segment of it has a
 * head this module recognizes as read-only. Anything unrecognized — a project's
 * own tooling, a clever one-liner, a binary this list has never heard of — is
 * refused. That is deliberately restrictive, and the cost is bounded and known:
 * the agent falls back to `Read`/`Grep`/`Glob` (which it has), or it returns
 * `NOT-POSSIBLE`, which is a legitimate outcome rather than a failure.
 *
 * WHAT IT STILL CANNOT PROMISE. A shell is a shell: an allowlisted reader
 * pointed at a fifo, an `env` with an assignment prefix, a `find -exec`. The
 * specific escapes this module knows about are closed below (no redirection, no
 * substitution, no `-exec`, no in-place `sed`), and the honest statement is that
 * this is a strong narrowing rather than a sandbox. The structural guarantee for
 * this feature lives elsewhere — the agent's proposals are DATA the controller
 * validates and applies (§8), so nothing it could smuggle onto disk reaches the
 * runbook, the commit, or the proof.
 *
 * PURE — one exported predicate over a command string, so every rule below is
 * testable against a literal.
 */

/**
 * Command heads that only READ. Kept short on purpose: each entry is a promise
 * that this binary, invoked without the syntax rejected below, cannot modify the
 * worktree.
 */
/**
 * NOT ON THIS LIST, DELIBERATELY, AND THE REASON MATTERS MORE THAN THE ENTRIES.
 *
 * `env` and `command` are EXEC WRAPPERS: they take the real command as an
 * argument, and this module only ever inspects a segment's head. `env sh -c '…'`
 * defeats the entire allowlist in one token, and `env node -e …` defeats the
 * per-head flag bans below, which key on the head. A wrapper on a list of
 * readers is a hole in the shape of a list entry.
 *
 * `awk` and `sed` carry their own write and exec primitives that need none of
 * the syntax rejected below: `awk 'BEGIN{system("…")}'` and `sed 'w file'`. They
 * were removed rather than pattern-matched, because a guard that enumerates the
 * spellings it thought of is exactly the failure this module is written against
 * — and `grep`/`Read`/`Glob` cover what a survey actually needs.
 */
const READ_ONLY_HEADS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'ls',
  'find',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'stat',
  'file',
  'du',
  'pwd',
  'echo',
  'printf',
  'test',
  'true',
  'false',
  'which',
  'type',
  'node',
  'jq',
  'yq',
  'git',
  'json',
  'diff',
  'tree',
]);

/**
 * The only `git` subcommands this guard admits. `git` is on the head list
 * because reading the project's history is genuinely useful for deriving a
 * runbook (which script did the last release use?), and it is the single most
 * dangerous head on that list — `git checkout`, `git clean`, `git stash` and
 * `git reset` all destroy a sibling lane's uncommitted work. So the head check
 * alone is not enough for it.
 */
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'log',
  'show',
  'status',
  'diff',
  'ls-files',
  'ls-tree',
  'rev-parse',
  'describe',
  'blame',
  'cat-file',
  'config', // reads only — the `--set`/`--unset` forms are rejected as flags below
  'branch',
  'remote',
]);

/** `git config --set`-style mutations, and the flags that make a read a write. */
const GIT_WRITE_FLAGS = new Set(['--set', '--unset', '--unset-all', '--add', '--replace-all', '--edit', '-e']);

/**
 * Per-subcommand argument allowlists, for the three subcommands whose READ form
 * and WRITE form differ only in their arguments.
 *
 * The subcommand allowlist above is necessary and was not sufficient: `git
 * branch -D main` deletes, `git branch -m` renames the branch five lanes are
 * committing to, `git remote remove origin` unhooks the repo, and `git config
 * user.email x` writes with no flag at all — its write form is POSITIONAL, which
 * is why a flag denylist could never have caught it.
 *
 * Expressed as "these arguments and no others", so a form nobody here thought of
 * is refused rather than admitted.
 */
interface GitArgRule {
  /** Tokens admitted verbatim — read flags, and the read sub-verbs of `remote`. */
  readonly allowed: readonly string[];
  /** How many bare operands the READ form needs. Every write form needs more. */
  readonly maxPositionals: number;
}

const GIT_SUBCOMMAND_ARG_RULES: Record<string, GitArgRule> = {
  // No operand at all: `git branch <name>` CREATES one and `git branch -D <name>`
  // deletes one, so a bare operand is never a read.
  branch: {
    allowed: [
      '--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose',
      '--show-current', '--merged', '--no-merged', '--format', '--sort',
    ],
    maxPositionals: 0,
  },
  // `git remote show origin` / `get-url origin` — one operand, the remote's name.
  // `add`/`remove`/`rename`/`set-url` all need two or more and fall out here.
  remote: { allowed: ['-v', '--verbose', 'show', 'get-url'], maxPositionals: 1 },
  // `git config --get <key>` reads one key; `git config <key> <value>` writes,
  // and its write-ness is carried ENTIRELY by the operand count.
  config: {
    allowed: ['--get', '--get-all', '--get-regexp', '--list', '-l', '--local', '--global', '--show-origin'],
    maxPositionals: 1,
  },
};

/**
 * Syntax that makes ANY command a potential write, regardless of its head:
 * redirection, command substitution, and process substitution. Rejected before
 * the head check, because the head of `cat x > y` is `cat`.
 *
 * `2>&1` is deliberately included in this refusal rather than special-cased —
 * an agent that wants stderr can read it from the tool result.
 */
const WRITE_SYNTAX_PATTERN = /(>>?|<\(|>\(|\$\(|`)/;

/** Segment separators. Every segment's head is checked independently. */
const SEGMENT_SEPARATOR = /\|\||&&|;|\||\n/;

/** Flags that turn an allowlisted reader into a writer or an executor. */
const PER_HEAD_FORBIDDEN_FLAGS: Record<string, readonly string[]> = {
  // `sed -i` edits in place; `find -exec`/`-delete` run or remove things;
  // `node -e`/`--eval`/`-p` executes arbitrary code, which is the whole shell
  // escape in one flag.
  sed: ['-i', '--in-place'],
  find: ['-exec', '-execdir', '-delete', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'],
};

/**
 * Heads admitted ONLY in an exact set of forms. `node <file>` executes whatever
 * that file says — and a repo's own tooling is the easiest thing in the world to
 * point at (this project ships a script that rewrites a mapped `.node` in
 * place). The one genuinely useful read is the version, so that is the only form
 * that survives.
 */
const EXACT_FORMS_ONLY: Record<string, readonly string[]> = {
  node: ['--version', '-v'],
};

/** Why a command was refused, or `null` when it is allowed. */
export function readOnlyCommandRejection(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return 'empty command';

  if (WRITE_SYNTAX_PATTERN.test(trimmed)) {
    return 'redirection and command substitution are not available to this agent — it may only read';
  }

  const segments = trimmed
    .split(SEGMENT_SEPARATOR)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return 'empty command';

  for (const segment of segments) {
    const rejection = rejectSegment(segment);
    if (rejection !== null) return rejection;
  }
  return null;
}

function rejectSegment(segment: string): string | null {
  const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
  const head = tokens[0];
  if (head === undefined) return 'empty command';

  // `VAR=value cmd …` — an assignment prefix hides the real head, and
  // `LD_PRELOAD=` / `NODE_OPTIONS=` in particular change what the "reader" does.
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
    return `environment assignments are not available to this agent (in \`${segment}\`)`;
  }
  // A path-qualified binary sidesteps the head list entirely.
  if (head.includes('/')) {
    return `only plain command names are available to this agent, not paths (in \`${segment}\`)`;
  }
  if (!READ_ONLY_HEADS.has(head)) {
    return `\`${head}\` is not one of the read-only commands this agent may run`;
  }

  const exactForms = EXACT_FORMS_ONLY[head];
  if (exactForms !== undefined) {
    const rest = tokens.slice(1);
    if (rest.length !== 1 || !exactForms.includes(rest[0])) {
      return `\`${head}\` is available only as ${exactForms.map((f) => `\`${head} ${f}\``).join(' or ')}`;
    }
  }

  const forbidden = PER_HEAD_FORBIDDEN_FLAGS[head];
  if (forbidden !== undefined) {
    for (const token of tokens.slice(1)) {
      // Compare on the flag itself so `--eval=x` is caught alongside `--eval x`.
      const flag = token.split('=')[0];
      if (forbidden.includes(flag)) {
        return `\`${head} ${flag}\` can modify or execute, so it is not available to this agent`;
      }
    }
  }

  if (head === 'git') {
    const sub = tokens[1];
    if (sub === undefined || !READ_ONLY_GIT_SUBCOMMANDS.has(sub)) {
      return sub === undefined
        ? '`git` needs a read-only subcommand (log, show, status, diff, ls-files, rev-parse, …)'
        : `\`git ${sub}\` is not a read-only git subcommand`;
    }
    for (const token of tokens.slice(2)) {
      if (GIT_WRITE_FLAGS.has(token.split('=')[0])) {
        return `\`git ${sub} ${token}\` writes, so it is not available to this agent`;
      }
    }
    // Subcommands whose write form is an ARGUMENT rather than a flag: allowlist
    // the read arguments and refuse everything else, including bare positionals
    // (`git config user.email x` is a write with no flag in it anywhere).
    const rule = GIT_SUBCOMMAND_ARG_RULES[sub];
    if (rule !== undefined) {
      let positionals = 0;
      for (const token of tokens.slice(2)) {
        if (rule.allowed.includes(token.split('=')[0])) continue;
        if (token.startsWith('-')) {
          return `\`git ${sub} ${token}\` is not one of the read-only forms of \`git ${sub}\``;
        }
        positionals += 1;
        if (positionals > rule.maxPositionals) {
          return `\`git ${sub}\` takes no more than ${rule.maxPositionals} argument(s) in its read form`;
        }
      }
    }
  }

  return null;
}

/**
 * The deny message handed back to the agent.
 *
 * Written FOR THE AGENT, in the same style as the §7.2 dependency guard's: it
 * names the command back (the agent may have composed it several turns ago), it
 * states the rule and why the rule exists, and — crucially — it names the
 * SANCTIONED EXIT. Without that last clause an agent denied a shell reaches for
 * a different shell; with it, it either uses its read tools or returns
 * `NOT-POSSIBLE`, which is a legitimate answer this whole design is built to
 * accept.
 */
export function readOnlyCommandDenyMessage(command: string, reason: string): string {
  return [
    `Blocked: \`${command}\` — ${reason}.`,
    'You are SURVEYING this project, not changing it: you have no Write, no Edit, and no writing shell.',
    'Everything you propose is returned as structured data and applied by the harness after validation.',
    'Use Read/Grep/Glob (or a read-only command) instead — and if this project genuinely cannot be stood up',
    'with levers it already honors, return decision "not-possible" with the reason. That is a correct answer here.',
  ].join(' ');
}
