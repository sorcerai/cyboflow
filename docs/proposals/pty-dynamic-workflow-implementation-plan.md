# Implementation plan — PTY fan-out steps as dynamic workflows (v2, post-review)

Companion to `pty-dynamic-workflow-orchestration.md`.

**v1 of this plan was adversarially reviewed by two independent reviewers
(Claude Fable 5 and Codex). Both rejected it.** They converged on four defects
that invalidate its core design, and each found one the other missed. This v2
records the outcome, states what was built, and states what must be redesigned
before any of the rest is worth writing.

Status: **Planks A–C (defect fixes), D–G (the redesign), and H (firm gates +
batching) built and green, default OFF. All three CLI assumptions VERIFIED
against claude 2.1.231** — see "CLI assumptions" below, including a fourth
finding (dispatch is permission-gated, and only `auto` works) that must be
handled before the mode is switched on.

---

## What the review changed

### The dispatch shape is wrong (both reviewers, independently)

v1 proposed one `Workflow` call per fan-out step, executing the whole per-item
inner chain. That cannot work, for reasons that are structural rather than
fixable in the renderer:

- **The lane chain is not a pure agent pipeline.** Between inner steps the main
  session does entity work: it moves `current_step` via
  `cyboflow_update_sprint_task`, carries `attempt: <n>` on loopback, files
  findings with `cyboflow_report_finding`, and makes ONE git commit per task on
  success (`fan-out-instructions.ts:275-293`). One opaque phase-wide call leaves
  no control point for any of it.
- **`visual-verify` is not an agent stage at all.** The prose is explicit:
  *"there is NO subagent to delegate for this step; YOU fire the request"*
  (`fan-out-instructions.ts:141-165`). The main session calls
  `cyboflow_request_verification`, parks the lane at `awaiting-verify`, and an
  async external verdict drives it off the park. The `cyboflow-visual-verify`
  agent that exists is the *central* verifier, deployed by the main-process
  scheduler into an isolated snapshot worktree with `$VERIFY_*` env — invoked as
  a bare `agentType` in the lane's shared worktree it cannot function. Worse,
  the step is `optional: true`, so v1's "optional ⇒ skip on failure" rule would
  have silently converted the visual merge-gate into a guaranteed skip.
- **Domain failure is not promise failure** (Codex). `code-review` and
  `task-verify` return *normally* while reporting `REVIEW: BLOCKING` /
  `VERDICT: FAIL`. The programmatic controller has explicit parsers for exactly
  this (`workflowController.ts:947,1003`). A `runStage` keyed on rejection treats
  a blocking review as success.
- **Wave selection is not a concurrency cap** (Codex). The current orchestration
  dispatches dependency-ready, file-disjoint waves and re-resolves added/removed
  tasks at every wave boundary (`workflowController.ts:1124,1180,1261`). A frozen
  ID list plus a cap does none of that.

### The MCP-reach question was already answered — no (both reviewers)

v1 treated subagent MCP reach as an open probe that "decides everything". It is
closed, in the repo: every lane agent pins an explicit allowlist —
`tools: Read, Edit, Write, Bash, Grep, Glob` — and each is documented "Never
writes cyboflow state" (`sprint/agents/*.md`). Granting them `cyboflow_*` would
break the single-writer invariant that the step-reporting append states to the
model verbatim, which is the same invariant for which the feasibility doc
rejected Option C.

### The tracker could not see workflow runs at all (Codex only)

The decisive find, and the one that made Plank 1 unimplementable as designed:
the tracker resolved its watcher's worktree path only through the `sessions`
table, and a flow run has no `sessions` row. See §4.7 of the feasibility doc.

### Consequently

**The viable design is stage-major, host-controlled dispatch**, not item-major:
the top-level agent dispatches ONE ready, file-disjoint wave of ONE inner step at
a time, agents return typed structured results and write nothing, and the main
session reconciles through the router chokepoints between calls. That preserves
single-writer, keeps lane progress live, keeps `visual-verify` host-owned, and
keeps wave re-resolution. It is a materially different and larger design than v1,
and it still rests on three unverified CLI behaviours (below).

