# PTY workflow runs as dynamic workflows (feasibility)

Status: **feasibility assessment — nothing built.** Investigation only; no
production code changed on this branch.

**Question.** Today an interactive (PTY) workflow run is walked by a *manual
orchestrator*: the run's prompt body (`workflows/<flow>.md` + the derived
step-reporting and fan-out appends) tells a top-level `claude` REPL agent to
sequence the DAG itself, delegating heavy phases to `cyboflow-<agent>` subagents
via the Agent tool. Can that walk instead be handed to Claude Code's **dynamic
workflows** (the in-session `Workflow` tool) *inside the same interactive
session*?

**Verdict: yes, and cyboflow is unusually well-positioned for it — but only in
the phase-scoped form (Option B below).** Every mechanism the change needs
already exists in the tree or in the CLI; the whole-DAG form (Option C) breaks
three live invariants and should not be the target. There is one genuine
blocking defect to fix first (premature rest, §4.1) and one unverified
assumption that needs a live probe (MCP reach from workflow subagents, §5).

---

## 1. What exists today

| Piece | Where | State |
| --- | --- | --- |
| Manual orchestrator prompt | `main/src/orchestrator/workflows/*.md` | live |
| Step-reporting append (flattened step ids → `cyboflow_report_step`) | `main/src/orchestrator/prompts/step-reporting-instructions.ts` | live |
| Fan-out append (per-item chain, concurrency cap, loopback rules) | `main/src/orchestrator/prompts/fan-out-instructions.ts` | live |
| Phase subagents written into the worktree `.claude/agents/cyboflow-*.md` | `main/src/services/panels/claude/workflowBundleWriter.ts` | live |
| `ultracode` session setting → `--settings '{"ultracode":true}'` | `interactiveClaudeManager.ts:664` | live, **quick sessions only** |
| Dynamic-workflow **detection** + live progress visualisation | `main/src/orchestrator/dynamicWorkflows/`, `frontend/src/stores/dynamicWorkflowStore.ts` | live, **passive** |
| Blocking human gate over MCP | `cyboflow_request_user_input` (`mcpServer/cyboflowMcpServer.ts:508`) | live |

The header of `shared/types/dynamicWorkflows.ts` states the current boundary
plainly: *"Cyboflow does NOT launch these itself — it passively DETECTS that a
session's agent launched one."* This proposal is about crossing that line
deliberately.

Note the shape of what's already there: the fan-out append exists **because**
sprint/ship parallelism (DAG waves, the 5-lane cap, the per-task
`implement → write-tests → code-review → task-verify → visual-verify` chain with
loopback-to-`implement`) had to be re-expressed as prose for an agent to execute
by hand. That prose is a hand-rolled `pipeline()` with a concurrency cap. The
`Workflow` tool's `pipeline(items, ...stages)` is the same construct as a
deterministic primitive. That correspondence is the core of the opportunity.

## 2. The three mechanisms the change needs — all present

**(a) A trigger.** The `Workflow` tool requires explicit opt-in. Two of its
accepted forms are already reachable:

- `--settings '{"ultracode":true}'` makes the opt-in *standing* for the session.
  The interactive manager already emits exactly this flag for
  `effort: 'ultracode'`; workflow runs simply never set it (it is wired only
  through the "Ultracode" wizard card for quick sessions — `ipc/session.ts:1314`).
  Plumbing it for workflow runs is small.
- The run's prompt is delivered as claude's **positional argv prompt**, i.e. as a
  *user turn* (`interactiveClaudeManager.ts:1116-1140`). A prompt body that says
  "run the saved workflow `cyboflow-sprint-fanout`" satisfies the tool's
  "user asked to run a specific named or saved workflow" opt-in on its own.

**(b) Script delivery.** Verified: the CLI binary at `2.1.231` resolves named
workflows from `.claude/workflows/` (string present in the bundle).
`WorkflowBundleWriter` already installs namespaced `cyboflow-*.md` files into the
worktree's `.claude/commands` and `.claude/agents`, with a merge-safe
write-clears-prior-cyboflow-set contract and a remove that touches only
`cyboflow-*`. A third target dir (`.claude/workflows`, `cyboflow-*.js`) is a
mechanical extension of that class — same namespace rule, same lifecycle.

**(c) MCP reach.** The `Workflow` tool documents that workflow agents reach all
session-connected MCP tools via `ToolSearch`. The interactive session already
injects the cyboflow stdio server via `--mcp-config
<worktree>/.cyboflow/interactive-mcp.json`, and `cyboflow` is explicitly never
disable-able. **Unverified in this environment** — see §5.

