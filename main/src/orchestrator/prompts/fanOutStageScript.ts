/**
 * fanOutStageScript.ts
 *
 * Pure, side-effect-free renderer that turns a BATCH of consecutive fan-out
 * inner stages into a Claude Code **dynamic-workflow script**
 * (`.claude/workflows/*.js`, the `Workflow` tool's named-script surface).
 *
 * ── Batching, and what a firm gate is for ────────────────────────────────────
 * The chain is split at FIRM GATES (`FanOutInnerStep.firmGate`). Every maximal
 * run of consecutive non-gated stages becomes ONE script that walks each item
 * through that whole sub-chain — `implement → write-tests → code-review →
 * task-verify` in one dispatch — with per-item concurrency and NO return to the
 * orchestrator in between. That is where the efficiency comes from: the
 * orchestrator is not re-entered per stage, and a fast item is not held at a
 * barrier waiting for a slow sibling.
 *
 * The deliberate trade, chosen explicitly: lane `current_step` does not tick per
 * stage inside a batch. The script returns each item's full stage trail and the
 * orchestrator backfills it when the batch returns, so nothing is lost except
 * live per-stage granularity — and the dynamic-workflow tracker still shows
 * per-agent progress meanwhile.
 *
 * A firm gate ends a batch and stays with the orchestrator. `visual-verify` is
 * the only one in the built-in chains, and it is a gate for a hard reason rather
 * than a cautious one: it has NO subagent. The orchestrator fires
 * `cyboflow_request_verification` and PARKS the lane while an async external
 * verdict (produced by the central verifier, deployed by the main-process
 * scheduler into an isolated snapshot worktree with `$VERIFY_*` env) drives it
 * off the park. There is nothing to delegate, so it is excluded structurally by
 * {@link isFirmGateInnerStep}, not by policy.
 *
 * ── What still never moves ───────────────────────────────────────────────────
 * Every cyboflow WRITE stays with the orchestrator. Workflow subagents carry no
 * cyboflow MCP tools by design (`cyboflow-<agent>` definitions pin a `tools:`
 * allowlist and are documented "Never writes cyboflow state"), so the scripts
 * report and the orchestrator records: lane moves, findings, attempts, the
 * per-task commit.
 *
 * ── Domain outcome vs promise outcome ────────────────────────────────────────
 * `code-review` and `task-verify` return NORMALLY while reporting failure
 * (`REVIEW: BLOCKING`, `VERDICT: FAIL`). Every stage result is therefore a
 * SCHEMA'd object with an explicit `outcome`, never a resolved/rejected promise.
 *
 * No DB, IPC, Electron, or fs imports — a pure string builder, mirroring
 * `fan-out-instructions.ts` (its prose sibling). Fail-soft: an unrenderable
 * batch yields `null`, never a throw.
 */
import type { FanOutInnerStep, FanOutSpec, WorkflowStep } from '../../../../shared/types/workflows';

// ---------------------------------------------------------------------------
// Firm gates
// ---------------------------------------------------------------------------

/**
 * Inner-step ids that are ALWAYS orchestrator-owned regardless of their
 * `firmGate` flag, because no delegable subagent exists for them.
 *
 * KEEP IN SYNC with the `case 'visual-verify'` arm of `fan-out-instructions.ts`
 * — that switch is the prose authority for the same fact. Matched on BOTH the
 * step id and the agent id, because a custom flow may rename one without the
 * other. This is a floor, not the mechanism: the flag is what authors set.
 */
export const ALWAYS_GATED_INNER_IDS: ReadonlySet<string> = new Set(['visual-verify']);

/**
 * True when this stage must NOT be folded into a delegated batch — either the
 * author flagged it a firm gate, or it is structurally undelegable.
 */
export function isFirmGateInnerStep(inner: FanOutInnerStep): boolean {
  return (
    inner.firmGate === true ||
    ALWAYS_GATED_INNER_IDS.has(inner.id) ||
    ALWAYS_GATED_INNER_IDS.has(inner.agent)
  );
}

/** One piece of a split inner chain: a delegable batch, or a single firm gate. */
export type FanOutSegment =
  | { kind: 'batch'; steps: FanOutInnerStep[] }
  | { kind: 'gate'; step: FanOutInnerStep };

/**
 * Split an inner chain into batches and firm gates, preserving order.
 * Consecutive non-gated stages coalesce into one batch; each gate stands alone.
 */