## What was built

### Plank A — the tracker blind spot (live defect, fixed)

`DynamicWorkflowRunContext.worktreePath`, passed by both managers from the
spawn's own `options.worktreePath`, with the `sessions` lookup kept as the
quick-session fallback. Without it no dynamic workflow inside a PTY *workflow
run* was ever tracked.

Tests: `dynamicWorkflows/__tests__/dynamicWorkflowTrackerWatcher.test.ts` (8),
including a case pinning the pre-fix behaviour (no watcher for a flow run that
supplies no path).

### Plank B — quick-session premature completion (live defect, fixed)

`index.ts`'s quick-session turn-end listener flipped `sessions.status` to
`'completed'` on the turn-end that follows a `Workflow` launch. This is reachable
**today**: the Ultracode wizard card launches quick PTY sessions with
`--settings '{"ultracode":true}'`, which is precisely the setting that makes the
agent fan work out as dynamic workflows. Now guarded on
`hasRunningForRun(runId)`.

No stuck-session risk: a live agent turns again on the completion notification
(that turn-end rests it), and a dead agent is covered by the process-exit handler
that already writes `'completed'`/`'stopped'` (`events.ts:435-500`).

Not unit-tested — it is a guard clause inside the composition root's inline
listener, which has no existing test harness. Its predicate is tested.

### Plank C — the workflow-run rest guard

`RunExecutor` takes an optional `hasRunningDynamicWorkflow` probe (slot 17) and
skips the event-driven rest while it holds.

Two review findings shaped this:

- Codex disproved v1's premise that a redundant rest is harmless.
  `onLifecycleTransition` runs its side effects — task-stage derivation, usage
  rollup, compound-findings close-out — *even when the status transition is
  rejected as a race* (documented at its `catch`), and the compound close-out
  clears `selected` on still-pending seeded findings.
- Both reviewers showed v1's 2500ms defer timer is unsafe: a question ask is
  itself a turn-end, so a timer armed before the human answers can fire while the
  run is legitimately mid-turn again — and `restAwaitingReview`'s
  `status === 'running'` guard *passes* in exactly that state.

So the guard ships **without** the defer timer. This leaves a known residual: the
launch is observed by a 1s-poll watcher, so a turn-end inside that window still
rests. Closing it needs a deferred re-check gated on a per-run execution epoch +
turn generation + `hasTurnInFlightForSession`, which belongs with the change that
makes dispatch routine. Documented at the call site.

Tests: 2 added to `runExecutor.test.ts` (guarded arm; no-probe arm byte-identical).

**Gate:** `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test:integration`
(25), `pnpm test:unit` (8890 main + 3752 frontend, 0 failures).

## The stage-major build (Planks D–G)

### Plank H — firm gates and batching (the efficiency change)

The first cut was strictly stage-major: one dispatch per stage, orchestrator
re-entered between every one. That is maximally safe and needlessly slow — it
reintroduces a barrier at every stage boundary, which is most of what the
workflow path was supposed to remove.

`FanOutInnerStep.firmGate` now marks the stages where the orchestrator genuinely
must regain control. Everything else batches: a maximal run of consecutive
non-gated stages is dispatched as ONE workflow, and each item walks that whole
sub-chain (`implement → write-tests → code-review → task-verify`) inside it,
concurrently with the other items, retrying its own loopback up to 3 attempts —
with no return to the orchestrator in between. For the built-in sprint and ship
chains that is one dispatch instead of four, and a fast item is never held at a
barrier waiting for a slow sibling.

**Only `visual-verify` carries `firmGate: true`,** and it is a gate for a
structural reason rather than a cautious one: it has no subagent at all. The
orchestrator fires `cyboflow_request_verification` and parks the lane while an
async external verdict drives it. `ALWAYS_GATED_INNER_IDS` keeps that true even
if an author clears the flag.

**The trade, taken deliberately:** lane `current_step` no longer ticks per stage
inside a batch. Each result carries the item's full `trail`, and the orchestrator
backfills the stage history when the batch returns — so nothing is lost but live
per-stage granularity, and the dynamic-workflow tracker still shows per-agent
progress throughout. The prompt states this in as many words.

