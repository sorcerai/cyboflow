/**
 * composeStepPrompt — builds the scoped, single-step prompt that the programmatic
 * runner hands to one agent turn (Stage 2 of the execution-model seam).
 *
 * In the programmatic model the HOST sequences the DAG, so each agent turn is
 * deliberately narrowed to exactly ONE step: do this step's work (delegating to
 * its `cyboflow-<agent>` role), commit any file changes atomically, persist state via the
 * `cyboflow_*` MCP tools, and STOP — do not advance the workflow. The controller,
 * not the agent, decides what runs next. The voice/invariants mirror the
 * orchestrated harness (`customFlowPrompt.ts`) so the same subagent bundle +
 * single-writer contract apply unchanged; only the SCOPE differs (one step, not
 * the whole flow).
 *
 * GROUNDING (taskScope): each programmatic step runs in its OWN fresh SDK session
 * (no memory of prior steps), and — unlike the orchestrated `getPrompt` path — the
 * step prompt does NOT otherwise carry the sprint's task set. A step agent with no
 * task list cannot tell its subagent WHAT to analyze, so it falls back to probing
 * the worktree, finds no task files (cyboflow is DB-canonical — it keeps NO task
 * files on disk), and concludes "no tasks → No dependencies". That dropped the
 * blocking edges on a real sprint, so the dependents ran concurrently with their
 * prerequisite and failed (verified 2026-06-22). When `taskScope` is supplied the
 * host injects the SAME `# Sprint tasks` block the orchestrated path uses, so the
 * agent never has to discover scope on disk. The prose also pins the agent to the
 * installed `cyboflow-<agent>` role (with the runtime adapter selecting the
 * provider-native delegation type) and to
 * faithfully persisting EVERY item the subagent returns (a recurring failure mode:
 * collapsing real dependency edges to "none").
 *
 * ARTIFACT FOLLOW-UP: on the orchestrated plane, `workflows/planner.md` tells the
 * top-level agent what to do with a step's deliverable AFTER its subagent returns
 * (e.g. "read the prototype URL and call `cyboflow_report_artifact`") — but that
 * prose lives in the top-level flow file, which the programmatic plane never
 * loads (each step here is its own fresh, narrowly-scoped agent turn with no
 * access to the flow's full prose). Without an equivalent instruction inlined
 * into the step prompt itself, a step whose `outputArtifact` needs an explicit
 * follow-up (ui-prototype, arch-design) silently never produces one on
 * programmatic runs: the subagent returns its section faithfully, but nothing
 * ever reports it, so the artifact tab stays empty forever (2026-07-06,
 * empty-ui-prototype-tab incident). `composeStepPrompt` now owns mirroring that
 * per-step follow-up via `artifactFollowUp` below — see its doc comment for which
 * atypes need one and why most don't.
 *
 * Pure: no fs / DB / Date / randomness — output depends only on its args, so it
 * is trivially testable. Human-gate steps never reach here (the controller
 * resolves them via the host's human-gate path, not the runner).
 */
import type { WorkflowStep } from '../../../../shared/types/workflows';
import { PROTOTYPE_HTML_RELPATH } from '../../../../shared/types/artifacts';