export function segmentFanOutInner(inner: ReadonlyArray<FanOutInnerStep>): FanOutSegment[] {
  const segments: FanOutSegment[] = [];
  let current: FanOutInnerStep[] = [];

  for (const step of inner) {
    if (isFirmGateInnerStep(step)) {
      if (current.length > 0) {
        segments.push({ kind: 'batch', steps: current });
        current = [];
      }
      segments.push({ kind: 'gate', step });
      continue;
    }
    current.push(step);
  }
  if (current.length > 0) segments.push({ kind: 'batch', steps: current });

  return segments;
}

// ---------------------------------------------------------------------------
// Naming — the single source of truth for script identity
// ---------------------------------------------------------------------------

/** The namespace every generated cyboflow file carries (WorkflowBundleWriter's). */
const CYBOFLOW_PREFIX = 'cyboflow-';

/** Max characters per slug segment — keeps the composed basename well under any FS limit. */
const MAX_SEGMENT = 40;

/** Attempt bound per item inside a batch — mirrors the prose "up to 3 attempts". */
const MAX_ITEM_ATTEMPTS = 3;

/**
 * Reduce an arbitrary, user-editable identifier to a filename-safe segment.
 *
 * Load-bearing for SAFETY, not aesthetics: workflow names are validated only as
 * non-empty strings and step/agent ids are explicitly free-form, so a raw value
 * could carry `/`, `..`, quotes, backticks, or newlines — which would escape the
 * target directory when joined into a path, or break/inject the generated
 * JavaScript when interpolated. Everything outside `[a-z0-9-]` collapses to a
 * single dash. Returns `''` for input with no usable characters, which callers
 * treat as unrenderable.
 */
export function slugSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SEGMENT)
    .replace(/-+$/g, '');
}

/**
 * The LOGICAL bundle name for a batch script — i.e. WITHOUT the `cyboflow-`
 * prefix, because `WorkflowBundleWriter` prepends that itself when it writes.
 * Keyed by the batch's FIRST stage id, which is unique within the chain.
 * Returns `null` when any segment slugs to empty.
 */
export function fanOutBatchLogicalName(
  workflowName: string,
  outerStepId: string,
  firstInnerId: string,
): string | null {
  const parts = [slugSegment(workflowName), slugSegment(outerStepId), slugSegment(firstInnerId)];
  if (parts.some((p) => p.length === 0)) return null;
  return parts.join('-');
}

/**
 * The INVOCABLE workflow name — what `meta.name` carries, what the on-disk
 * basename is (`<name>.js`), and what the prompt passes to `Workflow({name})`.
 * Exactly `cyboflow-` + the logical name, so the three can never drift.
 */
export function fanOutBatchWorkflowName(
  workflowName: string,
  outerStepId: string,
  firstInnerId: string,
): string | null {
  const logical = fanOutBatchLogicalName(workflowName, outerStepId, firstInnerId);
  return logical === null ? null : `${CYBOFLOW_PREFIX}${logical}`;
}

// ---------------------------------------------------------------------------
// Emission helpers
// ---------------------------------------------------------------------------

/**
 * Encode any value as a JavaScript literal via JSON.
 *
 * EVERY interpolated value in the emitted script goes through this — names,
 * descriptions, ids, agent types. Raw interpolation of a free-form id carrying a
 * quote, backtick, newline, or `${` would produce broken or injected source.
 */
