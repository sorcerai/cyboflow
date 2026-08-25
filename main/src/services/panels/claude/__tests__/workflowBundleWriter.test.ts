/**
 * Unit tests for WorkflowBundleWriter (IDEA-013 rung-(ii)).
 *
 * Covers:
 *   (a) write installs each command/agent as `.claude/commands|agents/cyboflow-<name>.md`;
 *   (b) write is merge-safe — pre-existing USER files in those dirs are preserved;
 *   (c) write clears the PRIOR cyboflow set first (a removed asset does not linger);
 *   (d) remove strips ONLY cyboflow-*.md and leaves user files intact;
 *   (e) an empty bundle writes nothing and returns null (no dirs created).
 *
 * Hermetic: each test uses a fresh os.tmpdir() worktree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkflowBundleWriter } from '../workflowBundleWriter';
import type { WorkflowBundle } from '../../../../orchestrator/workflows/workflowBundle';
import { makeSpyLogger } from '../../../../orchestrator/__test_fixtures__/loggerLikeSpy';

function tmpWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-bundle-'));
}

const commandsDir = (wt: string) => path.join(wt, '.claude', 'commands');
const agentsDir = (wt: string) => path.join(wt, '.claude', 'agents');

const BUNDLE: WorkflowBundle = {
  commands: [
    { name: 'context', content: '---\ndescription: ctx\n---\nContext phase.' },
    { name: 'tasks', content: '---\ndescription: tasks\n---\nTasks phase.' },
  ],
  agents: [{ name: 'researcher', content: '---\nname: researcher\ndescription: r\n---\nResearch.' }],
  scripts: [],
};

describe('WorkflowBundleWriter', () => {
  let worktree: string;

  beforeEach(() => {
    worktree = tmpWorktree();
  });

  afterEach(() => {
    fs.rmSync(worktree, { recursive: true, force: true });
  });

  it('(a) installs commands and agents as cyboflow-<name>.md with verbatim content', () => {
    const result = new WorkflowBundleWriter(makeSpyLogger()).write(worktree, BUNDLE);

    expect(result).not.toBeNull();
    expect(result?.commandPaths).toHaveLength(2);
    expect(result?.agentPaths).toHaveLength(1);

    expect(fs.readFileSync(path.join(commandsDir(worktree), 'cyboflow-context.md'), 'utf8')).toBe(
      '---\ndescription: ctx\n---\nContext phase.',
    );
    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-tasks.md'))).toBe(true);
    expect(fs.readFileSync(path.join(agentsDir(worktree), 'cyboflow-researcher.md'), 'utf8')).toContain(
      'Research.',
    );
  });

  it('(b) preserves a pre-existing USER command file', () => {
    fs.mkdirSync(commandsDir(worktree), { recursive: true });
    const userFile = path.join(commandsDir(worktree), 'deploy.md');
    fs.writeFileSync(userFile, 'user deploy command', 'utf8');

    new WorkflowBundleWriter().write(worktree, BUNDLE);

    expect(fs.readFileSync(userFile, 'utf8')).toBe('user deploy command');
    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-context.md'))).toBe(true);
  });

  it('(c) clears the prior cyboflow set so a removed asset does not linger', () => {
    const writer = new WorkflowBundleWriter();
    writer.write(worktree, BUNDLE);
    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-tasks.md'))).toBe(true);

    // Re-write a SMALLER bundle (tasks dropped).
    writer.write(worktree, { commands: [BUNDLE.commands[0]], agents: [], scripts: [] });

    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-context.md'))).toBe(true);
    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-tasks.md'))).toBe(false);
    // The agent from the first write is also cleared.
    expect(fs.existsSync(path.join(agentsDir(worktree), 'cyboflow-researcher.md'))).toBe(false);
  });

  it('(d) remove strips only cyboflow-*.md and preserves user files', () => {
    const writer = new WorkflowBundleWriter();
    writer.write(worktree, BUNDLE);
    const userFile = path.join(commandsDir(worktree), 'deploy.md');
    fs.writeFileSync(userFile, 'user deploy', 'utf8');

    writer.remove(worktree);

    expect(fs.existsSync(path.join(commandsDir(worktree), 'cyboflow-context.md'))).toBe(false);
    expect(fs.existsSync(path.join(agentsDir(worktree), 'cyboflow-researcher.md'))).toBe(false);
    expect(fs.readFileSync(userFile, 'utf8')).toBe('user deploy');
  });

  it('(e) an empty bundle writes nothing and returns null', () => {
    const result = new WorkflowBundleWriter().write(worktree, { commands: [], agents: [], scripts: [] });
    expect(result).toBeNull();
    expect(fs.existsSync(path.join(worktree, '.claude'))).toBe(false);
  });

  it('remove is a no-op when the worktree has no .claude dir', () => {
    expect(() => new WorkflowBundleWriter().remove(worktree)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Dynamic-workflow stage scripts (.claude/workflows/cyboflow-*.js)
  // -------------------------------------------------------------------------

  const workflowsDir = (wt: string) => path.join(wt, '.claude', 'workflows');

  it('writes stage scripts as cyboflow-<name>.js', () => {
    const result = new WorkflowBundleWriter().write(worktree, {
      commands: [],
      agents: [],
      scripts: [{ name: 'sprint-execute-implement', content: 'export const meta = {}\n' }],
    });

    const target = path.join(workflowsDir(worktree), 'cyboflow-sprint-execute-implement.js');
    expect(fs.existsSync(target)).toBe(true);
    expect(result?.scriptPaths).toEqual([target]);
  });

  it('remove strips generated .js but preserves a user script and a user .md in the same dir', () => {
    const writer = new WorkflowBundleWriter();
    writer.write(worktree, {
      commands: [],
      agents: [],
      scripts: [{ name: 'gen', content: 'export const meta = {}\n' }],
    });

    const userJs = path.join(workflowsDir(worktree), 'mine.js');
    const userMd = path.join(workflowsDir(worktree), 'cyboflow-notes.md');
    fs.writeFileSync(userJs, 'user script');
    fs.writeFileSync(userMd, 'user notes');

    writer.remove(worktree);

    expect(fs.existsSync(path.join(workflowsDir(worktree), 'cyboflow-gen.js'))).toBe(false);
    expect(fs.readFileSync(userJs, 'utf8')).toBe('user script');
    // Extension-scoped: the .md remove pass targets commands/agents dirs, so a
    // cyboflow-*.md sitting in the workflows dir is not ours to delete.
    expect(fs.readFileSync(userMd, 'utf8')).toBe('user notes');
  });

  it('an empty bundle still clears a previously-written script (no stale resolution)', () => {
    const writer = new WorkflowBundleWriter();
    writer.write(worktree, {
      commands: [],
      agents: [],
      scripts: [{ name: 'stale', content: 'export const meta = {}\n' }],
    });
    expect(fs.existsSync(path.join(workflowsDir(worktree), 'cyboflow-stale.js'))).toBe(true);

    // Dispatch switched off -> empty bundle. The prior set MUST be reconciled
    // away; otherwise the CLI keeps resolving the stale script by name.
    const result = writer.write(worktree, { commands: [], agents: [], scripts: [] });

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(workflowsDir(worktree), 'cyboflow-stale.js'))).toBe(false);
  });

  it('refuses a logical name that would escape its target directory', () => {
    const writer = new WorkflowBundleWriter();
    writer.write(worktree, {
      commands: [],
      agents: [],
      scripts: [
        { name: '../../escaped', content: 'nope' },
        { name: 'ok', content: 'export const meta = {}\n' },
      ],
    });

    expect(fs.existsSync(path.join(worktree, '.claude', 'workflows', 'cyboflow-ok.js'))).toBe(true);
    // Nothing landed above the workflows dir.
    expect(fs.existsSync(path.join(worktree, 'cyboflow-../../escaped.js'))).toBe(false);
    expect(fs.readdirSync(worktree).filter((e) => e.endsWith('.js'))).toEqual([]);
  });
});