export interface ComposeStepPromptArgs {
  step: WorkflowStep;
  /** The run's workflow name (e.g. 'planner') — orients the agent. */
  workflowName: string;
  /** 1-based attempt number; >1 means a prior attempt failed and is being retried. */
  attempt: number;
  /**
   * Fan-out item context — present ONLY when this step is one item's inner step
   * of a host-driven fan-out. Absent for every normal single-step invocation, so
   * the single-step prompt output stays byte-identical. When present the agent is
   * scoped to exactly this item (do not touch other items).
   */
  item?: { id: string; over: string };
  /**
   * The sprint's task scope — the pre-rendered `# Sprint tasks` block BODY (the
   * SAME text the orchestrated `getPrompt` path prepends), resolved by the host
   * from the DB. Present ONLY for a seeded sprint-style run; absent (or empty) for
   * planner / non-sprint steps, in which case no task block is added. Grounds the
   * step agent in the real task set so it never has to DISCOVER scope on disk.
   */
  taskScope?: string;
  /**
   * Idea ids this run owns: its launch seed plus ideas it created during
   * execution. Resolved live by the host for each fresh step turn, rather than
   * asking the agent to infer an "active" idea from every project idea.
   */
  runOwnedIdeaIds?: readonly string[];
  /**
   * The run's approved PROJECT BRIEF markdown (launch flow) — the payload of
   * the run's `project-brief` artifact, resolved live by the host for each
   * fresh step turn. Launch's post-brief steps (design, ideas, expand-spec,
   * epics, tasks) all ground in the brief, but a programmatic step agent has
   * no MCP surface to read artifacts — without this section it would probe
   * the (usually empty) worktree and improvise. Absent / empty ⇒ no section
   * (byte-identical prompts; also naturally absent on pre-brief steps and
   * every non-launch flow).
   */
  projectBrief?: string;
  /**
   * The human's per-idea approve-ideas gate decisions — the pre-rendered
   * `- IDEA-014: approve` verdict lines the host read off the run's RESOLVED
   * `gate:human-step:approve-ideas` item (readApproveIdeasDecisionLines).
   * Present only AFTER that batch gate resolved; absent / empty ⇒ no section
   * (output unchanged). The orchestrated plane DELIVERS these decisions into the
   * parked conversation's next turn, but each programmatic step is a fresh agent
   * turn no delivery can reach — so post-gate steps (expand-spec, epics, tasks)
   * learn which ideas were DENIED only through this section.
   */
  approveIdeasDecisions?: string;
  /**
   * Operator GUIDANCE for this step (RunDirectives live steering) — free-text the
   * operator added mid-run via the monitor to steer this step, appended as a tail
   * section when non-empty. Absent / empty ⇒ no guidance section (output
   * unchanged). Unlike `taskScope`/`item` this is per-STEP, not per-run.
   */
  userGuidance?: string;
  /**
   * The §5.1 visual-verification output-contract defect quoted back to a
   * RE-DELEGATED task-verify (verification-agent redesign §5.3). Set ONLY on the
   * single contract re-run: the previous attempt's PASS result carried neither the
   * `## Visual verification task` fence nor a NOT-APPLICABLE line (or an
   * unparseable/duplicate one). Rendered as a section instructing the agent to
   * re-emit its FULL result with exactly one of the two contract forms. Absent /
   * empty ⇒ no section (output unchanged).
   */
  contractError?: string;
  /**
   * The visual merge-gate's failure report quoted VERBATIM to a re-delegated
   * implement step (verification-agent redesign §5.3). Set ONLY on the step a
   * visual-verify FAIL loopback re-drives, so the re-implement agent sees the
   * failed behaviors + evidence rather than "a blocking finding exists". Absent /
   * empty ⇒ no section (output unchanged).
   */
  loopbackFeedback?: string;
  /**
   * Repo paths this run's RUNBOOK BOOTSTRAP wrote
   * (docs/proposals/lane-runbook-bootstrap.md §11), rendered as a do-not-touch
   * list on the address-review step.
   *
   * This is not tidiness. The runbook's machine-local record is content-addressed
   * against the committed file, so ANY edit to it — including a well-meant
   * "fix" — demotes the proof by hash drift and the next verification skips.
   * And the rung-1 config edit is what makes the environment stand up at all, so
   * a reviewer reverting it silently un-proves the environment while leaving the
   * runbook claiming otherwise. address-review is the one step in the chain that
   * "fixes in place", which is why it is the one that has to be told.
   *
   * Absent / empty ⇒ no section (byte-identical prompts on every run that did not
   * bootstrap, which is nearly all of them).
   */
  bootstrapProtectedPaths?: readonly string[];
}

/**
 * Per-atype "report the artifact yourself" addendum for steps whose
 * `outputArtifact` needs an explicit agent follow-up once its subagent returns.
 * Mirrors the equivalent prose in `workflows/planner.md` written for the
 * orchestrated top-level agent — there is no top-level agent on the
 * programmatic plane, so `composeStepPrompt` inlines the same instruction into
 * the scoped step prompt instead.
 *
 * NOT every `outputArtifact` atype needs one: 'idea-spec' and
 * 'decomposed-stories' mint automatically by re-deriving from the entity DB
 * once the step's own `cyboflow_*` writes land as part of "do the work" (step
 * 1 of the numbered list above) — no separate reporting action exists for
 * those, so adding an addendum would just be prompt noise. 'ui-prototype',
 * 'arch-design', 'project-brief', and 'compound-recommendations' have a
 * deliverable that lives OUTSIDE that entity write (a served localhost URL; a
 * subagent-returned section that must be folded into the idea body by hand; a
 * payload-backed markdown doc composed from a subagent's return) — those need
 * to be told explicitly. Any future atype defaults to no addendum (the `default` branch)
 * unless it is proven to need one and added here deliberately.
 */
