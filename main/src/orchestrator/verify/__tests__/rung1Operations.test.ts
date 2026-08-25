/**
 * Unit tests for the typed rung-1 operations
 * (docs/proposals/lane-runbook-bootstrap.md §8.1, §15A).
 *
 * This is the one path in the feature whose safety is REVIEW-BACKED rather than
 * structural, so these tests are less about "does the edit work" and more about
 * "does it refuse everything it promised to refuse". Three refusal families get
 * individual attention:
 *
 *  - ESCAPE: an absolute path or a `..` segment reaches outside the run's
 *    worktree entirely, past the denylist and past the branch.
 *  - OVERWRITE: `add-script` replacing an existing script is precisely the
 *    "change what gets built or served" hazard that made rung 1 unsafe to grant
 *    structurally. Adding is fenced; replacing is not.
 *  - AMBIGUITY: two matches is never "pick the first". A port literal that
 *    appears twice is a file the agent has demonstrably not modeled, and
 *    guessing is how a machine edit silently repoints a proxy.
 */
import { describe, it, expect } from 'vitest';
import {
  applyRung1Operation,
  describeRung1Operation,
  normalizeRung1Path,
  RUNG1_DENIED_PATH_PATTERNS,
  validateRung1Target,
} from '../rung1Operations';
import type { Rung1Operation } from '../runbookDraft';

const ADD_SCRIPT: Rung1Operation = {
  kind: 'add-script',
  scriptName: 'verify:serve',
  command: 'vite preview --port ${PORT}',
};

function portOp(file: string, port = 5173): Rung1Operation {
  return { kind: 'port-from-env', file, port, envVar: 'PORT' };
}

function strictOp(file: string, setting = 'strictPort'): Rung1Operation {
  return { kind: 'relax-strict-port', file, setting };
}

describe('validateRung1Target — the denylist folds case, because the filesystem does', () => {
  it.each([
    // macOS is case-insensitive by DEFAULT, so each of these names the same file
    // as its lowercase twin. `.claude/settings.json` in particular decides
    // whether the approval gate binds at all.
    '.Claude/settings.json',
    '.GitHub/workflows/ci.yml',
    'Scripts/build.js',
    '.CyboFlow/verify-runbook.json',
    'PNPM-lock.yaml',
    // Executed-on-checkout surfaces, added with the case fix.
    '.git/config',
    '.husky/pre-commit',
  ])('refuses `%s`', (file) => {
    const result = validateRung1Target({ kind: 'relax-strict-port', file, setting: 'strictPort' });
    expect(result.ok).toBe(false);
  });

  it('still admits an ordinary config file', () => {
    expect(validateRung1Target({ kind: 'relax-strict-port', file: 'vite.config.ts', setting: 'strictPort' }).ok).toBe(
      true,
    );
  });
});

describe('normalizeRung1Path', () => {
  it('normalizes a relative path and its separators', () => {
    expect(normalizeRung1Path('./apps\\web/vite.config.ts')).toEqual({
      ok: true,
      path: 'apps/web/vite.config.ts',
    });
  });

  it.each([
    ['an absolute POSIX path', '/etc/hosts'],
    ['an absolute Windows path', 'C:/Windows/System32/drivers/etc/hosts'],
    ['a traversal', '../../../.ssh/config'],
    ['a traversal buried mid-path', 'apps/../../other-project/vite.config.ts'],
    ['an empty path', '   '],
  ])('refuses %s', (_label, file) => {
    // Escape is THE failure mode: past the denylist, past the branch, into
    // another checkout. Rejected outright rather than resolved and re-checked,
    // because a normalize-then-validate step is where traversal bugs live.
    expect(normalizeRung1Path(file).ok).toBe(false);
  });
});