function lit(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Human label for an inner step (its `name`, falling back to its id). */
function innerLabel(inner: FanOutInnerStep): string {
  return inner.name !== undefined && inner.name.trim().length > 0 ? inner.name : inner.id;
}

/**
 * Resolve a stage's loopback target INDEX within the batch.
 *
 * Mirrors the prose rule (`step.loopback` when set, else the chain's first
 * stage), but clamped to this batch: a loopback pointing at a stage in an
 * earlier batch or at a gate cannot be re-driven from inside here, so it falls
 * back to the batch's own first stage and the orchestrator sees the failure in
 * the returned trail. `-1` when the batch is empty.
 */
function loopbackIndex(steps: FanOutInnerStep[], step: FanOutInnerStep): number {
  const target = step.loopback;
  if (target !== undefined && target.length > 0) {
    const idx = steps.findIndex((s) => s.id === target);
    if (idx >= 0) return idx;
  }
  return steps.length > 0 ? 0 : -1;
}

// ---------------------------------------------------------------------------
// The rendered script
// ---------------------------------------------------------------------------

/**
 * Render the dynamic-workflow script for ONE batch of consecutive non-gated
 * stages.
 *
 * The emitted script takes the wave as `args` — item objects the orchestrator
 * composes (`{ id, ref?, title?, brief?, expectedFiles? }`) — and runs each
 * item's full sub-chain CONCURRENTLY with the others (`parallel` over items, a
 * sequential stage loop inside each). Per-item loopback is handled in-script and
 * bounded by {@link MAX_ITEM_ATTEMPTS}; an `optional` stage that fails is
 * skipped rather than failing its item. It performs NO cyboflow writes and
 * reaches no MCP tool.
 *
 * @returns The script source, or `null` when the batch is empty or its name
 *   cannot be slugged.
 */
export function renderFanOutBatchScript(
  workflowName: string,
  step: WorkflowStep,
  steps: FanOutInnerStep[],
): string | null {
  if (steps.length === 0) return null;

  const name = fanOutBatchWorkflowName(workflowName, step.id, steps[0].id);
  if (name === null) return null;

  const labels = steps.map(innerLabel);
  const description =
    `Run the ${labels.join(' → ')} sub-chain of ${step.id} for each item in a wave, ` +
    'concurrently per item; returns each item\'s stage trail and writes no cyboflow state.';

  // The stage table is emitted as data so the chain loop stays generic (and so a
  // hostile id cannot reach the source as code — every field goes through lit()).
  const stageTable = steps
    .map((s, i) => {
      const parts = [
        `  { id: ${lit(s.id)}`,
        `label: ${lit(innerLabel(s))}`,
        `agentType: ${lit(`${CYBOFLOW_PREFIX}${s.agent}`)}`,
        `optional: ${s.optional === true ? 'true' : 'false'}`,
        `loopbackTo: ${loopbackIndex(steps, s)}`,
      ];
      return `${parts.join(', ')} }${i === steps.length - 1 ? '' : ','}`;
    })
    .join('\n');

  // NOTE ON CONSTRUCTS: no `isolation` (lanes deliberately SHARE one worktree — a
  // per-agent worktree would break lane verification and the settled-tree test
  // run); no Date.now()/Math.random()/argless new Date() (they throw inside a
  // script body). `parallel` over ITEMS with a sequential loop inside each is what
  // gives per-item pipelining with no cross-item barrier between stages.
  return `${'/'}* GENERATED by cyboflow (fanOutStageScript.ts) — do not edit. *${'/'}
export const meta = {
  name: ${lit(name)},
  description: ${lit(description)},
  phases: [${labels.map((l) => `{ title: ${lit(l)} }`).join(', ')}],
}

// One schema'd result per stage. \`outcome\` is the DOMAIN verdict and is
// authoritative: an agent that finishes normally while reporting a blocking
// review or a failed verification MUST return 'blocked'/'failed' here. The
// orchestrator reads these back and performs every cyboflow write itself.
const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    outcome: {
      type: 'string',
      enum: ['ok', 'blocked', 'failed', 'not_applicable'],
      description:
        "'ok' = stage succeeded. 'blocked' = finished but the work is not acceptable " +
        '(blocking review comments, failing verification, unmet acceptance criteria). ' +
        "'failed' = could not complete. 'not_applicable' = nothing to do for this item.",
    },
    summary: { type: 'string', description: 'What you did, or why it is blocked/failed. 1-4 sentences.' },
    filesTouched: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths written.' },
    findings: {
      type: 'array',
      description: 'Out-of-scope or minor issues worth human triage. Blocking issues belong in outcome/summary.',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          title: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['severity', 'title'],
      },
    },
    visualTask: {
      type: 'string',
      description:
        'Verbatim JSON fence for the visual merge-gate when this stage produces one; omit otherwise. ' +
        'The orchestrator forwards it to cyboflow_request_verification — do not act on it yourself.',
    },
  },
  required: ['outcome', 'summary'],
}

const STAGES = [
${stageTable}
]

const MAX_ATTEMPTS = ${MAX_ITEM_ATTEMPTS}

${'/'}** Compose the per-stage prompt for one item. *${'/'}
function buildPrompt(stage, item, trail, attempt) {
  const lines = [
    'You are running the ' + stage.label + ' stage for ONE item of a cyboflow fan-out.',
    '',
    'Item id: ' + String(item && item.id),
  ]
  if (item && item.ref) lines.push('Item ref: ' + String(item.ref))
  if (item && item.title) lines.push('Title: ' + String(item.title))
  if (item && item.brief) lines.push('', String(item.brief))
  if (item && item.expectedFiles && item.expectedFiles.length > 0) {
    lines.push('', 'Expected files: ' + item.expectedFiles.join(', '))
  }
  if (attempt > 1) lines.push('', 'This is attempt ' + attempt + ' for this item.')
  if (trail.length > 0) {
    lines.push('', 'Earlier stages for this item:')
    for (const entry of trail) {
      lines.push('- ' + entry.id + ' [' + entry.outcome + ']: ' + String(entry.summary || ''))
    }
  }
  lines.push(
    '',
    'Work ONLY on this item, in the shared worktree. Do NOT commit, do NOT touch',
    'cyboflow state, and do NOT start work belonging to another item.',
    'Return the structured result: set outcome to the DOMAIN verdict (a blocking',
    'review or a failed check is "blocked", not "ok"), and list every file you wrote.',
  )
  return lines.join('\\n')
}

${'/'}**
 * Walk ONE item through the whole batch. Sequential across stages for this item,
 * but every item runs its own copy of this loop concurrently — so no item waits
 * on a sibling. A blocked/failed required stage jumps back to its loopback target
 * and re-runs, bounded by MAX_ATTEMPTS; an optional one is skipped.
 *${'/'}
async function runItem(item) {
  const trail = []
  let i = 0
  let attempt = 1

  while (i < STAGES.length) {
    const stage = STAGES[i]
    const result = await agent(buildPrompt(stage, item, trail, attempt), {
      label: stage.id + ':' + String(item.id),
      phase: stage.label,
      schema: RESULT_SCHEMA,
      agentType: stage.agentType,
    })

    // A null result means the agent died or was skipped — treat it as a failure
    // of this stage rather than dropping it silently.
    const entry = result && result.outcome
      ? { id: stage.id, ...result }
      : { id: stage.id, outcome: 'failed', summary: 'agent produced no result' }
    trail.push(entry)

    if (entry.outcome === 'ok' || entry.outcome === 'not_applicable') {
      i += 1
      continue
    }

    if (stage.optional) {
      trail.push({ id: stage.id, outcome: 'not_applicable', summary: 'optional stage skipped after failure' })
      i += 1
      continue
    }

    if (attempt >= MAX_ATTEMPTS) {
      return { itemId: item.id, outcome: 'failed', failedStage: stage.id, attempts: attempt, trail }
    }

    attempt += 1
    i = stage.loopbackTo
    log('item ' + String(item.id) + ': ' + stage.id + ' ' + entry.outcome + ' — retrying from ' + STAGES[i].id + ' (attempt ' + attempt + ')')
  }

  return { itemId: item.id, outcome: 'ok', attempts: attempt, trail }
}

const items = Array.isArray(args) ? args.filter((it) => it && it.id !== undefined) : []
if (items.length === 0) {
  log('no items in this wave — nothing to dispatch')
  return { stages: STAGES.map((s) => s.id), results: [] }
}

log('dispatching ' + items.length + ' item(s) through ' + STAGES.length + ' stage(s)')

const settled = await parallel(items.map((item) => () => runItem(item)))

const results = settled.map((entry, i) =>
  entry || { itemId: items[i].id, outcome: 'failed', attempts: 0, trail: [], failedStage: STAGES[0].id },
)

return { stages: STAGES.map((s) => s.id), results }
`;
}

/**
 * Render every batch script for a resolved definition's fan-out steps.
 *
 * Returns one entry per BATCH, keyed by the LOGICAL bundle name (the writer adds
 * the `cyboflow-` prefix). Firm gates produce no script — they stay with the
 * orchestrator — and an unslug-able batch is skipped silently, falling back to
 * the prose path for those stages.
 */
export function renderFanOutBatchScripts(
  workflowName: string,
  steps: ReadonlyArray<WorkflowStep>,
): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = [];
  for (const step of steps) {
    const fanOut: FanOutSpec | undefined = step.fanOut;
    if (fanOut === undefined) continue;
    for (const segment of segmentFanOutInner(fanOut.inner)) {
      if (segment.kind !== 'batch') continue;
      const content = renderFanOutBatchScript(workflowName, step, segment.steps);
      const logical = fanOutBatchLogicalName(workflowName, step.id, segment.steps[0].id);
      if (content === null || logical === null) continue;
      out.push({ name: logical, content });
    }
  }
  return out;
}