function artifactFollowUp(
  outputArtifact: NonNullable<WorkflowStep['outputArtifact']>,
  workflowName: string,
): string {
  switch (outputArtifact.atype) {
    case 'ui-prototype':
      return `\n\n## Artifact to report\n\nYour \`cyboflow-ui-prototype\` subagent writes ONE self-contained static HTML+CSS document — no \`<script>\`, no JS, no dev server — to \`$CYBOFLOW_RUN_ARTIFACTS_DIR/${PROTOTYPE_HTML_RELPATH}\`. When it returns its \`## Prototype\` section confirming that file, call \`cyboflow_report_artifact\` yourself with \`atype: 'ui-prototype'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"fileName": "${PROTOTYPE_HTML_RELPATH}"}\` — that call is the ONLY thing that mints this run's UI-prototype tab. Skipping it leaves the tab permanently empty.`;
    case 'arch-design':
      // Launch designs the whole concept BEFORE ideas exist, so the section
      // cannot fold into an idea yet — it lives in the project-brief artifact
      // until the ideas step folds it into the foundation idea.
      if (workflowName === 'launch') {
        return `\n\n## Artifact to report\n\nWhen your \`cyboflow-architecture\` subagent returns its \`## Architecture design\` section, no idea exists yet to fold it into — the brief carries it. Take the \`# Project brief\` section above, append the returned \`## Architecture design\` section to it (REPLACE any existing \`## Architecture design\` section, never stack a second copy), and re-report the brief artifact: \`cyboflow_report_artifact\` with \`atype: 'project-brief'\`, label \`"Project brief"\`, and \`payload_json\` \`{"markdown": "<the full updated brief>"}\`. The later ideas step folds this section into the foundation idea, which is what derives the arch-design tab.`;
      }
      return `\n\n## Artifact to report\n\nWhen your \`cyboflow-architecture\` subagent returns its \`## Architecture design\` section, fold it into the IDEA's body yourself via \`cyboflow_update_task\`: if the body already has an \`## Architecture design\` section, REPLACE that section (never stack a second copy); otherwise append it. The arch-design deliverable tab derives from the body automatically, so you do not report an artifact for this step.`;
    case 'project-brief':
      return `\n\n## Artifact to report\n\nWhen your \`cyboflow-interview\` subagent returns its \`## Project brief\`, call \`cyboflow_report_artifact\` yourself with \`atype: 'project-brief'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"markdown": "<the full brief markdown>"}\` — that call is the ONLY thing that mints this run's Project brief tab, and the approve-brief gate has nothing to review without it. Re-report the same atype after any revision to enrich the same tab.`;
    case 'compound-recommendations':
      return `\n\n## Artifact to report\n\nAfter your \`cyboflow-compounder\` subagent returns its \`## Learnings\` and \`## Discarded\` lists, compose ONE summary-of-recommendations markdown doc — the single thing the human reads at the approve-learnings gate — with TWO top-level sections:\n\n- \`## Act on\` — the learnings that cleared the bar, grouped as \`### Quick fixes\` / \`### CLAUDE.md edits\` / \`### Doc edits\` / \`### Tasks\`, in that order, one entry per learning with its general rule, evidence (recurrence + run ids, files), computed impact, and the proposed change.\n- \`## Discarded\` — the candidates the compounder considered and set aside, one line each with its reason. This is the "here's what I discarded" half of the review. Omit the section only if the compounder returned no discarded list.\n\nCLAUDE.md edits get their OWN section and are never folded into \`### Doc edits\` — CLAUDE.md is loaded into every session of every flow, so its edits carry the strictest bar in this flow (capped at ONE per run; zero is the expected outcome). List each with the exact file + section, the verbatim wording, the text it replaces, and its answers to the compounder's five admission questions. When there are none, keep the heading and write \`None.\` so the human sees the bar was applied. \`### Doc edits\` holds \`docs/*.md\` (incl. CODE-PATTERNS.md / ARCHITECTURE.md) edits only, and those clear their own lower-but-real bar. Drop any proposed instruction-file edit whose rule carries a migration number, run id, version stamp, date, commit SHA, or "we used to" history — that is the incident, not the rule.\n\nThen call \`cyboflow_report_artifact\` yourself with \`atype: 'compound-recommendations'\`, label \`"${outputArtifact.label}"\`, and \`payload_json\` \`{"markdown": "<the doc>"}\`. That call is the ONLY thing that mints this run's recommendations tab; skipping it leaves the gate with nothing to review.\n\nHard limits on what becomes a review-queue item: do NOT emit \`cyboflow_report_finding\` with \`kind:'finding'\` (a finding is Compound's input, not its output), and do NOT emit a \`cyboflow_report_finding\` \`decision\` — or any review item — for a DISCARDED candidate. Discarded candidates live in the \`## Discarded\` section of THIS doc and nowhere else; filing one per drop is exactly the sequential-gate spam this flow must not produce. This flow emits NO \`decision\` review items at all — the final approval is the workflow's own \`human-review\` step (a "merge in changes" gate like Sprint/Ship), not a reported item. Never file a \`decision\` here, at write-back, per edit, or per drop.`;
    default:
      return '';
  }
}