describe('validateRung1Target — the denylist', () => {
  it.each([
    ['a lockfile', 'pnpm-lock.yaml'],
    ['a nested lockfile', 'apps/web/package-lock.json'],
    ['GitHub Actions', '.github/workflows/ci.yml'],
    ['agent permissions', '.claude/settings.json'],
    ["cyboflow's own state", '.cyboflow/verify-runbook.json'],
    ['repo scripts', 'scripts/release.mjs'],
  ])('refuses %s', (_label, file) => {
    expect(validateRung1Target(portOp(file)).ok).toBe(false);
  });

  it('every denied pattern is anchored so it cannot match a mere substring', () => {
    // `scripts/` must not match `src/scripts-helper.ts`, and `.claude/` must not
    // match `docs/dotclaude.md`. A denylist that over-matches is a denylist
    // nobody can keep, and one that under-matches is not a denylist at all.
    const innocuous = ['src/scripts-helper.ts', 'docs/dotclaude.md', 'app/pnpm-lock.yaml.md'];
    for (const path of innocuous) {
      expect(RUNG1_DENIED_PATH_PATTERNS.some((p) => p.test(path))).toBe(false);
    }
  });

  it('confines package.json edits to add-script, and add-script to package.json', () => {
    // package.json changes are confined to `scripts`, and add-script is the only
    // operation that can express that confinement — a textual substitution
    // inside a manifest would be an arbitrary JSON edit wearing a narrow
    // operation's name.
    expect(validateRung1Target(portOp('package.json')).ok).toBe(false);
    expect(validateRung1Target(ADD_SCRIPT)).toEqual({ ok: true, path: 'package.json' });
  });

  it('fences a WORKSPACE manifest too, not just the root one', () => {
    // Matched on the basename rather than the root path. `relax-strict-port` has
    // no extension rule of its own — unlike `port-from-env`, which only writes
    // JavaScript — so without this it would happily flip a boolean inside
    // `apps/web/package.json`: an arbitrary JSON edit wearing a narrow
    // operation's name. Caught by this test before it shipped.
    expect(validateRung1Target(strictOp('apps/web/package.json')).ok).toBe(false);
    expect(validateRung1Target(portOp('packages/ui/package.json')).ok).toBe(false);
  });
});