### Plank D — the batch-script renderer

`orchestrator/prompts/fanOutStageScript.ts`, a pure sibling of
`fan-out-instructions.ts`. Renders ONE inner stage of a fan-out step into a
`.claude/workflows/*.js` script that fans that stage across ONE already-chosen
wave and returns schema-validated per-item results. Every review constraint is
enforced and tested:

- **Host-owned stages are never rendered.** `HOST_OWNED_INNER_IDS` (matched on
  BOTH step id and agent id, since a custom flow may rename one) keeps
  `visual-verify` on the prose path, with its request/park protocol verbatim.
- **Domain outcome, not promise outcome.** Each agent returns
  `{outcome: ok|blocked|failed|not_applicable, summary, filesTouched, findings,
  visualTask}`. A blocking review is `blocked`, not a resolved promise. A null
  agent slot becomes a `failed` item rather than a silently dropped one.
- **Injection + traversal safety.** `slugSegment` reduces free-form
  workflow/step/agent ids to `[a-z0-9-]`, and every emitted literal goes through
  `JSON.stringify`. Tested against `../../etc/passwd`, quotes, backticks,
  `${...}`, and newlines.
- **Name drift is structurally impossible.** `fanOutStageLogicalName` (what the
  writer prefixes) and `fanOutStageWorkflowName` (`meta.name`, the on-disk
  basename, and the prompt's `Workflow({name})`) derive from one function.
- No `isolation` (lanes share one worktree), no `Date.now`/`Math.random`.
- **Real syntax validation.** Tests compile the emitted source with `vm.Script`
  in the shape the runtime consumes it (meta lifted off, body in an async
  function). `parseScriptMeta` is a fail-soft regex scanner and would accept
  broken source, so it is used only for the tracker round-trip.

### Plank E — the writer

`.claude/workflows/cyboflow-*.js` as a third target. Extension is now a
parameter, not a hardcoded `.md`, so a user's `.js` beside our `.md` is never
touched and generated scripts are actually reclaimed. `write()` reconciles
**before** the empty-bundle early return, so an on→off transition cannot strand a
stale script the CLI would still resolve by name. Target paths are containment-
checked and a name that would escape its directory is skipped, not written.

### Plank F — the install seam

Renders from `resolveRunFrozenSpec` — the run's frozen variant graph, the same
source the prompt resolves — NOT the live `workflows.spec_json` join used for
`workflow_path`; a variant run would otherwise install scripts for a different
chain than its prompt walks. The scripts glob is added to `.git/info/exclude`
only when scripts are actually installed, so dispatch-off leaves the exclude file
byte-identical. Dispatch is a threaded ARGUMENT: the SDK manager passes `'prose'`
explicitly, because this seam is substrate-shared and SDK worktrees consume no
scripts.

### Plank G — prompt + config

`buildFanOutAppend(def, opts?)` gains a `workflow` arm that replaces per-task
Agent-tool delegation with per-stage `Workflow({name, args})` dispatch and an
explicit reconcile step (advance / loopback+attempt / file findings / carry
`visualTask`). It changes only the DELEGATION — wave selection, every
`cyboflow_*` write, the loopback protocol, the visual gate, and the per-task
commit stay with the orchestrator, and the prompt says so. Defaulted to `prose`,
with a test asserting the default arm is byte-identical to an explicit prose
request. A stage whose name cannot be slugged falls back to prose per step.

Config: `FanOutDispatch` lives in `shared/` (both `AppConfig` declarations carry
the field, per the IPC type-parity rule), floors to `'prose'` on absent/invalid,
and is **snapshotted once per spawn** and threaded to both installation and
prompt composition — so a mid-run config flip can never leave a run whose prompt
cites scripts its worktree lacks.

**Gate:** `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm test:integration` (25),
`pnpm test:unit` (8947 main + 3752 frontend, 0 failures). 58 new tests.

## CLI assumptions — VERIFIED (claude 2.1.231, 2026-08-14)

Probed empirically against the real CLI in a scratch repo carrying one
`.claude/workflows/cyboflow-probe-stage.js`. All three assumptions hold, and the
probe surfaced a fourth fact that neither reviewer predicted.

1. **The `Workflow` tool IS available without `ultracode`.** ✅ It was invoked in
   every probe, including default settings — a user turn naming a saved workflow
   is sufficient opt-in, as designed.
2. **A worktree-local `.claude/workflows/` DOES resolve by name.** ✅
   `Workflow({name: 'cyboflow-probe-stage'})` resolved and launched
   (`wf_061286ce-20a`) with no path given.
3. **A completion notification DOES re-wake a yielded agent.** ✅ Two distinct
   assistant turns: *"running in the background… I'll report once it completes"*,
   then *"The workflow completed… `PROBE_AGENT_OK`"*. That is exactly the
   yield→re-wake cycle the whole design depends on, and it is why Plank C's rest
   guard matters.
4. **NEW — launching a dynamic workflow is PERMISSION-GATED**
   (`"Review dynamic workflow before running"`), and the matrix is
   counterintuitive:

   | `--permission-mode` | Result |
   | --- | --- |
   | (default / `manual`) | **blocked** — needs interactive approval |
   | `acceptEdits` | **blocked** |
   | `auto` | **allowed** ✅ |
   | `dontAsk` | **DENIED** ❌ |
   | `bypassPermissions` | allowed |

   **Mapping that table onto cyboflow needs care — the flag names and
   cyboflow's mode names collide without meaning the same thing.** The
   interactive path emits exactly ONE permission flag: `--permission-mode auto`,
   and only for `agentPermissionMode === 'auto'`
   (`interactiveClaudeManager.ts:636-638`). Every other mode passes NO flag and
   differs only in whether cyboflow's own wildcard PreToolUse hook is installed.
   So:

   | cyboflow mode | what the CLI sees | dispatch |
   | --- | --- | --- |
   | `auto` | `--permission-mode auto`, no cyboflow hook | **works** (verified) |
   | `default` / `acceptEdits` | CLI default + cyboflow's PreToolUse hook | **unknown** — see below |
   | `dontAsk` | CLI default, NO hook | CLI's own gate prompts **in the terminal** |

   `dontAsk` is the trap: cyboflow documents it as "run unrestricted, equivalent
   to `--dangerously-skip-permissions`" (`permissionModeMapper.ts:5`,
   `shared/types/workflows.ts:37`), which is true of the SDK path (install no
   hook, SDK runs unrestricted) but NOT of the CLI flag of the same name, which
   denies. On the interactive substrate cyboflow does not pass that flag at all,
   so the effect is neither: the CLI's own review gate fires with cyboflow's
   approval plumbing switched off, i.e. a blocking prompt in a terminal nobody is
   watching.

   **Untested:** whether an `allow` from cyboflow's PreToolUse hook pre-empts the
   CLI's dynamic-workflow review gate in `default`/`acceptEdits`. Hooks run first
   in the CLI permission order, which suggests it might, but this was not probed.

   **Recommendation: gate the feature to `agentPermissionMode === 'auto'`** — the
   one combination verified end-to-end — until the `default`/`acceptEdits` case
   is probed.

**Bonus verification:** the on-disk artifact contract the tracker depends on
matches exactly — `<uuid>/workflows/scripts/<name>-wf_<id>.js` (and
`WorkflowScriptWatcher`'s `SCRIPT_RE` extracts the right id from it),
`<uuid>/subagents/workflows/<wf_id>/journal.jsonl` with `started`/`result` lines
keyed by `agentId`, and `<uuid>/workflows/wf_<id>.json` carrying
`status`/`summary`/`agentCount` **plus the script's return value under `result`**
— so the orchestrator gets its structured results back through the completion
record.

One practical finding folded into the prompt: the agent's first instinct was to
try `Skill(<name>)` and `Bash` before reaching for `Workflow`. The dispatch block
now names the Workflow tool explicitly ("not Skill, not Bash").

Still open, and cheap to answer next: whether the ~15-agent workflow size
guideline counts concurrent or cumulative agents.