/**
 * Idea-flag persistence contract for the steps that CREATE or REWRITE idea
 * bodies. The conditional design steps below (ui-prototype / architecture) and
 * the flow's build ordering key on flag lines (`SCOPE:` / `UI_PROTOTYPE:` /
 * `ARCH_DESIGN:` / `BUILD_ORDER:` / `INITIAL_BUILD:`) PERSISTED in each idea's
 * body — the long-form flow prose spells this out for the orchestrated plane,
 * but a scoped step turn never sees that prose. Without the contract inlined
 * here, the launch `ideas` step persisted stubs WITHOUT the subagent's flag
 * lines, so ui-prototype and architecture silently self-skipped on every
 * programmatic launch run (2026-08-04, first launch smoke). `expand-spec`
 * (planner / ship / launch) is the rewrite half: it replaces the body and must
 * carry the flag lines through.
 */
function ideaFlagContract(step: WorkflowStep): string {
  switch (step.id) {
    case 'ideas':
      return `\n\n## Idea persistence contract\n\nYour subagent returns each idea with flag lines — \`SCOPE:\`, \`BUILD_ORDER:\`, \`INITIAL_BUILD:\`. When you persist an idea via \`cyboflow_create_task\`, its \`body\` MUST include those flag lines VERBATIM (keep them at the end of the stub), and pass \`scope\` as the entity field too. Later steps read the flags off the persisted body — an idea saved without them loses its build ordering and initial-build tier. Additionally: when the \`# Project brief\` section above carries an \`## Architecture design\` section, fold that section into the LOWEST \`BUILD_ORDER\` initial-build idea's body via \`cyboflow_update_task\` after creating it (replace any existing section, never stack a second copy) — the foundation idea carries the project's architecture from here on, and its arch-design tab derives from it automatically.`;
    case 'expand-spec':
      return `\n\n## Idea persistence contract\n\nIf an idea's current body carries flag lines (e.g. \`SCOPE:\` / \`BUILD_ORDER:\` / \`INITIAL_BUILD:\` / \`UI_PROTOTYPE:\` / \`ARCH_DESIGN:\`) or an \`## Architecture design\` section, the expanded body you write back via \`cyboflow_update_task\` MUST preserve those VERBATIM. Downstream steps read them off the persisted body — dropping them during expansion silently breaks design conditioning and build ordering.`;
    default:
      return '';
  }
}

/**
 * The long-form planner/ship prompts condition these design steps on flags that
 * context persisted into the idea body. Each programmatic step gets a fresh
 * turn, so mirror that decision here before it can delegate or create an
 * artifact. Other optional steps have no equivalent persisted prerequisite.
 *
 * LAUNCH is the exception: its design phase runs on the WHOLE CONCEPT before
 * any idea exists, so the flags live at the end of the approved project brief
 * (threaded into the prompt as the `# Project brief` section), never on ideas.
 */