describe('applyRung1Operation — add-script', () => {
  const manifest = JSON.stringify({ name: 'app', scripts: { build: 'vite build' } }, null, 2) + '\n';

  it('adds the key and leaves everything else alone', () => {
    const result = applyRung1Operation(ADD_SCRIPT, manifest, 'package.json');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const parsed = JSON.parse(result.content) as { name: string; scripts: Record<string, string> };
    expect(parsed.name).toBe('app');
    expect(parsed.scripts).toEqual({ build: 'vite build', 'verify:serve': 'vite preview --port ${PORT}' });
  });

  it('NEVER overwrites an existing script', () => {
    // The single most important rule in this file. Overwriting `build` or `dev`
    // is exactly "change what gets built or served" — the hazard §15A concedes
    // cannot be ruled out structurally, and the one this operation is fenced
    // against. A project that already has the script does not need this at all.
    const result = applyRung1Operation(
      { kind: 'add-script', scriptName: 'build', command: 'rm -rf /' },
      manifest,
      'package.json',
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('already declares');
  });

  it('adds a scripts block to a manifest that has none', () => {
    const result = applyRung1Operation(ADD_SCRIPT, '{"name":"app"}\n', 'package.json');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect((JSON.parse(result.content) as { scripts: Record<string, string> }).scripts['verify:serve']).toBe(
      'vite preview --port ${PORT}',
    );
  });

  it('preserves the file\'s own indentation and trailing newline', () => {
    // A one-line change should read as a one-line diff. A rewrite that reformats
    // the manifest buries the actual edit in noise, in a commit whose whole
    // purpose is being reviewable.
    const tabbed = JSON.stringify({ name: 'app', scripts: {} }, null, '\t') + '\n';
    const result = applyRung1Operation(ADD_SCRIPT, tabbed, 'package.json');
    if (!result.ok) throw new Error('unreachable');
    expect(result.content).toContain('\t"scripts"');
    expect(result.content.endsWith('\n')).toBe(true);

    const noNewline = JSON.stringify({ name: 'app' }, null, 2);
    const result2 = applyRung1Operation(ADD_SCRIPT, noNewline, 'package.json');
    if (!result2.ok) throw new Error('unreachable');
    expect(result2.content.endsWith('\n')).toBe(false);
  });

  it.each([
    ['unparseable JSON', '{ not json'],
    ['a JSON array', '[]'],
    ['a scripts key that is not an object', '{"scripts": "vite build"}'],
  ])('refuses %s', (_label, content) => {
    expect(applyRung1Operation(ADD_SCRIPT, content, 'package.json').ok).toBe(false);
  });
});

describe('applyRung1Operation — port-from-env', () => {
  const config = 'export default {\n  server: { port: 5173 },\n};\n';

  it('replaces the literal with an env read that KEEPS the original as a fallback', () => {
    // The project must behave identically for a human running `pnpm dev` by
    // hand. Deleting the default would change behavior for the project's own
    // developers, which is not a change a machine gets to make on its own.
    const result = applyRung1Operation(portOp('vite.config.ts'), config, 'vite.config.ts');
    if (!result.ok) throw new Error('unreachable');
    expect(result.content).toContain('port: Number(process.env.PORT ?? 5173)');
  });

  it('refuses when the literal occurs more than once', () => {
    const twice = 'export default {\n  server: { port: 5173 },\n  proxy: { target: "http://x:5173" },\n};\n';
    const result = applyRung1Operation(portOp('vite.config.ts'), twice, 'vite.config.ts');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('2 times');
  });

  it('refuses when the literal does not occur at all', () => {
    expect(applyRung1Operation(portOp('vite.config.ts', 3000), config, 'vite.config.ts').ok).toBe(false);
  });

  it('does not match a port hiding inside a longer number or an identifier', () => {
    // `5173` must not match inside `15173` or `port5173` — a substring
    // replacement there produces syntactically valid nonsense.
    const decoy = 'export default { server: { port: 15173 }, name: "port5173" };\n';
    expect(applyRung1Operation(portOp('vite.config.ts'), decoy, 'vite.config.ts').ok).toBe(false);
  });

  it('refuses a file it cannot write JavaScript into', () => {
    // The operation emits a JS expression; a JSON config cannot hold one, and
    // writing it anyway would produce a file nothing can parse.
    expect(applyRung1Operation(portOp('app.json'), '{"port":5173}', 'app.json').ok).toBe(false);
  });

  it('refuses an env-var name that is not an identifier', () => {
    const result = applyRung1Operation(
      { kind: 'port-from-env', file: 'v.ts', port: 5173, envVar: 'PORT; rm -rf /' },
      config,
      'v.ts',
    );
    expect(result.ok).toBe(false);
  });
});

describe('applyRung1Operation — relax-strict-port', () => {
  it.each([
    ['a bare key', 'export default { server: { strictPort: true } };'],
    ['a double-quoted key', '{ "strictPort": true }'],
    ["a single-quoted key", "{ 'strictPort': true }"],
    ['loose whitespace', 'export default { strictPort   :   true };'],
  ])('flips %s', (_label, content) => {
    const result = applyRung1Operation(strictOp('vite.config.ts'), content, 'vite.config.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.content).toContain('false');
    expect(result.content).not.toContain('true');
  });

  it('refuses when the setting occurs more than once', () => {
    const twice = '{ strictPort: true, dev: { strictPort: true } }';
    expect(applyRung1Operation(strictOp('v.ts'), twice, 'v.ts').ok).toBe(false);
  });

  it('refuses when the setting is not there', () => {
    expect(applyRung1Operation(strictOp('v.ts'), '{ port: 5173 }', 'v.ts').ok).toBe(false);
  });

  it('refuses a setting name that is not an identifier', () => {
    expect(applyRung1Operation(strictOp('v.ts', 'a.*b'), '{ ab: true }', 'v.ts').ok).toBe(false);
  });

  it('leaves the rest of the line untouched', () => {
    const content = 'export default { server: { host: true, strictPort: true, open: true } };';
    const result = applyRung1Operation(strictOp('v.ts'), content, 'v.ts');
    if (!result.ok) throw new Error('unreachable');
    expect(result.content).toBe('export default { server: { host: true, strictPort: false, open: true } };');
  });
});

describe('describeRung1Operation', () => {
  it('names the file and the change, for the human reading the merge gate', () => {
    // This sentence IS the review surface §15A leans on, so it must say what was
    // done to which file — not the operation's internal name.
    expect(describeRung1Operation(ADD_SCRIPT)).toContain('package.json');
    expect(describeRung1Operation(portOp('vite.config.ts'))).toContain('vite.config.ts');
    expect(describeRung1Operation(strictOp('vite.config.ts'))).toContain('vite.config.ts');
  });
});
