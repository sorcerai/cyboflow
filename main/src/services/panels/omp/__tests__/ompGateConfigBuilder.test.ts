/**
 * Unit tests for ompGateConfigBuilder.
 *
 * The interesting assertions are the two translations that would fail SILENTLY
 * in production: a tool name that maps to something OMP never emits simply never
 * matches (a deny that does not deny, an allowlist that does not allow), and a
 * cyboflow MCP tool name that drifts out of the hardcoded list stops being
 * auto-allowed at all (the gate matches on exact membership only, so drift shows
 * up as our own flow tools suddenly prompting a human). So the MCP list is
 * re-derived from `cyboflowMcpServer.ts` here rather than restated.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACCEPT_EDITS_AUTO_APPROVE_TOOLS } from '../../../../orchestrator/permissionModeMapper';
import { ACCEPT_EDITS_SAFE_READONLY_TOOLS } from '../../../../orchestrator/safeCommandClassifier';
import {
  MOST_RESTRICTIVE_GATE_CONFIG,
  decideToolCall,
  parseGateConfig,
} from '../gate/ompGateExtension';
import {
  buildOmpGateConfig,
  composeOmpMcpToolName,
  CYBOFLOW_MCP_TOOL_NAMES,
  cyboflowOmpMcpToolNames,
  OMP_AUTO_ALLOW_TOOLS,
  OMP_EDIT_TOOLS,
  toOmpToolName,
} from '../ompGateConfigBuilder';

const MCP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../../../orchestrator/mcpServer/cyboflowMcpServer.ts',
);

describe('toOmpToolName', () => {
  it("maps Claude's mcp__server__tool form onto OMP's single-underscore form", () => {
    // The one name the programmatic step runner actually denies
    // (spawnStepRunner.ts:63). OMP strips the redundant `cyboflow_` prefix.
    expect(toOmpToolName('mcp__cyboflow__cyboflow_request_verification')).toBe(
      'mcp__cyboflow_request_verification',
    );
  });

  it('sanitizes a server name the way OMP does', () => {
    // `[^a-z_]+` collapses to `_` (mcp/tool-bridge.ts:335-343).
    expect(toOmpToolName('mcp__Cyboflow-Extra__do_thing')).toBe('mcp__cyboflow_extra_do_thing');
    expect(toOmpToolName('mcp__cyboflow')).toBe('mcp__cyboflow');
  });

  it('lowercases a builtin and maps the names that genuinely differ', () => {
    expect(toOmpToolName('Bash')).toBe('bash');
    expect(toOmpToolName('Write')).toBe('write');
    expect(toOmpToolName('TodoWrite')).toBe('todo');
    expect(toOmpToolName('WebSearch')).toBe('web_search');
    expect(toOmpToolName('LS')).toBe('glob');
  });
});

describe('the cyboflow MCP tool list', () => {
  it('matches every tool cyboflowMcpServer declares (tripwire on drift)', () => {
    const source = fs.readFileSync(MCP_SERVER_SOURCE, 'utf8');
    const declared = new Set(
      [...source.matchAll(/name: '(cyboflow_[a-z_]+)'/g)].map((match) => match[1]),
    );
    expect(declared.size).toBeGreaterThan(40);
    expect([...declared].sort()).toEqual([...CYBOFLOW_MCP_TOOL_NAMES].sort());
  });

  it('composes each name the way OMP presents it to the hook', () => {
    expect(composeOmpMcpToolName('cyboflow', 'cyboflow_report_finding')).toBe(
      'mcp__cyboflow_report_finding',
    );
    expect(cyboflowOmpMcpToolNames()).toContain('mcp__cyboflow_report_finding');
    expect(cyboflowOmpMcpToolNames()).toHaveLength(CYBOFLOW_MCP_TOOL_NAMES.length);
  });
});

describe('the allowlists mirror cyboflow, not OMP', () => {
  it('covers every cyboflow read-safe tool that has an OMP counterpart', () => {
    // Read/Glob/Grep/LS/NotebookRead/TodoWrite. NotebookRead has no OMP tool at
    // all; everything else must land inside the auto-allow set.
    const mapped = [...ACCEPT_EDITS_SAFE_READONLY_TOOLS]
      .map(toOmpToolName)
      .filter((name) => name !== 'notebookread');
    for (const name of mapped) {
      expect(OMP_AUTO_ALLOW_TOOLS).toContain(name);
    }
  });

  it('covers every cyboflow edit tool that has an OMP counterpart', () => {
    // Edit/Write/MultiEdit — MultiEdit has no OMP counterpart.
    const mapped = ACCEPT_EDITS_AUTO_APPROVE_TOOLS.map(toOmpToolName).filter(
      (name) => name !== 'multiedit',
    );
    for (const name of mapped) {
      expect(OMP_EDIT_TOOLS).toContain(name);
    }
  });

  it('keeps network- and state-mutating OMP read-tier tools out of the auto-allow set', () => {
    for (const name of ['web_search', 'memory_edit', 'retain', 'checkpoint', 'rewind', 'bash']) {
      expect(OMP_AUTO_ALLOW_TOOLS).not.toContain(name);
    }
  });
});

describe('buildOmpGateConfig', () => {
  const base = { permissionMode: 'default' as const, cyboflowMcpAvailable: true };

  it('translates the deny list and no longer denies the subagent tool', () => {
    const config = buildOmpGateConfig({
      ...base,
      disallowedTools: ['mcp__cyboflow__cyboflow_request_verification', 'Bash', 'Bash'],
    });

    expect(config.disallowedTools).toEqual(['mcp__cyboflow_request_verification', 'bash']);
    // Lifted once the premise was measured rather than assumed — the gate's
    // handler DOES fire inside a `task` subagent, and at depth 2. See the
    // builder's doc block for the probe.
    expect(config.denyTaskTool).toBe(false);
  });

  /**
   * The half of the deny that did NOT move, and the reason it matters more than
   * the half that did: the builder only runs when a config is being BUILT. A
   * spawn that reaches the gate with no config, or a malformed one, must still
   * refuse subagent dispatch — otherwise "the config failed to arrive" becomes
   * "the permission system is off", which is the failure this flag was always
   * really guarding.
   */
  it('leaves the fail-closed defaults denying, however the builder is set', () => {
    const quiet = { debug: () => undefined, warn: () => undefined, error: () => undefined };
    expect(MOST_RESTRICTIVE_GATE_CONFIG.denyTaskTool).toBe(true);
    expect(parseGateConfig(undefined, quiet).denyTaskTool).toBe(true);
    expect(parseGateConfig('not json at all', quiet).denyTaskTool).toBe(true);
    expect(
      parseGateConfig(JSON.stringify({ permissionMode: 'auto' }), quiet).denyTaskTool,
    ).toBe(true);
    expect(
      decideToolCall({ toolName: 'task', input: {} }, MOST_RESTRICTIVE_GATE_CONFIG).kind,
    ).toBe('block');
  });

  it('omits the cyboflow MCP names for an in-place session that gets no MCP', () => {
    expect(buildOmpGateConfig({ ...base, cyboflowMcpAvailable: false }).cyboflowMcpToolNames).toEqual(
      [],
    );
    expect(buildOmpGateConfig(base).cyboflowMcpToolNames).toContain('mcp__cyboflow_report_finding');
  });

  /**
   * The empty in-place list is a SECURITY property, not an omission. A
   * legitimate cyboflow MCP tool cannot occur in an in-place session — but a
   * spoofed one can, because OMP auto-imports the user's own MCP configs and a
   * server named `cyboflow-extra` yields `mcp__cyboflow_extra_*`. Exact-empty
   * means the gate auto-allows neither.
   */
  it('leaves an in-place session unable to auto-allow ANY MCP tool, spoofed or real', () => {
    const inPlace = buildOmpGateConfig({ ...base, cyboflowMcpAvailable: false });

    expect(
      decideToolCall({ toolName: 'mcp__cyboflow_extra_exfiltrate', input: {} }, inPlace).kind,
    ).toBe('ask');
    expect(decideToolCall({ toolName: 'mcp__cyboflow_report_finding', input: {} }, inPlace).kind).toBe(
      'ask',
    );
  });

  it('gates a spoofed MCP name even for a worktree session that HAS the real list', () => {
    const wired = buildOmpGateConfig(base);

    expect(decideToolCall({ toolName: 'mcp__cyboflow_report_finding', input: {} }, wired)).toEqual({
      kind: 'allow',
      rule: 'cyboflow-mcp',
    });
    expect(
      decideToolCall({ toolName: 'mcp__cyboflow_extra_exfiltrate', input: {} }, wired).kind,
    ).toBe('ask');
  });

  it('carries permission rules through verbatim for the gate to parse', () => {
    const config = buildOmpGateConfig({ ...base, allowRules: ['Bash(git status:*)', 'Read'] });
    expect(config.allowRules).toEqual(['Bash(git status:*)', 'Read']);
  });

  /**
   * End-to-end against the real gate predicate: the config this builder emits
   * has to produce the decisions the mode table promises (proposal §5.3), which a
   * per-field assertion alone would not prove.
   */
  it('drives the gate to the decisions the mode table promises', () => {
    const disallowed = ['mcp__cyboflow__cyboflow_request_verification'];

    const strict = buildOmpGateConfig({ ...base, disallowedTools: disallowed });
    expect(decideToolCall({ toolName: 'read', input: {} }, strict)).toEqual({
      kind: 'allow',
      rule: 'auto-allow-tool',
    });
    expect(decideToolCall({ toolName: 'write', input: {} }, strict)).toEqual({ kind: 'ask' });
    // `task` now falls through to the ordinary ladder instead of blocking at
    // rule 2; in `default` mode that lands on the human, not on an auto-allow.
    expect(decideToolCall({ toolName: 'task', input: {} }, strict)).toEqual({ kind: 'ask' });
    expect(decideToolCall({ toolName: 'mcp__cyboflow_report_finding', input: {} }, strict)).toEqual({
      kind: 'allow',
      rule: 'cyboflow-mcp',
    });
    // Denied even though it is one of OUR MCP tools: rule 1 runs first.
    expect(
      decideToolCall({ toolName: 'mcp__cyboflow_request_verification', input: {} }, strict).kind,
    ).toBe('block');

    // `read` is on the auto-allow list by NAME, but OMP escalates an `ssh://`
    // read to a remote exec-tier operation (read.ts:401), so the real config the
    // manager ships must still route that one to a human.
    expect(decideToolCall({ toolName: 'read', input: { path: 'ssh://h/x' } }, strict)).toEqual({
      kind: 'ask',
    });
    expect(decideToolCall({ toolName: 'grep', input: { path: 'ssh://h/x' } }, strict)).toEqual({
      kind: 'ask',
    });

    const acceptEdits = buildOmpGateConfig({ ...base, permissionMode: 'acceptEdits' });
    expect(decideToolCall({ toolName: 'write', input: {} }, acceptEdits)).toEqual({
      kind: 'allow',
      rule: 'edit-tool',
    });
    // Provably read-only bash is admitted by the argument-aware safe-bash rung
    // (gate parity with cyboflow's own acceptEdits widening); a non-classifiable
    // command still reaches the human.
    expect(decideToolCall({ toolName: 'bash', input: { command: 'ls' } }, acceptEdits)).toEqual({
      kind: 'allow',
      rule: 'safe-bash',
    });
    expect(
      decideToolCall({ toolName: 'bash', input: { command: 'pnpm typecheck' } }, acceptEdits),
    ).toEqual({ kind: 'ask' });
    // An ssh:// WRITE is the worse half of the same hole.
    expect(decideToolCall({ toolName: 'write', input: { path: 'ssh://h/x' } }, acceptEdits)).toEqual({
      kind: 'ask',
    });

    // `git status` would be admitted by the safe-bash rung before allowRules are
    // ever consulted, so proving the allow-rule path needs a command no tier
    // admits on its own.
    const auto = buildOmpGateConfig({
      ...base,
      permissionMode: 'auto',
      allowRules: ['Bash(pnpm typecheck:*)'],
    });
    expect(decideToolCall({ toolName: 'bash', input: { command: 'pnpm typecheck' } }, auto)).toEqual({
      kind: 'allow',
      rule: 'allow-rule',
    });
    expect(decideToolCall({ toolName: 'bash', input: { command: 'rm -rf /' } }, auto)).toEqual({
      kind: 'ask',
    });

    // dontAsk is log-only for ordinary tools, but disallowedTools and the
    // subagent denial still bite.
    const dontAsk = buildOmpGateConfig({
      ...base,
      permissionMode: 'dontAsk',
      disallowedTools: disallowed,
    });
    expect(decideToolCall({ toolName: 'bash', input: { command: 'rm -rf /' } }, dontAsk)).toEqual({
      kind: 'allow',
      rule: 'dont-ask',
    });
    // THE ONE PLACE LIFTING denyTaskTool GENUINELY WIDENS THINGS. Rule 2 used
    // to bite before the `dontAsk` short-circuit, so subagent dispatch was the
    // single thing `dontAsk` could not do. It can now — which is what the mode
    // says on the tin ("full access, approvals off"), and is only defensible
    // because the subagent's OWN calls are gated: the probe in the builder's
    // doc block shows them reaching this same predicate, at depth 2, where
    // `dontAsk` allows them exactly as it allows the parent's.
    expect(decideToolCall({ toolName: 'task', input: {} }, dontAsk)).toEqual({
      kind: 'allow',
      rule: 'dont-ask',
    });
    expect(
      decideToolCall({ toolName: 'mcp__cyboflow_request_verification', input: {} }, dontAsk).kind,
    ).toBe('block');
  });
});

describe('buildOmpGateConfig — the human-decision budget', () => {
  const base = { permissionMode: 'default' as const, cyboflowMcpAvailable: true };

  it('omits the field entirely when no budget was resolved', () => {
    // Absence is the signal that tells the gate to keep its built-in ~25s
    // budget. A defaulted number here would be a claim that OMP was configured
    // to allow a longer handler, which for an un-raised spawn is false.
    const config = buildOmpGateConfig(base);
    expect('humanDecisionBudgetMs' in config).toBe(false);
  });

  it('forwards the budget verbatim when one was resolved', () => {
    const config = buildOmpGateConfig({ ...base, humanDecisionBudgetMs: 1_770_000 });
    expect(config.humanDecisionBudgetMs).toBe(1_770_000);
  });
});
