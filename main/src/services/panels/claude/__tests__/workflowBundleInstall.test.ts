/**
 * Unit tests for workflowBundleInstall (IDEA-013 rung-(ii), B6).
 *
 * Covers the substrate-shared install seam's two fail-soft responsibilities:
 *   (1) ensureBundleExcluded — appends the cyboflow bundle globs + marker to the
 *       worktree's LOCAL git exclude (`$GIT_DIR/info/exclude`) so generated
 *       cyboflow-*.md files never leak into the run diff or a commit. Idempotent,
 *       trailing-newline-safe, and fail-soft on a non-git path.
 *   (2) installWorkflowBundle — never throws into a spawn: a DB-miss resolves to
 *       an empty bundle (no write) and a throwing writer is caught + logged.
 *
 * agentOverlayWriter is mocked out — it bridges the full built-in agent catalogue
 * and is exercised by its own suite; here we isolate the install/exclude seam.
 *
 * Hermetic: each test uses a fresh os.tmpdir() worktree (git-inited where the
 * exclude path is needed) and a hand-rolled better-sqlite3 stub, so no schema or
 * agent-catalogue coupling leaks in.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type Database from 'better-sqlite3';

// agentOverlayWriter pulls in the whole built-in agent catalogue — stub it so
// these tests isolate the exclude + fail-soft seam.
vi.mock('../agentOverlayWriter', () => ({ installAgentOverlay: vi.fn() }));

/**
 * resolveRunFrozenSpec is mocked so the stage-script tests can pin the run's
 * EFFECTIVE (frozen / variant) spec independently of the live workflows row —
 * that distinction is the point of one of them. `frozen.value` is null by
 * default, which is the "no frozen revision" fallback the real helper returns.
 */
const frozen = vi.hoisted(() => ({ value: null as { workflowName: string; specJson: string | null } | null }));
vi.mock('../../../../orchestrator/runFrozenSpec', () => ({
  resolveRunFrozenSpec: () => frozen.value,
}));

/**
 * child_process is mocked ONLY so a single test can force a git failure that is
 * NOT "not a git repository" (the one class ensureBundleExcluded still warns
 * about). `impl` is null everywhere else, in which case the real execFileSync
 * runs — this file's own `git init` helper depends on that pass-through, so the
 * reset belongs at the TOP of each beforeEach, ahead of initGitRepo.
 */