function conditionalExecution(step: WorkflowStep, workflowName: string, hasRunOwnedIdeas: boolean): string {
  if (workflowName === 'launch') {
    switch (step.id) {
      case 'ui-prototype':
        return `\n\n## Conditional execution\n\nThis flow designs the WHOLE concept before decomposition — condition on the \`# Project brief\` section above, never on ideas. Run this step ONLY when the brief carries \`UI_PROTOTYPE: yes\` (when the brief has no such flag line, judge from the brief itself whether the product has user-facing UI — a CLI/API/library does not). On yes: build ONE whole-product concept mockup from the full brief, showing the core loop end to end. Otherwise skip cleanly: do not delegate, do not write prototype files, do not report an artifact, and end with a one-line skip summary.`;
      case 'architecture':
        return `\n\n## Conditional execution\n\nThis flow designs the WHOLE concept before decomposition — condition on the \`# Project brief\` section above, never on ideas. Run this step ONLY when the brief carries \`ARCH_DESIGN: yes\` (when the brief has no such flag line, run it unless the project is a trivially small single-file tool — most new projects warrant it). On yes: design the PROJECT-LEVEL architecture (stack, repo layout, data model, service seams) from the full brief. Otherwise skip cleanly: do not delegate, do not report anything, and end with a one-line skip summary.`;
      default:
        return '';
    }
  }
  const scope = hasRunOwnedIdeas
    ? 'Read each id in the `## Run-owned idea scope` section directly with `cyboflow_get_task`. Do NOT enumerate project ideas or infer an active idea from other project ideas. Evaluate flags only on these run-owned ideas; when more than one is eligible, handle each eligible idea rather than choosing one.'
    : 'This run has no owned idea yet. Skip this step cleanly: do not list project ideas, infer an active idea, delegate, or create an artifact.';
  switch (step.id) {
    case 'ui-prototype':
      return `\n\n## Conditional execution\n\n${scope} Run this step ONLY for scoped ideas whose persisted spec contains \`UI_PROTOTYPE: yes\`. When no scoped idea has that flag, skip this step cleanly: do not delegate, do not write prototype files, do not report an artifact, and end with a one-line skip summary.`;
    case 'architecture':
      return `\n\n## Conditional execution\n\n${scope} Run this step ONLY for scoped ideas whose persisted spec contains \`ARCH_DESIGN: yes\`. When no scoped idea has that flag, skip this step cleanly: do not delegate, do not change an idea body, and end with a one-line skip summary.`;
    default:
      return '';
  }
}