## 3. Design options

### Option A — status quo (manual orchestrator)

Keep as is. Cost: the fan-out prose is a deterministic algorithm expressed as
natural language, re-interpreted by the model on every run. It is the single
largest source of run-to-run variance in sprint/ship.

### Option B — phase-scoped dispatch **(recommended)**

The top-level PTY agent stays the orchestrator, the single writer, and the human
seam. It changes *how it executes one step*: for a step carrying `fanOut` (and
only those), instead of hand-rolling N Agent-tool calls with a manual wave
counter, it calls `Workflow({name: 'cyboflow-<flow>-<step>', args: [...items]})`
once. Cyboflow renders that script from the step's `FanOutSpec` — `inner` chain →
`pipeline()` stages, `effectiveMaxConcurrency` → item batching, `loopback` →
a bounded retry loop inside the stage — and installs it into
`.claude/workflows/` next to the agent bundle.

Preserved by construction:

- **Single writer.** Step reporting and entity writes stay in the main session,
  between `Workflow` calls. The existing step-reporting append is unchanged.
- **Human gates.** `human: true` steps never enter a script; the top-level agent
  still handles them conversationally.
- **Prompt/DAG parity.** The fan-out append becomes a *short* pointer to the
  named workflow instead of ~200 lines of re-derived prose. The DAG stays the
  single source of truth — the script is rendered from it, exactly as the append
  is today.

Gained: deterministic waves, real concurrency capping, per-item pipelining with
no barrier between stages, and — free — the existing `DynamicWorkflowTracker`
visualisation of every lane, which today shows nothing for a manual fan-out.

### Option C — whole-DAG-as-one-script

Render the entire `WorkflowDefinition` to one script and call `Workflow` once.
Rejected for now; it breaks three live invariants:

1. **Single writer.** Every phase agent would need `cyboflow_*` to write
   entities. The step-reporting append states the opposite as a rule:
   *"The Agent-tool subagents you delegate heavy phases to are deliberately
   scoped WITHOUT the cyboflow tools."*
2. **Step timeline.** One `Workflow` call is one tool call; nothing reports back
   until it returns, so `step_results` would freeze for the whole run unless
   subagents call `cyboflow_report_step` themselves (which is exactly (1)).
   `cyboflow_report_step` is documented as observational-only, so a narrow
   carve-out is defensible — but it is a decision, not a detail.
3. **Human gates.** A gate mid-DAG would have to block inside a subagent on
   `cyboflow_request_user_input` for a potentially unbounded time (§4.3).

Option C becomes reasonable *after* B ships and those three are settled. Note
that this is essentially the `programmatic` execution model
(`docs/proposals/sdk-program-driven-workflows.md`) re-hosted on the PTY — worth
naming, because that proposal's hard rule is **interactive ⇒ orchestrated**, on
the stated grounds that "a `claude` REPL has no in-process control channel for a
host loop to drive." Dynamic workflows are precisely such a channel, in-process
to the REPL rather than to the main process. If Option C is ever pursued, that
rule and its rationale need revisiting rather than quiet contradiction.

## 4. Blockers and risks

### 4.1 Premature rest — the one genuine blocker

`RunExecutor.registerTurnEndRest` (`runExecutor.ts:1220`) rests an interactive run
into `awaiting_review` on **every** turn-end. The `Workflow` tool returns
immediately and runs in the background; the agent then yields, which is a
turn-end. So the run would be marked resting while its workflow is still
executing, and the completion notification would arrive to an already-rested run.

Fix: gate the rest on "no `running` dynamic workflow tracked for this runId".
The `DynamicWorkflowTracker` already holds exactly that state, keyed by `runId`
(`DynamicWorkflowRunState.status === 'running'`), and already emits on change —
so the rest can be deferred and re-driven off the tracker's completion signal.
This is a small, well-scoped change, but it must land **before** anything
launches a workflow from a workflow run.

### 4.2 Cancel / pause

Fine as is. `AbstractCliManager.killProcessTree` kills the CLI's whole descendant
tree, and workflow agents run inside the CLI process, so an existing cancel
already stops them. No new teardown path needed. Resume is *not* covered — the
tool's `resumeFromRunId` is same-session only, so a cancelled workflow re-runs
from scratch on retry.

### 4.3 Human gates from inside a script