const execFileSyncOverride = vi.hoisted(() => ({ impl: null as (() => never) | null }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) =>
      execFileSyncOverride.impl
        ? execFileSyncOverride.impl()
        : (actual.execFileSync as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

import { installWorkflowBundle } from '../workflowBundleInstall';
import { installAgentOverlay } from '../agentOverlayWriter';
import { WorkflowBundleWriter } from '../workflowBundleWriter';
import { fanOutBatchWorkflowName } from '../../../../orchestrator/prompts/fanOutStageScript';
import type { WorkflowBundle } from '../../../../orchestrator/workflows/workflowBundle';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

const MARKER = '# cyboflow: generated agent/command bundle (not user code)';
const GLOBS = ['.claude/agents/cyboflow-*.md', '.claude/commands/cyboflow-*.md'];

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
}

function excludePath(worktree: string): string {
  return path.join(worktree, '.git', 'info', 'exclude');
}

/**
 * A better-sqlite3 stub whose single prepared statement's .get() returns `row`.
 * getRunWorkflowPath is the only consumer of `db` (installAgentOverlay is mocked).
 * When `throwOnPrepare` is set, prepare throws to exercise the DB-error branch.
 */
function makeDbStub(
  row: { workflowPath?: unknown } | undefined,
  throwOnPrepare = false,
): Database.Database {
  return {
    prepare: () => {
      if (throwOnPrepare) throw new Error('db exploded');
      return { get: () => row };
    },
  } as unknown as Database.Database;
}

/** A writer whose write() throws, to prove installWorkflowBundle never propagates it. */
function makeThrowingWriter(): WorkflowBundleWriter {
  return {
    write: () => {
      throw new Error('writer boom');
    },
    remove: () => {},
  } as unknown as WorkflowBundleWriter;
}

describe('workflowBundleInstall — ensureBundleExcluded', () => {
  let worktree: string;

  beforeEach(() => {
    execFileSyncOverride.impl = null;
    worktree = tmpDir('cyboflow-bundle-install-');
    initGitRepo(worktree);
    vi.clearAllMocks();
  });

  it('appends the marker + both globs to a fresh git exclude', () => {
    // Empty bundle (row undefined) so writer.write is a no-op; only the exclude side matters.
    installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'run-1', worktree);

    const contents = fs.readFileSync(excludePath(worktree), 'utf8');
    expect(contents).toContain(MARKER);
    for (const glob of GLOBS) expect(contents).toContain(glob);
  });

  it('is idempotent — a second install adds no duplicate marker or globs', () => {
    const writer = new WorkflowBundleWriter();
    installWorkflowBundle(makeDbStub(undefined), writer, 'run-1', worktree);
    installWorkflowBundle(makeDbStub(undefined), writer, 'run-1', worktree);

    const contents = fs.readFileSync(excludePath(worktree), 'utf8');
    const count = (needle: string): number => contents.split(needle).length - 1;
    expect(count(MARKER)).toBe(1);
    for (const glob of GLOBS) expect(count(glob)).toBe(1);
  });

  it('closes a pre-existing file with no trailing newline before appending (no line-mashing)', () => {
    // Pre-seed the exclude with a user pattern and NO trailing newline.
    fs.mkdirSync(path.dirname(excludePath(worktree)), { recursive: true });
    fs.writeFileSync(excludePath(worktree), '*.log', 'utf8');

    installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'run-1', worktree);

    const contents = fs.readFileSync(excludePath(worktree), 'utf8');
    // The user pattern survives on its own line; the marker is NOT mashed onto it.
    expect(contents).toContain('*.log\n');
    expect(contents).not.toContain('*.log#');
    expect(contents).not.toContain(`*.log${MARKER}`);
    expect(contents).toContain(MARKER);
    for (const glob of GLOBS) expect(contents).toContain(glob);
  });

  it('skips quietly (debug, no warn) when the worktree is not a git repo', () => {
    // The global-agent chat thread's home (`<dataDir>/agent-home/<threadId>`) is
    // deliberately NOT a repo and goes through this same seam on every cold
    // spawn, so a warn here fires structurally-forever for a case with nothing
    // to exclude. Pinned as debug after a 2026-08-01 smoke run filed the WARN.
    const nonGit = tmpDir('cyboflow-bundle-nongit-');
    const logger = makeSpyLogger();

    expect(() =>
      installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'run-1', nonGit, logger),
    ).not.toThrow();

    expect(logger.warn).not.toHaveBeenCalled();
    const skipped = logger.calls.some(
      (c) => c.level === 'debug' && c.message.includes('skipped git exclude'),
    );
    expect(skipped).toBe(true);
    fs.rmSync(nonGit, { recursive: true, force: true });
  });

  it('still warns when git fails for a reason OTHER than a missing repo', () => {
    // The non-repo path above is quiet by design; this pins that the quieting is
    // NARROW — a genuine git/fs failure must not be swallowed with it.
    const logger = makeSpyLogger();
    execFileSyncOverride.impl = () => {
      throw Object.assign(new Error('Command failed: git rev-parse --git-path info/exclude'), {
        stderr: 'fatal: detected dubious ownership in repository\n',
      });
    };

    expect(() =>
      installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'run-1', worktree, logger),
    ).not.toThrow();

    const warned = logger.calls.some(
      (c) => c.level === 'warn' && c.message.includes('could not update git exclude'),
    );
    expect(warned).toBe(true);
  });
});

