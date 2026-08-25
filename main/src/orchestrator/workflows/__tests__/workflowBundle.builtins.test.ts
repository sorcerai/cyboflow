/**
 * Contract test for the SHIPPED built-in workflow bundles (IDEA-013 rung-(ii),
 * subagent rework).
 *
 * Resolves each built-in flow's co-located bundle directly from the source tree
 * (the same `<name>/agents` layout `copy:assets` ships to dist) and locks the exact
 * set of `cyboflow-<phase>` subagents. Heavy phases are delegated to subagents
 * (own context window); human-gate phases run INLINE in the orchestrator, so they
 * ship no bundle file. This guards against a phase subagent being added/removed/
 * renamed out of sync with the orchestrator prose and the WORKFLOW_DEFINITIONS step
 * ids, and locks the single-writer invariant (no `cyboflow_*` tool in a subagent).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { resolveWorkflowBundle } from '../workflowBundle';
import {
  SANCTIONED_SUBAGENT_TOOL,
  SANCTIONED_SUBAGENT_TOOL_BARE,
} from '../../../../../shared/types/agents';

const workflowsDir = path.join(__dirname, '..');

describe('built-in workflow bundles', () => {
  it('planner ships its 7 heavy-phase subagents in order (gates stay inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'planner.md'));
    // Human gates (approve-idea / approve-design / approve-plan) run inline in the
    // orchestrator — they are NOT delegated, so the bundle ships no commands, only
    // subagents.
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual([
      'adversarial-review',
      'architecture',
      'context',
      'epics',
      'research',
      'tasks',
      'ui-prototype',
    ]);
    assertAgentShape(bundle.agents);
  });

  it('sprint ships its 10 heavy-phase subagents in order (gate stays inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'sprint.md'));
    // The human-review gate runs inline in the orchestrator — not delegated — so the
    // bundle ships no commands, only subagents.
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual([
      'address-review',
      'code-review',
      'dependency-analyzer',
      'implement',
      // Deployed by the CONTROLLER at the enqueue seam, not bound to a step
      // (docs/proposals/lane-runbook-bootstrap.md §8) — bundled like any other
      // agent so its prompt and model stay overridable per project/workflow.
      'runbook-bootstrap',
      'sprint-review',
      'sprint-verify',
      'task-verify',
      'visual-verify',
      'write-tests',
    ]);
    assertAgentShape(bundle.agents);
  });

  it('ship ships its 17 heavy-phase subagents in order (gates stay inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'ship.md'));
    // Human gates (approve-idea / approve-design / approve-plan / human-review) run
    // inline in the orchestrator — they are NOT delegated, so the bundle ships no
    // commands, only subagents. Ship = planner's plan/refine set ⊕ sprint's
    // execute/verify set, self-contained as verbatim copies.
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual([
      'address-review',
      'adversarial-review',
      'architecture',
      'code-review',
      'context',
      'dependency-analyzer',
      'epics',
      'implement',
      'research',
      // Controller-deployed; see the sprint list above.
      'runbook-bootstrap',
      'sprint-review',
      'sprint-verify',
      'task-verify',
      'tasks',
      'ui-prototype',
      'visual-verify',
      'write-tests',
    ]);
    assertAgentShape(bundle.agents);
  });

  it('verify-setup ships its single heavy-phase subagent (both gates stay inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'verify-setup.md'));
    // Both human gates (approve-runbook / human-review) run inline in the
    // orchestrator, so the bundle ships no commands. The flow binds ONE agent to
    // its three working steps (inspect / derive / prove) — the survey and the draft
    // are the only context-heavy work; writing, registering, and proving are
    // orchestrator-owned because they are cyboflow-state writes.
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual(['verify-setup']);
    assertAgentShape(bundle.agents);
  });

  it('launch ships its 8 heavy-phase subagents in order (gates stay inline)', () => {
    const bundle = resolveWorkflowBundle(path.join(workflowsDir, 'launch.md'));
    // Human gates (approve-brief / approve-ideas / approve-design / approve-plan /
    // decompose) run inline in the orchestrator — they are NOT delegated, so the
    // bundle ships no commands, only subagents. Launch reuses planner's plan/
    // refine set verbatim (see agentParity.test.ts) plus one flow-owned agent,
    // `interview`, that has no planner/sprint source — it drives the multi-round
    // interview, brief synthesis, and idea decomposition unique to Launch.
    expect(bundle.commands).toEqual([]);
    expect(bundle.agents.map((a) => a.name)).toEqual([
      'adversarial-review',
      'architecture',
      'context',
      'epics',
      'interview',
      'research',
      'tasks',
      'ui-prototype',
    ]);
    assertAgentShape(bundle.agents);
  });
});

/**
 * Every phase subagent carries name + description + tools frontmatter, returns a
 * `## Result` block, and NEVER touches a STATE-MUTATING `cyboflow_*` MCP tool —
 * the orchestrator is the single writer of workflow state (subagents only do
 * isolated side-work and return a compact result). The lone exception is the
 * request-only SANCTIONED_SUBAGENT_TOOL (visual-verification P6:
 * `cyboflow_request_verification`) — it enqueues a request and returns without
 * mutating state, so it does NOT break the single-writer invariant. A subagent
 * references it in TWO forms — the fully-qualified frontmatter grant
 * (`mcp__cyboflow__cyboflow_request_verification`) and the bare prose call
 * (`cyboflow_request_verification(...)`, the visual merge-gate example — P8b) —
 * both stripped before the guard (fully-qualified FIRST, since the bare name is
 * its substring) so the underscore match stays precise: agent prose freely says
 * "cyboflow Planner" / "cyboflow state" / `cyboflow-context`, none of which
 * contain the tool-name underscore.
 */
function assertAgentShape(agents: { name: string; content: string }[]): void {
  for (const agent of agents) {
    expect(agent.content, `${agent.name} frontmatter`).toMatch(
      /^---[\s\S]*name:[\s\S]*description:[\s\S]*tools:/,
    );
    expect(agent.content, `${agent.name} returns a Result block`).toContain('## Result');
    // Strip the one sanctioned request-only grant (fully-qualified frontmatter
    // form FIRST, then any remaining bare prose call), then assert NO other
    // cyboflow_* tool is referenced (the single-writer invariant for mutating tools).
    const withoutSanctioned = agent.content
      .split(SANCTIONED_SUBAGENT_TOOL)
      .join('')
      .split(SANCTIONED_SUBAGENT_TOOL_BARE)
      .join('');
    expect(withoutSanctioned, `${agent.name} must not call any state-mutating cyboflow_* tool`).not.toMatch(
      /cyboflow_/,
    );
  }
}