`cyboflow_request_user_input` explicitly *"BLOCKS until the human answers"*, so a
gate is mechanically expressible from a subagent. The risk is duration: a gate
may sit open for hours and no MCP tool timeout is configured anywhere in
`main/src` (defaults apply). Option B sidesteps this entirely by keeping gates at
the top level. Do not put a gate inside a script without first measuring the
default MCP tool timeout.

### 4.4 Worktree isolation collision

The tool's `isolation: 'worktree'` gives each agent its own git worktree. Cyboflow
already runs the whole run in a worktree, and per `CLAUDE.md` sprint lanes
deliberately **share one worktree**. Rendered scripts must never set
`isolation` — a nested worktree per lane would break the shared-tree assumption
that lane verification and the final settled-tree `test:unit` run depend on.

### 4.5 Script authoring constraints

Rendered scripts are plain JS (no TypeScript), and `Date.now()` / `Math.random()` /
argless `new Date()` throw inside a script body (they would break resume). A
renderer must not emit timestamps or ids from those sources — pass them through
`args`. Scripts also have no filesystem access in the body (agents do).

### 4.6 Agent-count guideline

The session-level "Dynamic workflow size" guideline caps workflows at ~15 agents
by default. A sprint with 5 concurrent lanes × a 5-step inner chain is 25 agent
calls over the run (concurrency-capped, not simultaneous), which reads as over the
guideline. Worth confirming how the cap is counted before rendering large fan-outs.

### 4.7 Detection did NOT cover workflow runs — corrected

**This section originally claimed tracking needs no new detection work. That was
wrong, and the adversarial review caught it.** `WorkflowScriptWatcher` is indeed
filesystem-based and substrate-independent (it exists because claude 2.1.177 made
the session `<uuid>` a directory, breaking stream-based detection on the
interactive substrate). But the tracker only *started* a watcher when it could
resolve a worktree path, and it resolved that path exclusively through
`SELECT worktree_path FROM sessions WHERE id = ?`.

A **flow run has no `sessions` row** — the orchestrator invariant is
`panelId === runId === sessionId`, and `getDbSession(sessionId)` is undefined for
it (the gate-vehicle discriminator in `interactiveClaudeManager.spawnCliProcess`
depends on exactly that). So the lookup returned null, no watcher started, and —
with stream detection also inoperative on the interactive layout — a dynamic
workflow launched inside a PTY **workflow run** was invisible to the tracker
entirely. Only quick sessions (which do own a `sessions` row) were ever tracked.

Fixed: `DynamicWorkflowRunContext` now carries the spawn's authoritative
`worktreePath`, passed by both managers, with the `sessions` lookup retained as
the quick-session fallback.

## 5. What is not verified

- **MCP reach from a workflow subagent.** Documented by the tool, not observed
  here. This is the load-bearing assumption for any variant where lane agents
  write entities (`cyboflow_update_sprint_task` drives lane `current_step`).
  Cheapest probe: a `pnpm dev` session on a scratch project, one hand-written
  `.claude/workflows/probe.js` whose single agent is asked to call
  `cyboflow_get_run` via ToolSearch, and check whether it resolves.
- **Named-workflow resolution from a worktree's `.claude/workflows/`.** The
  string is present in the CLI bundle; project-scoped resolution (as opposed to
  `~/.claude/workflows`) was not exercised. Same probe covers it.
- **Whether flag-tier `ultracode` composes with the run's other
  `--settings` keys** (`fastMode`, `hooks`, `enabledPlugins` all ride one JSON
  object). Probably fine — it is additive — but it is a one-line probe.

## 6. Suggested staging

1. **Probe** (§5) — half a day, decides everything downstream.
2. **Fix premature rest** (§4.1) — independently correct, and a prerequisite.
   Ships and is testable on its own.
3. **Renderer** — `FanOutSpec` → workflow script, as a pure function beside
   `fan-out-instructions.ts` (same no-DB/IPC/fs constraint, same fail-soft
   contract: no renderable fan-out ⇒ empty, never a throw).
4. **Writer** — extend the bundle writer to a third `.claude/workflows` target
   with the same `cyboflow-` namespace and merge-safe remove.
5. **Prompt swap** — behind a per-workflow opt-in, replace the fan-out prose
   append with the named-workflow pointer. Both appends stay derived from the
   resolved definition, so the DAG remains the single source of truth.
6. **Measure** — sprint run-to-run variance and wall-clock, prose vs script,
   before making it the default.

Steps 1–2 are worth doing regardless of whether the rest proceeds.