export function composeStepPrompt(args: ComposeStepPromptArgs): string {
  const { step, workflowName, attempt } = args;
  const retryNote =
    attempt > 1
      ? `\n\nThis is **attempt ${attempt}** — a previous attempt at this step did not complete. Diagnose what went wrong and try again.`
      : '';
  const desc = step.desc !== undefined && step.desc.length > 0 ? `\n\n${step.desc}` : '';
  const itemNote = args.item
    ? `\n\nThis step is part of a PARALLEL fan-out over **${args.item.over}**. You are working on item **${args.item.id}** ONLY — do not touch other items.`
    : '';
  const taskScope =
    args.taskScope !== undefined && args.taskScope.trim().length > 0
      ? `\n\n# Sprint tasks\n\n${args.taskScope.trim()}\n\nThese are the EXACT tasks in scope for this sprint — the cyboflow database is their source of truth. When this step needs the task set (e.g. dependency analysis or per-task work), use THIS list and pass it to your subagent; do NOT hunt for task files in the worktree to discover scope (cyboflow keeps no task files on disk, so you will find none and wrongly conclude there is nothing to do).`
      : '';
  const runOwnedIdeaIds = [...new Set(args.runOwnedIdeaIds?.filter((id) => id.trim().length > 0) ?? [])];
  const runOwnedIdeaScope =
    runOwnedIdeaIds.length > 0
      ? `\n\n## Run-owned idea scope\n\nThis run owns only these idea ids: ${runOwnedIdeaIds.map((id) => `\`${id}\``).join(', ')}. This scope is authoritative for idea-specific work; do not inspect or select unrelated project ideas.`
      : '';
  // Heading kept byte-identical to APPROVE_IDEAS_DECISIONS_HEADING
  // (resolveReviewItemHandler) — the contract the flow prose keys the resumed
  // agent on. Not imported: stepPrompt stays free of orchestrator-module imports.
  const approveIdeasDecisions =
    args.approveIdeasDecisions !== undefined && args.approveIdeasDecisions.trim().length > 0
      ? `\n\n# Approve-ideas decisions\n\nThe human resolved this run's approve-ideas batch gate with these per-idea decisions:\n\n${args.approveIdeasDecisions.trim()}\n\nThis verdict list is authoritative for idea-specific work: act on the APPROVED refs only. DENIED ideas stay on the backlog untouched — never expand, design, decompose, or archive them.`
      : '';
  const projectBrief =
    args.projectBrief !== undefined && args.projectBrief.trim().length > 0
      ? `\n\n# Project brief\n\nThe run's APPROVED project brief — the constitution every post-brief step grounds in (a programmatic step turn cannot read artifacts, so it is threaded here):\n\n${args.projectBrief.trim()}`
      : '';
  const artifactNote =
    step.outputArtifact !== undefined ? artifactFollowUp(step.outputArtifact, workflowName) : '';
  // Task-verify relay contract (verification-agent redesign §5.1; live-smoke fix
  // 2026-07-22): this step turn's FINAL MESSAGE is the typed step-output channel
  // the controller parses for the VERDICT line + the visual-verification
  // contract. The generic prose actively fights that — step 3 says "one-line
  // summary" (which summarized the fence away) and step 1 says "persist every
  // ACTION via cyboflow_* tools" (which turned the composed verification task
  // into a live cyboflow_request_verification call + a self-parked lane). Both
  // observed on the first live run. This note overrides them for task-verify.
  const taskVerifyRelayNote =
    step.agent === 'task-verify' || step.id === 'task-verify'
      ? `\n\n## Final message contract (task-verify) — overrides steps 1 and 3 above\n\nYour final message IS the machine-read verdict channel for this lane; the controller parses it directly. After your \`cyboflow-task-verify\` subagent returns:\n\n- RELAY, do not summarize: end your final message with the subagent's literal \`VERDICT: PASS\` / \`VERDICT: FAIL\` line, and on PASS with EXACTLY ONE of the subagent's \`## Visual verification task\` section (its \`\`\`json fence copied byte-for-byte) or its bare \`VISUAL-VERIFICATION: NOT-APPLICABLE — <reason>\` line. Dropping or paraphrasing these is an output-contract failure that fails this lane after one retry.\n- The composed verification task is TEXT for the controller, NEVER an action for you: do NOT call \`cyboflow_request_verification\`, do NOT set the lane to \`awaiting-verify\` via \`cyboflow_update_sprint_task\`, and do NOT delegate to any visual-verify subagent. The controller fires the request from the fence you print and parks the lane itself.`
      : '';
  // Address-review findings contract (sprint/ship): this step is the ONLY one
  // whose input is the run's own review queue, and the generic "record every item
  // the subagent returns" prose does not describe it — nothing is being recorded
  // here, findings are being READ BACK and closed out. Two things a step agent
  // cannot infer: the ids exist only via `cyboflow_list_run_findings` (report_
  // finding is fire-and-forget and never returned them), and the three verdicts
  // map to DIFFERENT dispositions — resolving a DEFERRED finding would silently
  // delete the exact backlog entry this stage exists to preserve.
  const addressReviewNote =
    step.agent === 'address-review' || step.id === 'address-review'
      ? `\n\n## Findings contract (address-review) — how this step gets its input and closes it out\n\nThis step acts on the findings THIS run already filed; it does not produce new ones.\n\n1. Call \`cyboflow_list_run_findings\` (read-only, no arguments) FIRST. It returns every still-open finding this run filed — each task lane's \`code-review\` \`## Findings\` AND \`sprint-review\`'s — with the \`id\` each one needs to be resolved. Do NOT reconstruct this list from your own context: \`cyboflow_report_finding\` never returns the minted id, and most of these were filed by lanes you never saw. An empty list means there is nothing to do — say so and stop.\n2. Delegate to \`cyboflow-address-review\`, passing the findings verbatim (id, title, body, category, severity, locations, suggested fix).\n3. **Settle the code BEFORE you resolve anything.** If the subagent changed any files, re-run the project's FULL test suite yourself. This step runs AFTER the sprint's full-suite verification, so that verification is now stale with respect to your edits — and the subagent only ran the targeted tests covering the files it touched, which cannot see a cross-module regression. If the full suite fails, re-delegate \`cyboflow-address-review\` ONCE to repair or revert its own fixes and re-run the suite. If it STILL fails, file a BLOCKING finding via \`cyboflow_report_finding\` (\`blocking: true\`, category \`address-review-regression\`) carrying the failing tests and what was changed, and say so in your summary. That finding is the durable signal — your summary prose is not machine-read, so a blocking review item is the only thing that actually parks the run before the human's merge gate instead of letting a red tree slide into it. This is the ONE exception to "do not file new findings from this step", and it qualifies precisely because no further retry or loopback in this chain will fix it. The next step is the human's merge gate, and it must not open over a tree whose suite has not passed since the last edit. Then commit per step 2 above with a message naming the findings addressed. If the subagent changed NO files, skip straight to step 4.\n4. **Only now** act on its \`## Disposition\`, one entry per finding id, using the disposition as it stands AFTER step 3 — the verdicts are NOT interchangeable:\n   - **FIXED, and the fix survived step 3** → \`cyboflow_resolve_finding\` with \`resolution_kind: 'fixed'\` and a \`note\` naming what changed.\n   - **FIXED, but the fix was reverted or dropped in step 3** → leave it OPEN, exactly like a DEFERRED one. The code no longer carries the fix, so the finding is not fixed.\n   - **INVALID** → \`cyboflow_resolve_finding\` with \`resolution_kind: 'triaged'\` and a \`note\` carrying the refutation.\n   - **DEFERRED** → do NOTHING. Leave it open. It is a real issue deliberately left for the human gate, and resolving it would erase the one record of it. The same applies to any id the subagent omitted or gave a verdict outside those three — never guess a disposition.\n\nNever resolve a finding before its fix is verified and committed: resolving is IRREVERSIBLE (there is no un-resolve tool), so a finding closed as \`fixed\` whose fix is then reverted — or lost to a crash before the commit — leaves a real defect in the branch with its only record already closed. Resolution is the cheapest, most repeatable action in this chain; it goes last precisely because everything before it can fail.\n\nDo NOT file new findings from this step, and do NOT widen the change beyond the filed findings.`
      : '';
  // The bootstrap's own files, appended to the address-review contract above.
  // Deliberately a SEPARATE const rather than interpolated into that one: the
  // address-review note is a fixed contract, and this is per-run data that is
  // absent on almost every run — keeping them apart is what makes the common
  // prompt byte-identical to what it was.
  const bootstrapDenylistNote =
    (step.agent === 'address-review' || step.id === 'address-review') &&
    args.bootstrapProtectedPaths !== undefined &&
    args.bootstrapProtectedPaths.length > 0
      ? `\n\n## Files this run's verification bootstrap wrote — do NOT touch them\n\nThis run derived and proved its own verification runbook, and committed these files:\n\n${args.bootstrapProtectedPaths
          .map((p) => `- \`${p}\``)
          .join(
            '\n',
          )}\n\nLeave them exactly as they are, even if a finding appears to be about one of them, and even if one looks wrong to you. The runbook's proof is content-addressed against the committed file, so ANY edit to it — including a correct one — invalidates the proof and the next verification silently skips. The configuration change is what makes this project stand up for verification at all; reverting it un-proves the environment while the runbook still claims otherwise. If you believe one of these files is genuinely wrong, file a finding saying so and leave the file alone.\n\nRelay this list to \`cyboflow-address-review\` verbatim when you delegate — it cannot see this prompt.`
      : '';
  const conditionalExecutionNote = conditionalExecution(step, workflowName, runOwnedIdeaIds.length > 0);
  const ideaFlagContractNote = ideaFlagContract(step);
  // Compound review-queue discipline — applies to EVERY compound step, not just
  // the one that reports the artifact. The compounder surfaces below-bar
  // candidates in a `## Discarded` list; a step agent that faithfully "records
  // every item the subagent returns" used to file one blocking `decision` per
  // drop, spamming the review queue with sequential approve/resume gates
  // (observed on load-sprint, which has no outputArtifact so the addendum above
  // never reaches it). This guard reaches all steps and pins the single-review
  // contract: drops go in the doc; Compound emits NO `decision` items at all — its
  // two human gates are both workflow STEPS (approve-learnings + the terminal
  // human-review "merge in changes" gate), never a reported decision, never per-drop.
  const compoundGuard =
    workflowName === 'compound'
      ? `\n\n## Compound review-queue discipline\n\nThe \`cyboflow-compounder\` subagent may return a \`## Discarded\` list of candidates it considered and set aside. These are CONTEXT, not actions: NEVER file a discarded candidate as a \`cyboflow_report_finding\` (\`decision\` or \`finding\`) or any other review-queue item. Discarded candidates belong ONLY in the \`## Discarded\` section of the \`compound-recommendations\` doc (composed at the \`extract\` step). Compound has exactly TWO human gates and BOTH are workflow STEPS: the \`approve-learnings\` question, and the terminal \`human-review\` step — a "merge in changes" gate over the applied diff (Approve / Reject), just like a Sprint/Ship human-review. Compound emits NO \`decision\` review items anywhere — not at \`write-back\`, not per doc edit, not per drop. write-back APPLIES every approved change in-place, commits, and reports no review item; per-item gates are the sequential-gate spam this flow must never produce.`
      : '';
  const userGuidance =
    args.userGuidance !== undefined && args.userGuidance.trim().length > 0
      ? `\n\n## Operator guidance\n\nThe operator added mid-run guidance for this step — follow it:\n\n${args.userGuidance.trim()}`
      : '';
  // Visual-verification output-contract re-run (§5.1/§5.3): a task-verify PASS
  // result MUST contain EXACTLY ONE of a `## Visual verification task` fence or a
  // `VISUAL-VERIFICATION: NOT-APPLICABLE — <reason>` line. The previous attempt
  // violated that, so quote the exact defect and demand a compliant re-emit.
  const contractError =
    args.contractError !== undefined && args.contractError.trim().length > 0
      ? `\n\n## Visual-verification output contract (fix required)\n\nYour previous result violated the visual-verification output contract:\n\n> ${args.contractError.trim()}\n\nRe-emit your FULL result. On \`VERDICT: PASS\` it MUST contain EXACTLY ONE of:\n\n- a \`## Visual verification task\` section whose body is a single fenced \`\`\`json code block holding the \`VerificationTaskV1\` payload, or\n- a single line \`VISUAL-VERIFICATION: NOT-APPLICABLE — <one-line reason>\` when this task has no user-visible UI to verify.\n\nInclude exactly one of those forms (never both, never neither, never a duplicate). Print it as TEXT in your final message — do NOT call \`cyboflow_request_verification\` or park the lane yourself; the controller fires the request from what you print. If a previous attempt already fired a request, still print the contract — the controller reconciles.`
      : '';
  // Visual merge-gate FAIL loopback feedback (§5.3): the re-delegated implement
  // agent is handed WHAT was tested, what failed, and why — verbatim — not merely
  // "a blocking finding exists".
  const loopbackFeedback =
    args.loopbackFeedback !== undefined && args.loopbackFeedback.trim().length > 0
      ? `\n\n## Visual verification failed (previous attempt)\n\nThe visual verification of your previous attempt FAILED. Fix the issues it reports before re-running — here is its report verbatim:\n\n${args.loopbackFeedback.trim()}`
      : '';

  return `You are executing **one step** of the "${workflowName}" workflow in this git worktree.

Step: **${step.name}** (id: \`${step.id}\`)${desc}${itemNote}${taskScope}${projectBrief}${runOwnedIdeaScope}${approveIdeasDecisions}

Do ONLY this step:

1. **Do the work.** Delegate to the \`cyboflow-${step.agent}\` role. On the Claude runtime, use the Task tool with that EXACT \`subagent_type\` — it is installed in this worktree's \`.claude/agents/\`, so do NOT fall back to \`general-purpose\`. On another runtime, follow its provider adapter for the equivalent native delegation type. Pass the role the context it needs (including the task scope above when relevant) and read its result. Persist every cyboflow state change yourself via the \`cyboflow_*\` MCP tools, recording EVERY item the subagent returns that is an ACTION to persist — e.g. call \`cyboflow_add_task_dependency\` for each edge it reports; never collapse a non-empty result to "none". This does NOT mean filing context-only sections the subagent returns for the operator's or a doc's benefit (e.g. a Compound \`## Discarded\` list) as review items — follow any workflow-specific review-queue discipline below. You are the single writer; subagents are edit-only.
2. **Commit file changes atomically.** If this step changes repository files, make ONE git commit (\`<type>: <what changed>\`), staging only the files this step touched. For DB-only, analysis, review, or artifact-reporting work, do not make a git commit. Never create an empty commit.
3. **Stop.** Do NOT start any other step — the host orchestrator sequences the workflow and will invoke the next step itself. Report a one-line summary of what this step produced, then end your turn.

The cyboflow database is the single source of truth: never read on-disk or worktree state files (e.g. a plugin state directory) to decide the task set or a task's status — any such file is NOT cyboflow's source of truth and may be stale or absent.${conditionalExecutionNote}${ideaFlagContractNote}${compoundGuard}${artifactNote}${taskVerifyRelayNote}${addressReviewNote}${bootstrapDenylistNote}${userGuidance}${contractError}${loopbackFeedback}${retryNote}`;
}
