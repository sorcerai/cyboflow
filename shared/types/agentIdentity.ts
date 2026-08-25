/**
 * agentIdentity — the canonical agent-key vocabulary + step-aware legacy resolver.
 *
 * The canonical agent key is the bundled agent's FILE BASENAME — the stem of each
 * `main/src/orchestrator/workflows/<wf>/agents/<key>.md` (equivalently the
 * frontmatter `name:` with the `cyboflow-` prefix stripped; a unit test asserts
 * the two agree for all 20 files, including launch's `interview` agent at
 * `main/src/orchestrator/workflows/launch/agents/interview.md`). This single
 * key is used by:
 *   (i)   `WorkflowStep.agent` in WORKFLOW_DEFINITIONS,
 *   (ii)  the Agents catalogue + gallery,
 *   (iii) the `agent_overrides.agent_key` column, and
 *   (iv)  the spawn-time filename `cyboflow-<key>.md`.
 *
 * `human` is a GATE, not an agent: it is a valid `step.agent` value (kept
 * selectable in the blueprint editor) but is excluded from the catalogue/store/
 * editor. `resolveStepAgentKey` returns `null` for it.
 *
 * This module is pure (no zod, no Node built-ins) so it imports cleanly in the
 * main process, the renderer, and any test environment.
 */

export const CANONICAL_AGENT_KEYS = [
  'context',
  'interview',
  'research',
  'ui-prototype',
  'architecture',
  'adversarial-review',
  'epics',
  'tasks',
  'dependency-analyzer',
  'implement',
  'code-review',
  'write-tests',
  'task-verify',
  'sprint-verify',
  'visual-verify',
  'sprint-review',
  // The sprint/ship stage that acts on the run's OWN code-review findings —
  // verify each, judge which are worth doing now, fix those in place — so a
  // review pass changes code instead of only filling the backlog. Ordered next
  // to sprint-review because it consumes what that step (and every lane's
  // code-review) produced.
  'address-review',
  'compounder',
  // The verify-setup flow's single subagent (docs/proposals/verification-setup-flow.md
  // §5.1). Its key deliberately EQUALS its workflow name — the flow binds exactly
  // one agent to four of its five steps, so a distinct persona name would only add
  // a second thing to remember. Ordered last, mirroring how every earlier flow's
  // agents were appended as their flow landed.
  'verify-setup',
  // The lane runbook BOOTSTRAP agent (docs/proposals/lane-runbook-bootstrap.md
  // §8). Unlike every key above it, this agent is bound to NO workflow step: the
  // main-process controller deploys it directly, at the enqueue seam, when a
  // sprint/ship lane's visual verification would be skipped for want of a
  // runbook. It is still a canonical key because it is a bundled agent like any
  // other — it appears in the catalogue and the gallery, and its model and
  // prompt are overridable per workflow, which is the whole reason the key
  // vocabulary exists.
  'runbook-bootstrap',
] as const;

export type CanonicalAgentKey = (typeof CANONICAL_AGENT_KEYS)[number];

export const HUMAN_GATE_AGENT = 'human';

/**
 * Legacy `step.agent` labels (shipped in earlier WORKFLOW_DEFINITIONS) → canonical
 * key. Sources are exactly the verified legacy universe; phantom labels
 * (`visual-verifier`, `test-writer`) are intentionally absent — they never
 * appeared in any shipped definition (see the source-validity unit test).
 *
 * `task-refiner` is intentionally absent here — it is dual-binding (it was the
 * agent on BOTH the `epics` and `tasks` steps), so it is disambiguated by stepId
 * in `resolveStepAgentKey` below.
 */
const LEGACY_BY_LABEL: Readonly<Record<string, string>> = {
  'idea-extractor': 'context',
  researcher: 'research',
  executor: 'implement',
  verifier: 'sprint-verify',
  'code-reviewer': 'sprint-review',
};

/** stepId already equals the canonical key for the ambiguous planner refine steps. */
const STEP_DISAMBIGUATED = new Set(['epics', 'tasks']);

/**
 * Step-aware display + usage resolver: (stepId, label) → canonical key.
 * Returns `null` for the human gate.
 *
 * Old runs are never migrated; their frozen `steps_snapshot_json` resolves at
 * read time. The dual-binding `task-refiner` label disambiguates by stepId
 * (which already equals the canonical key for the `epics`/`tasks` steps).
 */
export function resolveStepAgentKey(stepId: string, label: string): string | null {
  if (label === HUMAN_GATE_AGENT) return null;
  if (label === 'task-refiner' && STEP_DISAMBIGUATED.has(stepId)) return stepId; // epics | tasks
  return LEGACY_BY_LABEL[label] ?? label; // identity for already-canonical labels
}

/**
 * Pure display normalization when only a label is available (no stepId context).
 * Lossy for `task-refiner` (cannot disambiguate epics vs tasks) — display-only.
 */
export function normalizeAgentLabel(label: string): string {
  return LEGACY_BY_LABEL[label] ?? label;
}

export function isCanonicalAgentKey(s: string): s is CanonicalAgentKey {
  return (CANONICAL_AGENT_KEYS as readonly string[]).includes(s);
}

/**
 * The Agent-dispatch tool's name across CLI versions: 'Agent' on ≥~2.1.2xx
 * (verified against the SDK-vendored 2.1.201 the app actually spawns), 'Task'
 * on older CLIs. The SINGLE HOME for the name-keyed dispatch classification —
 * sub-agent rendering (messageProjection / ToolCallView / chat auto-expand),
 * the sprint-lane derive backstop, and the run_in_background pin all key off
 * it, so a future CLI rename is a one-line change. The runtime CLI is whatever
 * the SDK resolves, not something this codebase pins — always match BOTH.
 */
export function isAgentDispatchToolName(toolName: string): boolean {
  return toolName === 'Agent' || toolName === 'Task';
}