describe('workflowBundleInstall — installWorkflowBundle fail-soft', () => {
  let worktree: string;

  beforeEach(() => {
    execFileSyncOverride.impl = null;
    worktree = tmpDir('cyboflow-bundle-install-fs-');
    initGitRepo(worktree);
    vi.clearAllMocks();
  });

  it('DB-miss resolves to an empty bundle and writes no .claude tree', () => {
    // row undefined → workflowPath null → resolveWorkflowBundle(null) is empty →
    // real writer writes nothing.
    installWorkflowBundle(makeDbStub(undefined), new WorkflowBundleWriter(), 'missing-run', worktree);

    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
    // The overlay is still invoked (post-write) — install proceeds fail-soft.
    expect(installAgentOverlay).toHaveBeenCalledOnce();
  });

  it('catches + logs a throwing writer.write() and never propagates it to the spawn', () => {
    const logger = makeSpyLogger();
    // A resolvable (but bundle-less) path so resolveWorkflowBundle returns empty
    // and the writer is the thing that throws.
    const db = makeDbStub({ workflowPath: '/nonexistent/planner.md' });

    expect(() =>
      installWorkflowBundle(db, makeThrowingWriter(), 'run-x', worktree, logger),
    ).not.toThrow();

    const warned = logger.calls.some(
      (c) => c.level === 'warn' && c.message.includes('install failed for runId=run-x'),
    );
    expect(warned).toBe(true);
    // The writer threw, so the overlay is never reached.
    expect(installAgentOverlay).not.toHaveBeenCalled();
  });

  it('catches a DB-error during workflow_path lookup without throwing', () => {
    const logger = makeSpyLogger();
    // prepare() throws → getRunWorkflowPath warns + returns null → empty bundle.
    installWorkflowBundle(
      makeDbStub(undefined, /* throwOnPrepare */ true),
      new WorkflowBundleWriter(),
      'run-db-err',
      worktree,
      logger,
    );

    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
    const warned = logger.calls.some(
      (c) => c.level === 'warn' && c.message.includes('workflow_path lookup failed'),
    );
    expect(warned).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fan-out stage scripts (dispatch === 'workflow')
// ---------------------------------------------------------------------------

/** The canonical sprint-ish fan-out spec, as a workflows.spec_json string. */
function fanOutSpecJson(innerIds: string[]): string {
  return JSON.stringify({
    id: 'sprint',
    phases: [
      {
        id: 'execute',
        label: 'Execute',
        color: '#c96442',
        steps: [
          {
            id: 'execute-tasks',
            name: 'Execute tasks',
            agent: 'implement',
            mcps: [],
            retries: 0,
            fanOut: {
              over: 'tasks',
              inner: innerIds.map((id) => ({ id, agent: id, name: id })),
            },
          },
        ],
      },
    ],
  });
}

/** DB stub that answers BOTH the workflow_path lookup and the name/spec lookup. */
function makeSpecDbStub(name: string, specJson: string): Database.Database {
  return {
    prepare: (sql: string) => ({
      get: () =>
        sql.includes('workflow_path')
          ? { workflowPath: null }
          : { name, specJson },
    }),
  } as unknown as Database.Database;
}

describe('workflowBundleInstall — fan-out stage scripts', () => {
  let worktree: string;
  const workflowsDir = () => path.join(worktree, '.claude', 'workflows');
  const SCRIPT_GLOB = '.claude/workflows/cyboflow-*.js';

  beforeEach(() => {
    execFileSyncOverride.impl = null;
    frozen.value = null;
    worktree = tmpDir('cyboflow-stage-scripts-');
    initGitRepo(worktree);
    vi.clearAllMocks();
  });

  it('writes NOTHING and adds no exclude glob in the default prose mode', () => {
    const db = makeSpecDbStub('sprint', fanOutSpecJson(['implement', 'write-tests']));

    installWorkflowBundle(db, new WorkflowBundleWriter(), 'run-1', worktree);

    expect(fs.existsSync(workflowsDir())).toBe(false);
    expect(fs.readFileSync(excludePath(worktree), 'utf8')).not.toContain(SCRIPT_GLOB);
  });

  it('renders one script per scriptable stage and excludes them from git', () => {
    const db = makeSpecDbStub('sprint', fanOutSpecJson(['implement', 'write-tests', 'visual-verify']));

    installWorkflowBundle(db, new WorkflowBundleWriter(), 'run-1', worktree, undefined, 'workflow');

    // ONE script for the whole non-gated run of stages (implement + write-tests),
    // named for the batch's first stage. visual-verify is a firm gate, so it ends
    // the batch and is never scripted.
    const written = fs.readdirSync(workflowsDir()).sort();
    expect(written).toEqual(['cyboflow-sprint-execute-tasks-implement.js']);
    expect(fs.readFileSync(excludePath(worktree), 'utf8')).toContain(SCRIPT_GLOB);
  });

  it('the on-disk basename matches the name the prompt will invoke (drift guard)', () => {
    const db = makeSpecDbStub('sprint', fanOutSpecJson(['implement']));

    installWorkflowBundle(db, new WorkflowBundleWriter(), 'run-1', worktree, undefined, 'workflow');

    const invocable = fanOutBatchWorkflowName('sprint', 'execute-tasks', 'implement');
    expect(invocable).not.toBeNull();
    expect(fs.existsSync(path.join(workflowsDir(), `${invocable as string}.js`))).toBe(true);
    // ...and the meta the tracker reads back agrees with both.
    const source = fs.readFileSync(path.join(workflowsDir(), `${invocable as string}.js`), 'utf8');
    expect(source).toContain(`name: ${JSON.stringify(invocable)}`);
  });

  it('renders from the FROZEN variant spec, not the live workflows row', () => {
    // Live row says the chain is [implement]; the run's frozen variant says [beta].
    const db = makeSpecDbStub('sprint', fanOutSpecJson(['implement']));
    frozen.value = { workflowName: 'sprint', specJson: fanOutSpecJson(['beta']) };

    installWorkflowBundle(db, new WorkflowBundleWriter(), 'run-1', worktree, undefined, 'workflow');

    expect(fs.readdirSync(workflowsDir())).toEqual(['cyboflow-sprint-execute-tasks-beta.js']);
  });

  it('an unparseable spec falls back to the built-in definition rather than rendering nothing', () => {
    // resolveWorkflowDefinition treats spec_json as an OVERRIDE of the built-in
    // seed, so a broken spec for a real flow name still resolves the seed graph —
    // which is the correct floor: the run walks that graph, so its scripts must
    // match it. (A run whose prompt cites scripts that were never written is the
    // failure mode this guards against.)
    const db = makeSpecDbStub('sprint', 'not json at all');

    installWorkflowBundle(db, new WorkflowBundleWriter(), 'run-1', worktree, makeSpyLogger(), 'workflow');

    const written = fs.readdirSync(workflowsDir());
    expect(written.length).toBeGreaterThan(0);
    expect(written.every((f) => f.startsWith('cyboflow-sprint-') && f.endsWith('.js'))).toBe(true);
    // The host-owned visual gate is never scripted, whatever the source of the graph.
    expect(written.some((f) => f.includes('visual-verify'))).toBe(false);
  });

  it('renders nothing for a workflow with no resolvable definition', () => {
    const db = makeSpecDbStub('not-a-real-flow', '{}');

    installWorkflowBundle(db, new WorkflowBundleWriter(), 'run-1', worktree, makeSpyLogger(), 'workflow');

    expect(fs.existsSync(workflowsDir())).toBe(false);
    expect(fs.readFileSync(excludePath(worktree), 'utf8')).not.toContain(SCRIPT_GLOB);
  });
});
