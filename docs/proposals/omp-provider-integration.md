# OMP (oh-my-pi) as a third agent provider

Status: PROPOSAL (2026-08-14), revised same day after a Codex adversarial review (8 findings, all
accepted; dispositions in §14). Not yet scheduled.
Prior art: `docs/proposals/codex-provider-integration.md` (the second-provider integration this one
deliberately mirrors and generalizes), `docs/ARCHITECTURE.md` §"Dual-substrate seam".

## 1. Why

Cyboflow today speaks to two agent **harnesses**: Claude Code (SDK + interactive PTY) and OpenAI
Codex (app-server + PTY). Every additional *model family* we want to offer (Gemini, Qwen, DeepSeek,
Kimi, GLM, local models via Ollama/LM Studio, OpenRouter-hosted anything) would otherwise be its own
harness integration.

OMP ([omp.sh](https://omp.sh), `can1357/oh-my-pi`, MIT, TypeScript-on-Bun, fork of Mario Zechner's
Pi) is a **harness, not a model API**: it brings its own agent loop, 31 built-in tools, edit
machinery, session persistence, subagents, MCP client, hook system, and — the point — **60+ model
providers behind one interface** with its own credential management (env vars, OAuth `/login`,
`models.yml`). Integrating OMP as **one** third provider gives cyboflow users the entire multi-model
surface without cyboflow building or maintaining per-provider agent loops. This is categorically
different from integrating OpenRouter, which would hand us raw completions and leave the harness
(tools, edits, approvals, sessions) as our problem.

## 2. Load-bearing OMP facts (verified against source @ v17.3.3, 2026-08-14)

These facts constrain the whole design; each was confirmed in the `oh-my-pi` repo or its `docs/`
tree, not marketing copy.

1. **Bun is a hard runtime requirement.** `packages/coding-agent/src/cli.ts:41-46` version-gates on
   `Bun.semver`; Bun APIs are used across ~177 source files. The in-process SDK
   (`createAgentSession` from `@oh-my-pi/pi-coding-agent`) **cannot be imported into Electron's
   Node main process.** OMP's own reference clients (TS `rpc-client.ts`, Python `omp_rpc`) embed by
   **spawning `omp --mode rpc` as a subprocess** and speaking newline-delimited JSON over stdio.
2. **RPC mode is a complete embedding surface** (`docs/rpc.md`, ~875 lines): commands for
   `prompt`/`steer`/`abort`/`new_session`/`switch_session`, `set_model`/`get_available_models`,
   `set_thinking_level`, `get_session_stats`, `get_last_assistant_text`, `get_messages_page`;
   a `ready` handshake frame with protocol negotiation (v1 = 1 MiB/frame, v2 = chunked to 64 MiB);
   an event stream forwarding the full `AgentSessionEvent` union (token-level `text_delta`s
   included); an `extension_ui_request`/`response` sub-protocol for approval prompts; a host-tool
   bridge (`set_host_tools` → `host_tool_call`/`host_tool_result`). Turn completion is signaled by
   `agent_end` with `isTerminal !== false` — the `prompt` response only acks acceptance.
3. **Full MCP client** — stdio/HTTP/SSE, configured via project `.omp/mcp.json` or user
   `~/.omp/agent/mcp.json`, with `${VAR}` env expansion in `env` values, per-server `timeout`
   (**`0` disables**; default 30s), and automatic import of foreign configs (Claude Code's
   `~/.claude.json` / `.claude/mcp.json`, Codex, Cursor, VS Code …) with OMP-native definitions
   winning name conflicts.
4. **Hooks/extensions are a real pre-tool gate**: a module loaded via `-e`/`--hook` can intercept
   `tool_call` and return `{ block, reason }` or rewrite `input`; a handler throw **fails closed**.
   This is the PreToolUse-equivalent seam, and it is stronger than what Codex offers us.
5. **Approval default is `yolo`** — `tools.approvalMode` defaults to auto-approve-everything.
   Any cyboflow spawn must set the mode explicitly; inheriting OMP's default would bypass our
   permission model entirely.
6. **Sessions**: append-only JSONL trees at `~/.omp/agent/sessions/<encoded-cwd>/…jsonl`
   (redirectable via `--session-dir`), resume by id-prefix or path (`--resume`, RPC
   `switch_session`), fork, `--continue` (per-cwd most-recent). Every assistant `message` entry
   carries a per-turn `usage` block **including a dollar `cost` breakdown**; RPC
   `get_session_stats` returns session rollups.
7. **Model catalog is programmatic**: RPC `get_available_models` (filtered to
   keyless-or-credentialed), model ids are `provider/model` strings, thinking level rides a
   `:level` suffix (`off|minimal|low|medium|high|xhigh|max`), mid-session `set_model` works.
8. **Release cadence is extreme**: 683 changelog releases in ~9 months, majors increment weekly,
   breaking changes are frequent (flagged in the changelog), and an **npm package rename is
   pre-announced**. Version pinning + a contract tripwire are mandatory, not hygiene.
9. **Distribution**: standalone compiled binaries exist (curl installer, brew, Nix) that embed the
   runtime and self-extract the native addon to `~/.omp/natives/<version>`; also installable via
   `bun install -g`.

## 3. Design overview

### 3.1 Provider and runtimes

```
AgentProvider += 'omp'
AgentRuntime  += 'omp-sdk'   // persistent `omp --mode rpc-ui` child process, NDJSON over stdio
              += 'omp-pty'   // interactive OMP TUI over the AbstractCliManager PTY path
SessionAgentRuntime  += both
WorkflowAgentRuntime += 'omp-sdk' only   (same reasoning that excludes codex-pty)
```

`omp-sdk` is transport-honestly an RPC child, but the name keeps the `<provider>-sdk` convention
that `codex-sdk` (really an app-server) established; UI label: **"OMP"** / **"OMP terminal"**.
Per the codex-exec lesson (`codex-provider-integration` retro): we declare **no** runtime we are
not shipping — exactly these two.

The structural rhyme that makes this cheap: **`OmpSdkManager` is shaped like `CodexSdkManager`**
(persistent JSON-protocol child per panel/lane, warm-entry lifecycle, event projector into
`AgentStreamEvent[]`, approval/question bridges into the shared routers), and **`OmpPtyManager` is
shaped like `CodexPtyManager`** (binary discovery ladder, permission flags, raw `pty-output`).
Everything downstream of `AgentStreamEvent` — `agentStreamAdapter`, `MessageProjection`,
`UnifiedChatView`, `RawEventsSink`, `agent_invocations` — is already provider-blind and needs zero
changes (verified: `isAgentStreamEvent` dispatches on event `type`, not provider).

### 3.2 Tier placement (what OMP serves, in order)

Using the orchestration-capability tiers (see §"capability registry" in the research notes /
`codex-provider-integration.md`):

| Tier | What | OMP verdict |
|---|---|---|
| T0 quick chat sessions | `omp-sdk` structured + `omp-pty` terminal | **Phase 1** — full parity path exists |
| T1 programmatic per-step workflow agents | `omp-sdk` | **Phase 2** — and with *fewer* degradations than codex-sdk: `get_last_assistant_text` restores `resultText` (codex loses it), and the gating hook can honor `disallowedTools` (codex ignores it) |
| T2 main orchestrator session | `omp-sdk` | **Phase 3, explicitly deferred** — needs a per-provider prompt envelope, question-gate parity, subagent role mapping |
| T3 eval juror / visual verifier | one-shot query | **Phase 3 / open** — RPC exposes no per-prompt JSON-schema output; see §9 |

The hard rule from the codex retro applies: `workflow_runs.substrate` piggybacking on `'sdk'` makes
a new runtime **silently eligible for programmatic mode**. And a bare `createRun` guard is not
enough (adversarial-review finding): `createQuickSessionCore.ts:234-252` forwards
provider/runtime onto the `__quick__` sentinel run **only when `isWorkflowRuntimeSupported`
passes** — and the facade's `resolveManager(runId)` reads the sentinel run row — so a Phase-1
`omp-sdk` outside `WORKFLOW_AGENT_RUNTIMES` would lose its identity and misroute, while adding it
early would advertise T1 everywhere. Phase 0 therefore **splits the two meanings** that
`WORKFLOW_AGENT_RUNTIMES` conflates today:

- `WORKFLOW_RUN_STORABLE_RUNTIMES` — what a `workflow_runs` row (incl. the quick sentinel) may
  carry; `omp-sdk` joins in **Phase 1** (with the DB CHECK widened in Phase 0).
- `WORKFLOW_LAUNCHABLE_RUNTIMES` — what workflow pickers offer and `workflowRegistry.createRun`
  accepts for real (non-sentinel) runs; `omp-sdk` joins in **Phase 2**.

`isWorkflowRuntimeSupported` callers are re-audited against whichever set they actually mean.

### 3.3 Distribution & auth: delegate to OMP (v1)

- **No bundling in v1.** Discovery ladder mirrors `codexPtyManager`: explicit custom path setting →
  `findExecutableInPath('omp')` → version probe. Onboarding/Settings show "install via
  `curl -fsSL https://omp.sh/install | sh` or `brew install can1357/tap/omp`". Bundling per-platform
  binaries (the `@openai/codex` asarUnpack pattern) is a later, deliberate packaging project —
  it drags in signing/notarization and the release runbook.
- **No credential UI in v1.** OMP owns provider credentials (`~/.omp`, env vars, OAuth `/login`,
  `models.yml`). Cyboflow's availability probe = binary present + version OK + RPC
  `get_available_models` returns ≥1 model. The Settings/Integrations card for OMP shows detection
  state and links out ("run `omp` in a terminal and `/login <provider>`"), exactly the shape of the
  Codex ChatGPT-login card. This removes the entire per-provider secret-management scope from v1.

### 3.4 Version discipline

- `OMP_MIN_SUPPORTED_VERSION` (floor, hard-refuse below) + `OMP_TESTED_VERSION` (soft: log + a
  one-time settings banner "running an untested OMP version") — a hard equality pin like Codex's
  `CODEX_EXECUTABLE_VERSION` would break daily at OMP's release cadence.
- A **contract test in the sdkContract style** (`main/src/test/fakes/__tests__/sdkContract.test.ts`
  precedent): committed fixtures of the RPC `ready` frame, one full turn's event stream, and the
  `get_available_models` / `get_session_stats` response shapes, asserted against the discriminants
  our projector and manager actually read. Protocol negotiation pins v1 framing; we refuse a ready
  frame whose `supportedProtocolVersions` excludes 1.
- The pre-announced npm rename does not affect us in v1 (we ship no npm dependency on OMP — we
  spawn the user's binary).

## 4. Phase 0 — generalize before adding (the "don't copy the wart a third time" pass)

The codex integration left ~5 P0 sites that would **silently misroute an `omp` runtime to Claude**
and ~10 P1 shape problems. Phase 0 is a behavior-neutral refactor, landable and testable on its own,
with the full suite green before any OMP code exists.

P0 (silent misrouting):
1. `providerForRuntime` prefix-sniff (`shared/types/agentRuntime.ts:97-99`, duplicated in
   `main/src/services/panelLane.ts:45-47` and `frontend/src/components/cyboflow/agentRuntimeUi.ts`)
   → one `RUNTIME_PROVIDER_PREFIXES`-driven map in `shared/`, re-exported; unknown prefix **throws**
   in dev / floors with a logged error in prod, never silently `'claude'`.
2. `SubstrateDispatchFacade` — Codex rides two optional trailing constructor params and
   `=== 'codex-sdk'` tests (`substrateDispatchFacade.ts:224-231, 327-345, 355-369`) → a
   `Map<PanelLane | AgentProvider, AbstractCliManager>` registry with explicit registration at boot;
   `resolvePanelOwner` (`main/src/index.ts:2542-2556`) loses its silent `default:`-to-Claude arm.
3. DB CHECK constraints hardcode `('claude','codex')` on `sessions` (059/060), `workflow_runs`
   (062/063), `agent_invocations` (065), **and `workflow_variants` (068 — caught by the
   adversarial review; `workflowRegistry.updateVariant` writes those columns directly, so a
   Phase-2 OMP variant save would be rejected by SQLite)**. SQLite cannot ALTER a CHECK →
   **table-rebuild migrations** (create-new → copy → drop → rename, preserving indexes + FKs,
   `agent_invocations`→`workflow_runs` included). We widen to include `'omp'` in the same rebuild
   (one rebuild, not two), and the migration test upgrades a populated legacy DB then saves an OMP
   variant. Schema parity: update `scripts/verify-schema-parity.js` +
   `entitySchemaParity.test.ts`. A final `grep -rn "('claude','codex')" main/src/database` sweep
   is part of the phase's acceptance, so no fifth constraint is discovered in Phase 2.
4. `normalizeAgentModelSelection`'s claude-else-codex binary (`shared/types/agentModels.ts:87-104`)
   → per-provider model-family predicate registry. OMP's discriminator is structural: its model ids
   contain a `/` (`provider/model`).
5. `AGENT_PROVIDER_DISABLED_CODE` regex + `parseAgentProviderDisabled` coercion +
   `resolveAgentProviderAccess` (`agentRuntime.ts:164-212`) → provider-list-driven, **with a
   per-provider default policy** (adversarial-review finding): today an *absent* access key floors
   to enabled, which would switch OMP on for every existing install the moment the provider ships.
   The registry carries `defaultEnabled` per provider — `claude`/`codex` keep the legacy
   absent⇒enabled floor; any *newly introduced* provider is absent⇒**disabled** until the user
   turns it on in Settings/onboarding. Tests cover legacy partial and absent access maps.

P1 (shape, same pass):
6. `WorkflowAgentConfig.codexModel` → generalized `providerModel?: string` (keyed by the resolved
   provider), with `codexModel` kept as a read-compat alias during migration; touches
   `effectiveAgents.ts`, `agentOverrideRouter.ts`, `spawnStepRunner.ts:244-246`, the Zod schema,
   `agent_overrides.codex_model` (add `provider_model`, backfill, read both), editor state, tRPC.
7. Inline `z.enum(['claude','codex'])` / runtime-list literals (`trpc/routers/variants.ts`,
   `runs.ts`, `experiments.ts`, `ipc/config.ts` ×2, `insightsQueries.ts:2616`,
   `shared/types/insights.ts:360`) → `z.enum(AGENT_PROVIDERS)` / `z.enum(WORKFLOW_AGENT_RUNTIMES)`.
8. Provider-named detection/catalog verticals (`codex:detect`, `models:get-codex-catalog`,
   `CodexDetectionResult`, `useCodexModelCatalog`) → `providers:detect(provider)` +
   `models:get-catalog(provider)` + a `Record<AgentProvider, CatalogState>` store, with the old
   channels kept as thin delegates until the frontend flips.
9. Demo-mode `instanceof` grafts (`cliManagerFactory.ts:34-48, 126-185`) → boot wiring depends on
   the manager interface, delete the adapter.
10. Per-runtime **capability flags as data** (`supportsEffort`, `supportsResume`,
    `supportsResultText`, `supportsStructuredPanel`, `supportsMcp`, `worksInWorkflows`) on the
    `CliToolDefinition`/provider registry, replacing scattered `=== 'codex-pty'` special cases
    (`SessionStartWizard`, `ABTestLaunchModal`, `useQuickSession`, `QuickSessionComposer`).
11. The 3–4 hand-written provider×runtime consistency guards (`workflowRegistry.ts:1172-1185`,
    `runs.ts:1144-1155`, `experiments.ts:2251-2262`, `session.ts:910-929`) → one
    `assertProviderRuntimeConsistent` in `shared/`.
12. Prompt envelopes → `PROVIDER_PROMPT_ENVELOPES: Record<AgentProvider, string | null>` in
    `workflowPromptRenderer.ts` (Codex's 8-bullet envelope moves in; `omp` gets `null` until
    Phase 3).

Acceptance for Phase 0: `pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:integration`
green; zero behavior change (existing codex/claude suites are the regression net); the new
provider-registry unit tests assert that an *unknown* runtime string fails loudly everywhere the
old code silently floored to Claude.

## 5. Phase 1 — T0 quick sessions

### 5.1 `OmpSdkManager` (`main/src/services/panels/omp/ompSdkManager.ts`)

Extends `AbstractCliManager`; the CodexSdkManager blueprint applies almost 1:1:

- **Process model**: one persistent `omp --mode rpc-ui` child per panel (and later per `spawnKey`
  lane), spawned via the discovered binary. **`rpc-ui`, not plain `rpc` (implementation-verified,
  v17.3.x)**: under `always-ask`, write/exec-tier tools require an interactive UI context; plain
  `rpc` has none (`main.ts:1570/1765`), so the wrapper *throws* "requires approval but no
  interactive UI available" instead of prompting — a plain-rpc session could only ever read.
  `rpc-ui` speaks the identical NDJSON protocol and delivers the approval dialogs as
  `extension_ui_request` frames the manager answers. Warm-entry lifecycle: `WarmOmpEntry` keyed by
  panel, 15-min idle TTL, kill switch `CYBOFLOW_DISABLE_OMP_WARM=1`, fingerprint = sha1(exe
  path+version, cwd, flags, gate config, env, model, session dir). RPC gives a true `abort`
  command, so interrupt is a first-class RPC call, not a process kill. Mid-session model switching
  uses `set_model` — which takes `{provider, modelId}` as two fields, split from cyboflow's
  canonical `provider/id` form.
- **Spawn flags** (explicit, never inherited defaults):
  `--mode rpc-ui --approval-mode <mapped> --model <selection> --session-dir <cyboflowDataDir>/omp-sessions/<panelId>
  --no-title --no-extensions --no-skills -e <cyboflowGateExtension> [--resume <path>]`.
  Explicit `--approval-mode` is **non-negotiable** (OMP defaults to yolo, fact §2.5), and
  **ambient executable discovery is disabled on every cyboflow-managed spawn** (see §8.2 — this is
  a trust-boundary requirement, not a hermeticity nicety; `-e` then loads exactly one extension:
  ours). Redirecting `--session-dir` keeps cyboflow-spawned OMP sessions out of the user's
  personal `~/.omp` session list, sidesteps the encoded-cwd collision class, and makes cleanup a
  directory delete; resume still works by path.
- **Turn contract**: `spawnCliProcess` sends `prompt` and resolves at the first `agent_end` with
  `isTerminal !== false` (per-logical-turn resolution, same contract the warm Claude SDK path
  keeps); rejects on `turn.error`-equivalents. `'spawned'`/session-info/`'exit'` are emitted per
  logical turn, mirroring the warm-SDK convention so `events.ts` needs nothing new.
- **Handshake**: read the `ready` frame, verify protocol v1, `negotiate_protocol` v2 opportunistically
  (large-frame safety), then `switch_session`/fresh per resume state, then prompt.
- **External session id**: OMP session file path (returned by `get_state`/session events) captured
  once via `AgentInvocationStore.captureExternalSessionId` — resume target for follow-up turns and
  app-restart recovery (first post-restart turn cold-spawns with `--resume <path>`).
- **Event projection** (`main/src/services/panels/omp/ompEventProjector.ts`): OMP
  `AgentSessionEvent` → `AgentStreamEvent[]`, stamped `{provider:'omp', runtime:'omp-sdk'}`.
  Mapping sketch: `message_start/end` (assistant) → `AgentAssistantMessageEvent` with
  text/thinking/tool-call blocks; `tool_execution_end` → tool-result blocks; `agent_end` →
  `AgentResultEvent`. `message_update` `text_delta`s are **dropped in v1** (codex-parity refetch
  model; live-tail is a later nicety) — same for the raw-notification audit sink
  (`event_type='omp_rpc_event'`, deltas excluded, the `rawNotificationSink` lesson).
- **Usage/cost contract — per-turn deltas, never session rollups** (adversarial-review finding):
  emitting `get_session_stats` (a *cumulative* rollup) on every `agent_end` would be re-summed
  downstream (`insightsQueries.ts:609-613` adds each result's `total_cost_usd`), recording
  A + (A+B) + (A+B+C) across a warm session. Instead the manager accumulates the
  per-assistant-message `usage` blocks (tokens **and** `cost.total`) arriving **within the current
  turn** and stamps exactly that turn's delta as the result event's usage + `total_cost_usd`
  (stored verbatim per the run-cost source-of-truth rule; UI marks OMP cost "estimated (OMP)").
  `get_session_stats` is a cross-check/log line only. OMP reports usage per assistant message
  (Claude-style), so the `insightsQueries.ts:536-541` result-usage fallback heuristic is
  untouched. A mandated test covers a three-turn warm session plus a restart-resume turn,
  asserting recorded totals equal the sum of per-turn deltas.
- **Approval gate**: see §5.3.
- **Question gate**: v1 = none (OMP's `ask` tool is not bridged yet; quick sessions surface
  questions as plain assistant text). Phase 3 bridges it. This matches where claude-interactive
  still is today.

### 5.2 `OmpPtyManager` (`main/src/services/panels/omp/ompPtyManager.ts`)

CodexPtyManager blueprint: discovery ladder (custom path → PATH), version probe via the shared
`cliVersionProbe.ts` (its shebang/`usedNodeFallback` handling is reusable as-is),
`buildCommandArgs` = `--approval-mode <mapped> --no-extensions --no-skills [--model <selection>]
[--continue]` (PTY mapping: `dontAsk` → `yolo`, everything else → `always-ask` — with no gating
hook on this lane, OMP's over-broad `write` tier is never enabled; the user answers prompts in the
TUI they are already sitting in), raw
`pty-output` with the 200 KB backlog cap, `relayUserTurn`/`relayRawInput`/`resizePanel`.
Improvement over codex-pty: `continuePanel` respawns with `--continue` scoped to the worktree cwd
(OMP's per-cwd breadcrumb makes this actually resume), instead of kill+fresh.
Approvals surface natively in the TUI (same explicitly-documented boundary as codex-pty: they do
not enter the review queue). No MCP, no structured side-channel — T0 floor by design.

### 5.3 Permission-mode mapping + the gating extension

**Design rule (from the adversarial review): OMP's tool-tier classification is never cyboflow's
trust boundary.** OMP's `write` approval mode auto-approves *every* write-tier tool — and OMP
classifies **all MCP tools as write-tier** — which is far wider than cyboflow's `acceptEdits`
allowance (Edit/Write/MultiEdit + proven-safe reads, `permissionModeMapper.ts:32-53, 90-104`).
Mapping cyboflow modes onto OMP modes would therefore silently widen the boundary. Instead,
**cyboflow's own predicate is the only policy engine**, applied in the gating extension; OMP's
approval mode is set so that a missing/unloaded gate **fails closed**, never open:

| Cyboflow mode | OMP `--approval-mode` | Gating extension (`omp-sdk`; the sole policy engine) |
|---|---|---|
| `default` | `always-ask` | apply cyboflow's predicate: auto-allow reads; everything else → orch-socket → ApprovalRouter |
| `acceptEdits` | `always-ask` | as above, plus auto-allow exactly cyboflow's edit-tool set (never OMP's write tier) |
| `auto` | `always-ask` | **INVERTED (revised 2026-08-16):** allow unless the call trips a hazard table — `gate/ompGateExtension.ts`'s `isAutoModeAllowedTool` / `isAutoModeAllowedBashCommand`, plus the merged permission-rule allowlist. As SHIPPED originally this row read "acceptEdits + allowlist", which made OMP's `auto` strictly narrower than the same word on Claude (whose `auto` installs no hook at all and lets the native classifier decide): every ordinary build command — `pnpm test`, `mkdir -p`, `node scripts/x.mjs` — still blocked on a human. The hazard tables are the classifier's stand-in. Rules 1-3 and the URI-scheme narrowing are unchanged, and `default`/`acceptEdits` keep the prove-it-safe posture. |
| `dontAsk` | `yolo` | log-only (+ `disallowedTools` still enforced) |

Mechanics:

- The **gating extension** is a small cyboflow-authored OMP extension module (shipped as
  TypeScript source — Bun loads TS natively, and a tsc-compiled CJS artifact fails OMP's loader
  (implementation-verified); passed via `-e <path>`): on `tool_call` it evaluates cyboflow's
  predicate against the structured `toolName`/`input`; undecidable → connect to
  `CYBOFLOW_ORCH_SOCKET`, request a decision keyed by `CYBOFLOW_RUN_ID` (reusing the
  shell-approval wire shape of `preToolUseShellHook.ts` verbatim), await it **under a 25-second
  budget**, return `{block, reason}` on deny or budget expiry. **The budget exists because OMP
  hard-caps extension handlers at 30 s with no knob** (`runner.ts:84`, timeout ⇒ fail-closed
  block) — so a human approval slower than ~25 s yields a legible fail-closed block telling the
  model to stop and let the human retry, rather than OMP's opaque timeout (which measured as
  provoking a blind model retry that burned a second 30 s). This makes >25 s approvals a **v1
  product constraint** on the omp-sdk lane; the durable fix is upstreaming a `tool_call` budget
  knob to OMP (MIT). A handler throw blocks the call (OMP-verified fail-closed, stronger than
  the docs claim: even a timeout synthesizes `{block:true}`). The gate also enforces
  `disallowedTools` — closing a real Codex gap (`spawnStepRunner.ts:62-64` is unenforced on
  codex-sdk) — matches cyboflow's MCP tools by **exact composed name**
  (`cyboflowMcpToolNames` in the gate config; the bare `mcp__cyboflow_` prefix is spoofable by a
  foreign server named e.g. `cyboflow-extra`), and denies OMP's `task` tool in every mode until
  hook scope inside OMP subagents is verified.
- **Hook-before-prompt ordering is source- and probe-verified** (`wrapper.ts:201-235` precedes the
  approval gate at `:237-339`; a hook block suppresses the prompt entirely). Therefore every
  approval prompt the RPC client sees is for a call the gate already vetted, and the
  **`ompApprovalBridge`** auto-approves them — *gated on the load sentinel*: the gate writes a
  sentinel file (env `CYBOFLOW_OMP_GATE_SENTINEL`) at import time, because **OMP starts the
  session UNGATED when an `-e` load fails** (probe-verified, `loader.ts:437-443`). The manager
  verifies the sentinel after the ready handshake and refuses the session outright when it is
  missing; the bridge additionally denies any prompt seen without a verified sentinel. The failure
  mode is a blocked session, never a silent yolo. A spawn-time assertion + unit test lock the
  mode/lockdown/`-e` flags.
- **Every blocking `extension_ui_request` kind is answered** (review finding: `select`,
  `input`, and `editor` are blocking too, and an unanswered one hangs the turn with no
  `agent_end`): the approval-shaped `select` → the sentinel-gated approve above; non-approval
  `select`/`confirm`/`input`/`editor` → `OmpQuestionBridge` → `QuestionRouter` → the inline chat
  question card → an `extension_ui_response` that resumes OMP; `notify`/`setStatus`/`setWidget`/`setTitle`/
  `open_url` → fire-and-forget per OMP's protocol (no response expected), logged. Each kind has a
  focused bridge test, including teardown and truthful error attribution.
- MCP write-tier prompts for the `cyboflow` server itself are auto-allowed by the gate (they are
  our own tools, same stance as Codex's `default_tools_approval_mode: 'approve'`).

### 5.4 MCP (`cyboflow_*`) injection — worktree sessions only in v1

- Write `<worktree>/.omp/mcp.json` at spawn (same seam as `writeInteractiveMcpConfig`; `.omp/`
  joins `.cyboflow/` in the worktree-local git exclude):

  ```json
  { "mcpServers": { "cyboflow": {
      "command": "<node>", "args": ["<cyboflowMcpServer.js>"],
      "env": { "CYBOFLOW_RUN_ID": "CYBOFLOW_RUN_ID",
               "CYBOFLOW_ORCH_SOCKET": "CYBOFLOW_ORCH_SOCKET" },
      "timeout": 0 } } }
  ```

  The bare-name env values use OMP's documented pre-connect resolution (verified in
  `docs/mcp-config.md` §"Secrets and variable resolution": a value that names a set environment
  variable is copied from the **omp process env**, which we inject per spawn) — one static file
  serves concurrent lanes sharing a worktree with different run ids; discovery-time `${VAR}`
  expansion exists too but bare-name is the more robust of the two documented forms. A missing
  variable resolves to the literal string, and `cyboflowMcpServer` exits 1 on a malformed run id —
  loud, not silent. `timeout: 0` is mandatory (OMP's 30s default would kill any blocking human
  gate — the Codex `tool_timeout_sec: 7d` lesson).
- Process env per spawn: `CYBOFLOW_RUN_ID`, `CYBOFLOW_ORCH_SOCKET`, `CYBOFLOW_RUN_ARTIFACTS_DIR`
  (do **not** repeat the codex-sdk artifacts-dir omission), login-shell PATH merge,
  `electronRunAsNodeGuardEnv`, `managedTestConcurrencyEnv`.
- OMP will also auto-import MCP servers from the project's `.mcp.json` / the user's
  `~/.claude.json` (fact §2.3). For quick sessions this is parity with claude-sdk's base-server
  merge; OMP-native definitions win name conflicts, so our `cyboflow` entry cannot be shadowed.
- **In-place (non-worktree) quick sessions skip cyboflow MCP in v1** — writing `.omp/` into the
  user's real repo is intrusive, and OMP has no `--mcp-config <path>` flag today. Follow-up worth
  doing: upstream exactly that flag (OMP is MIT and accepts PRs); it dissolves this limit and the
  git-exclude dance.

### 5.5 Everything else in Phase 1 (mechanical, registry-driven after Phase 0)

- Types/registry: `'omp'` + both runtimes in `agentRuntime.ts` arrays/labels, `PanelLane` +
  `resolvePanelLane` arms, effort scale `OMP_EFFORT_LEVELS = off|minimal|low|medium|high|xhigh|max`
  (adds `off`/`minimal` to `ALL_EFFORT_LEVELS`; `normalizeEffortSelection` handles cross-provider
  drops), model-family predicate (contains `/`).
- Factory/boot: `registerOmpSdkTool`/`registerOmpPtyTool` in `cliManagerFactory.ts` (priorities
  below codex), manager-registry entries in the facade, `resolvePanelOwner` arms, exit/output
  listeners + `startOmpSdkTurn` mirror of `startCodexSdkTurn` in `ipc/session.ts`,
  `ptyPanelDispatch` arm, demo-mode entries via the Phase-0 interface (no instanceof grafts).
- **Input/refresh dispatch inventory beyond the obvious** (adversarial-review finding — these are
  live binary claude-vs-codex branches that would silently route OMP to Claude):
  `frontend/src/hooks/useClaudePanel.ts:28-47` (first-turn vs follow-up routing recognizes only
  codex-sdk), the `sessions:input` / queued mid-turn input handlers in `ipc/session.ts`
  (~`2683-2706`, `2971-3025`), and `sessionManager.addPanelOutput`'s structured-refresh signal
  (`sessionManager.ts:732-743`, emitted only for `agent_runtime==='codex-sdk'` — must become
  lane-registry-driven or an OMP panel renders stale). Registry-driven tests cover four event
  classes per lane: initial turn, queued mid-turn input, follow-up turn, refresh signal.
- Quick-session create path: runtime validation, provider-access gate, substrate projection
  (`omp-sdk` ⇒ `substrate='sdk'`, `omp-pty` ⇒ eager PTY spawn) in `session.ts` +
  `createQuickSessionCore.ts`.
- Frontend: `SubstrateSelector` rows (+ v1 caveat that approvals for the terminal lane stay in
  the terminal), `AgentPermissionModeSelector` option set,
  model picker via the generalized catalog store (RPC `get_available_models`, 5-min cache,
  grouped by OMP provider prefix), `EffortPill`/`ModelPill` via registries, `PanelTabBar`/
  `RunChatView` labels via registry, onboarding + Integrations detection card.
- Migrations (three, numbered at rebase time — 098-100 are taken in this tree and sibling branches
  already claim 101/102; renumber-on-rebase is standing practice): the Phase-0 CHECK-widening
  rebuilds already include `'omp'`; net-new here is only `agent_overrides.provider_model` if not
  landed in Phase 0.
- Session-summary scheduler: OMP excluded by the existing `!== 'claude'` gate — fine, note only.

Acceptance: quick `omp-sdk` chat round-trips (prompt → structured panel → follow-up with resume →
interrupt → model switch), quick `omp-pty` terminal session works with `--continue` restart,
permission modes verified against a scripted deny, catalog renders, provider toggle removes OMP
everywhere, full gate green. Live smoke against a real `omp` install before calling it done
(per the standing "green gate proved nothing" lesson).

## 6. Phase 2 — T1 programmatic per-step agents

Lift the Phase-1 guard; add:

1. `WORKFLOW_AGENT_RUNTIMES += 'omp-sdk'`; `workflowRegistry.createRun` ladder + substrate
   projection (piggyback `'sdk'`, same as codex, with the consistency guard); `runs.start` enum via
   Phase-0 shared enums; variant editor + step inspector + agent editor pick up `omp-sdk` from the
   registry with `providerModel`.
2. `spawnCliProcess` returns `CliSpawnOutcome { resultText }` — after terminal `agent_end`, read
   the final assistant text from the already-projected messages (fallback:
   `get_last_assistant_text`). **This makes omp-sdk the first non-Claude runtime with working
   code-review verdict parsing, task-verify FAIL routing, and visual-fence composition**
   (`workflowController.ts:961-990, 1017-1029` stop being dead paths).
3. `spawnKey` fan-out lanes: one RPC child per lane (concurrent children per worktree are fine —
   session files are per-lane under our redirected `--session-dir`).
4. `systemPromptAppend` → `--append-system-prompt` (OMP has the flag natively; no prompt-head hack
   needed).
5. `disallowedTools` → gating extension env (already built in Phase 1).
6. Effort → `set_thinking_level` / model `:suffix` from the normalized selection.
7. Hermeticity: nothing new to decide — the §8.2 discovery lockdown already applies to every
   cyboflow-managed spawn (quick sessions and lanes alike); lanes additionally never honor the
   trusted-repo opt-in.
8. ~~Decide `task.isolation` interplay: OMP subagent overlay/rcopy isolation inside a cyboflow git
   worktree is untested — v1 sets `task.isolation.mode: none` via config overlay for lane spawns.~~
   **Resolved as NOT IMPLEMENTED (build decision).** The gate denies the `task` tool
   unconditionally, in every permission mode, on every cyboflow-managed spawn
   (`buildOmpGateConfig`'s `denyTaskTool: true`), so no subagent is ever dispatched and an
   isolation overlay would be dead configuration implying a path that cannot happen. Task-denial
   supersedes the isolation setting in v1; lifting `denyTaskTool` is what re-opens the question,
   and that change owns the isolation decision. Recorded at `ompGateConfigBuilder.ts`
   (`buildOmpGateConfig`'s doc comment) so the next reader of the deny finds it there.

Not required (host owns gates at T1): subagent role mapping, prompt envelope.

## 7. Phase 3 — T2 orchestrator + T3 juror/verifier (deliberately later)

- T2 needs: an OMP prompt envelope (`PROVIDER_PROMPT_ENVELOPES.omp`) redirecting AskUserQuestion →
  `cyboflow_request_user_input` and mapping `cyboflow-*` subagent roles onto OMP agent definitions;
  a `.omp/agents/*.md` writer alongside `workflowBundleWriter` (OMP discovers project agents there;
  frontmatter differs from `.claude/agents` — name/description/systemPrompt); resume/nudge
  via `switch_session`. The monitor and final-gate handover stay Claude — same conscious decision
  already made for Codex.
- T3 blocker: RPC has no per-prompt JSON-schema structured output (the SDK's `outputSchema` is
  in-process-only). Options, in preference order: (a) upstream an `output_schema` field on the RPC
  `prompt` command; (b) schema-in-prompt + parse-with-retry (the pre-`strictOutputSchema` world —
  known fragile); (c) defer. Recommendation: (a)/(c) — do not ship (b) into the eval jury.
  `insightsQueries.ts:2602-2634` jury parsing and `shared/types/insights.ts:360` must accept
  `'omp'` slots when this lands (covered by Phase-0 item 7).

## 8. Security posture (net-new surface, called out explicitly)

1. **OMP's yolo default** — every cyboflow spawn passes an explicit approval mode; a missing flag
   is a bug class, so `buildCommandArgs` asserts it and a unit test locks it.
2. **OMP extensions/hooks/custom tools run arbitrary TS in-process with no isolation — and OMP
   discovers them from the PROJECT tree** (`.omp/extensions`, `.omp/hooks`, `.omp/tools`,
   `.omp/commands`, plus imported Claude/Codex tool dirs). Opening an OMP session in an untrusted
   repo would execute repo-controlled code at startup, **before** any `tool_call` gate fires
   (adversarial-review critical). Therefore: **every cyboflow-managed OMP spawn — quick sessions
   included — disables ambient executable discovery** and loads only the cyboflow gate extension.
   Implementation must enumerate every discovery channel OMP has (extensions, hooks, custom TS
   commands, custom tools, skills, foreign tool-dir imports) and verify each has an off switch
   (`--no-extensions`, `--no-skills`, …); a channel without one is upstreamed or the runtime ships
   blocked on it. Re-enabling the user's own OMP customization is a per-project **trusted-repo
   opt-in** setting, default off, with the settings copy naming the risk. Declarative config
   (rules/context files, `models.yml`, MCP *definitions* — which still pass the tool gate at call
   time) stays on.
3. **`.env` auto-load**: OMP loads `<cwd>/.env` into provider-credential resolution. A worktree
   `.env` is the repo's own file — same exposure Claude/Codex tools already have via shell access,
   but note it feeds OMP's *credential* chain; no action beyond documentation.
4. **The orch socket has no peer auth** (known standing finding). The gating extension adds one
   more client class to that socket; it does not widen the existing exposure, but the socket-auth
   fix rises in priority with a third writer.
5. **Foreign-MCP auto-import** means an OMP session may connect servers the user configured for
   other tools. Name-conflict precedence protects the `cyboflow` server; the rest is the user's
   ambient config, same trust stance as claude-sdk's `~/.claude.json` merge.
6. **ToS**: multi-account/coding-plan providers routed through OMP (Copilot, Cursor plans, …) carry
   their own terms; cyboflow does not proxy or store those credentials and surfaces OMP as the
   integration point. Same "user's own account" stance as the interactive Claude substrate.

## 9. Cost/usage accounting

- `run_usage.cost_usd` ← the sum of the turn's per-assistant-message `cost.total` values, emitted
  as that result event's `total_cost_usd` (the per-turn-delta contract of §5.1 — never a
  `get_session_stats` rollup), stored verbatim (source-of-truth rule). It is OMP's catalog-priced
  estimate, not a provider invoice — UI marks OMP cost rows "estimated (OMP)".
- Tokens per assistant message (Claude-style cadence), so existing insights heuristics hold without
  the codex result-fallback path.
- `agent_invocations` rows carry `('omp', 'omp-sdk'|'omp-pty', model, session-file path)` —
  provider-neutral table, no schema change beyond the Phase-0 CHECK widening.

## 10. Testing & CI

- Unit suites mirroring the codex set: `ompSdkManager.test.ts` (warm lifecycle, fingerprints,
  turn contract, kill paths), `ompRpcClient.test.ts` (framing incl. 1 MiB cap + v2 chunking,
  ready-handshake refusal), `ompEventProjector.test.ts` (every event type → envelope),
  `ompApprovalBridge.test.ts`, `ompPermissionConfig.test.ts`, `ompPtyManager.availability.test.ts`,
  `ompMcpConfigWriter.test.ts` (env-expansion contract), gating-extension tests (deny/allow/throw
  fails closed) run against a stub socket.
- The RPC contract-fixture test (§3.4).
- Cross-cutting: every Phase-0 registry test, `panelLane`, facade dispatch, migration rebuild tests
  (parity + FK preservation), quick-create validation, picker/store frontend tests.
- CI: all in the unit tier (`panels/omp/` is outside the mocked-SDK itest scope, same as
  `panels/codex/`); nothing under `panels/claude/` should need touching except the shared facade —
  if it is touched, `pnpm test:integration` is mandatory per standing rule.
- Manual smoke checklist (a real `omp` binary): the Phase-1 acceptance list + a scripted
  "deny in default mode / allow in dontAsk" probe + a mid-session `set_model` flip across two OMP
  providers (e.g. an Anthropic model → a local Ollama model) — the actual product promise.

## 11. Risks & open questions

| # | Risk / unknown | Mitigation |
|---|---|---|
| 1 | OMP's release velocity breaks the RPC contract under us | min-version floor + tested-version banner + contract fixtures; we spawn the user's binary, so breakage is visible, not silent |
| 2 | mcp.json env injection semantics | RESOLVED — bare-name pre-connect copy from process env is documented (`docs/mcp-config.md`); contract-tested in `ompMcpConfigWriter.test.ts` |
| 3 | Hook (`tool_call`) scope inside OMP subagents unknown | deny `task` tool in EVERY mode until proven; upstream question filed |
| 3b | ~~OMP hard-caps `tool_call` handlers at 30 s (no knob)~~ **RESOLVED, omp 17.3.5** — the cap is now the `extensionHandlers.toolCallTimeoutMs` setting (no upper clamp). cyboflow raises it per spawn through a `PI_CONFIG_FILES` config overlay and hands the gate the matching budget, so a human is no longer forced to answer inside ~25 s. The 25 s budget remains the floor for omp < 17.3.5 and for a spawn whose overlay could not be written. | `ompHandlerTimeoutOverlay.ts`; version-gated by `supportsConfigurableHandlerTimeout` |
| 4 | No RPC structured-output → T3 blocked | defer T3; consider upstreaming `output_schema` |
| 5 | No `--mcp-config` path flag → in-place sessions lack `cyboflow_*` | v1 limitation; upstream PR candidate |
| 6 | `agent_end.isTerminal` semantics (maintenance resumes) could double-resolve a turn | manager treats only `isTerminal !== false` as terminal and ignores post-terminal events until next prompt; fixture-tested |
| 7 | OMP TUI inside our PTY may probe terminal capabilities differently than codex/claude TUIs | smoke early in Phase 1; `omp-pty` is severable from the phase if it stalls |
| 8 | Bun/native-addon issues on user machines (addon self-extracts to `~/.omp/natives`) | availability probe runs a real `--version` + RPC ready handshake, so a broken install fails at detection, not mid-session |
| 9 | Two more lanes multiply the remaining frontend ternaries we did not catch | Phase-0 capability-flag registry + a grep-audit task (`'codex'` / `codex-` in `frontend/src`) at the end of Phase 1 |
| 10 | Migration-number collisions with unpushed sibling branches (101/102 claimed) | renumber at rebase, standing practice |

## 12. Non-goals (v1)

Bundled OMP binary; per-provider credential UI; OMP as main orchestrator (T2) or juror (T3);
token-level live-tail for omp-sdk; `omp-pty` in workflows; OMP subagent
(`task`/vibe-mode) orchestration under cyboflow flows; Windows/Linux validation (macOS first, same
as the rest of the app).

## 13. Rollout order

Phase 0 (generalization, behavior-neutral) → Phase 1 (T0 quick sessions, gated by the
provider-access toggle whose **absent-key default for OMP is disabled** — the Phase-0 item-5
policy, so existing installs never see OMP until they opt in) → Phase 2 (T1 per-step agents) →
Phase 3 (T2/T3, each gated on its open questions). Each phase is independently landable,
gate-green, and live-smoked before the next starts.

## 14. Adversarial-review dispositions (Codex, 2026-08-14)

The first committed revision of this proposal was adversarially reviewed by Codex against the
actual tree (verdict: needs-attention, 8 findings). All eight were verified and accepted; the
sections above already incorporate them. For provenance:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | critical | `acceptEdits`/`auto` mapped to OMP `write` mode auto-approves every write-tier tool incl. all MCP tools | §5.3 rewritten: OMP tiers are never the trust boundary; `always-ask` + cyboflow's own predicate in the gate; fail-closed bridge |
| 2 | critical | Project-local OMP discovery (`.omp/` extensions/hooks/tools) executes repo-controlled TS in-process before any gate | §8.2 rewritten: discovery lockdown on every managed spawn; trusted-repo opt-in |
| 3 | high | Emitting `get_session_stats` rollups per turn double-bills warm sessions (A + A+B + A+B+C) | §5.1/§9: per-turn delta contract + three-turn accounting test |
| 4 | high | `workflow_variants` (mig 068) CHECK constraints missing from the rebuild list | §4 item 3: added, plus upgrade-then-save-variant test and a constraint grep sweep |
| 5 | high | Phase 1 needs `isWorkflowRuntimeSupported` membership the plan deferred to Phase 2 (quick-sentinel identity loss vs premature T1 advertising) | §3.2: `WORKFLOW_RUN_STORABLE_RUNTIMES` vs `WORKFLOW_LAUNCHABLE_RUNTIMES` split in Phase 0 |
| 6 | high | Live T0 dispatch paths missing from the inventory (`useClaudePanel.ts:28-47`, `ipc/session.ts` queue handlers, `sessionManager.addPanelOutput` refresh signal) | §5.5: inventory extended + four-event-class registry tests |
| 7 | high | Only `confirm` UI-request kind handled; blocking `select`/`input`/`editor` frames hang the turn | §5.3: every blocking kind answered deterministically, per-kind tests |
| 8 | medium | Absent provider-access key floors to enabled → OMP defaults ON for existing installs | §4 item 5 + §13: per-provider `defaultEnabled`, new providers absent⇒disabled |

## 15. Implementation-review dispositions (Codex, 2026-08-14, post-Phase-2)

Phases 0–2 were implemented on `hazy-glade-20260814` and the full branch diff was adversarially
reviewed by Codex against this document as the spec (verdict: needs-attention, 5 high findings).
All five were verified and fixed on the same branch. For provenance:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | high | Packaged builds unconditionally refused every omp-sdk launch (the gate .ts shipped nowhere; the resolver threw under `app.isPackaged`) | `extraResources` entry `omp-gate/ompGateExtension.ts` + resolver reads `process.resourcesPath`; a config-shape test pins the from/to pair against the resolver constants |
| 2 | high | An empty `cyboflowMcpToolNames` fell back to the spoofable `mcp__cyboflow_` prefix — in-place sessions pass an empty list, and a foreign server named `cyboflow-extra` sanitizes into that namespace | Prefix fallback deleted; exact membership is the ONLY MCP auto-allow path; empty/absent/malformed auto-allows nothing (undecidable MCP calls fall to the human gate) |
| 3 | high | A whole-run OMP launch could resolve onto the deferred orchestrated/T2 plane (no envelope, no question bridge, `task` denied) | `ProviderOrchestratedUnsupportedError` at `createRun` (own copy — the mixed-provider prompt's text is Codex-specific) via a `SUPPORTS_ORCHESTRATED` predicate that defaults new providers unsupported; `runExecutor`'s missing-runner fallback fails the run loudly; quick sentinel exempt |
| 4 | high | A/B quick arms stamped an omp-sdk arm's SESSION row `claude-sdk` (the arm stamp recognized only codex-sdk), dispatching its chat turns to Claude while the sentinel said omp | `resolveNonClaudeSessionRuntime` (registry-driven, single-sourced with the quick-create handler); end-to-end arm test asserts session row + sentinel agree |
| 5 | high | Name-only `read`/`grep` auto-allow let `ssh://` targets ride the allow→auto-approve chain (OMP self-escalates scheme targets to remote exec) with zero human involvement | All three mode-scoped allowlists (incl. Bash allow-rules, no carve-outs) narrowed by a recursive URI-scheme scan over the call arguments; scheme-bearing targets fall to the human gate; mutation-verified tests |

Known follow-ups deliberately left open: the SessionStartWizard's Orchestration tri-state still
offers OMP+orchestrated and only learns of the refusal at launch (pre-empting it in the renderer is
the trigger to move `SUPPORTS_ORCHESTRATED` into `shared/`); the mixed-provider prompt's hardcoded
Codex copy predates this branch and misdescribes an OMP per-agent pin; the >25 s human-approval
constraint (§5.3) stands until a `tool_call` budget knob is upstreamed to OMP.

### 15.1 Full-app UI smoke (dev build, post-review)

A CDP-driven smoke of the dev app (fresh data dir, real `omp` 17.3.2) covered: onboarding
ConnectStep 3-provider detect + OMP enable; Integrations card (detected/version/path, toggle
persisted); quick-session configure (runtime quad, OMP caveat panel, OMP-relabeled permission
options, per-provider `optgroup` model catalog with canonical `provider/id` values); an `omp-sdk`
read turn (auto-allowed by the gate, usage/cost accrued); a write turn approved through the
in-session `__quick__` Pending-approvals card within the 25 s budget (file written, turn clean);
a second write REJECTED (tool blocked, model informed legibly, no file, no retry loop); and an
`omp-pty` terminal session (TUI boots in the panel, typed input round-trips). Zero OMP-related
errors in either debug log.

One new finding, found by the smoke's first (failed) run: **an orch socket path over the ~104-byte
macOS `sun_path` limit breaks the OMP gate specifically.** Node silently truncates the path on both
bind and connect (so the app "listens" and Node-side MCP clients still connect — the only tell is
the boot log's `could not stat bound socket` ENOENT warning), but Bun inside the gate extension
does not, so every socket-routed approval fails closed ("unreachable cyboflow orchestrator
socket"). Fail-closed behavior itself worked exactly as designed. Exposure: any long
`CYBOFLOW_DIR` — notably the verify-setup dogfood pattern of leasing a verification instance with
a data dir deep under a worktree. Candidate fix: bind an additional short alias path (e.g.
`/tmp/cyboflow-<hash>.sock`) for the gate, or preflight the length at boot and warn loudly.
Cosmetic nit from the same pass: the Integrations card renders the version as "omp omp/17.3.2"
(binary name prepended to the already-prefixed version string).

### 15.2 Real workflow smoke — a full /sprint on omp-sdk (dev build)

A second CDP-driven smoke ran an actual **sprint** end-to-end on OMP: one backlog task
("Add CONTRIBUTING.md"), whole-run `omp-sdk` + `anthropic/claude-sonnet-4-5`, execution model
Programmatic, permission Allow edits. **The machinery works**: the run launched (panel header
"OMP · SDK transport · flow run"), the DAG walked every step on OMP agents —
dependency-analyzer → implement → write-tests → code-review → task-verify → visual-check (n/a) →
lane `integrated`, merge gate 1/1 → sprint-verify → sprint-review → address-review → human
sign-off gate → "Workflow complete" (8 turns, 21 min, 1.1M tokens incl. cache). resultText
verdict parsing on OMP drove every transition; the eval jury ran on completion (Claude jurors
scored; the Codex slot failed *correctly* with `ERR_AGENT_PROVIDER_DISABLED[codex]` since Codex
is toggled off, and the jury degraded legibly); its advisory finding rendered in Insights.
Defense-in-depth also showed up live: the gate's `denyTaskTool` blocked a lane agent's subagent
delegation and the agent degraded gracefully to doing the analysis inline.

Findings — **ALL FOUR FIXED** (commits `e52abbdc` / `4a85bef3` / `8688ea7c` / `251e3de4` /
`342e25e7`; dispositions inline):

1. **Lane agents cannot commit — sprint work lands uncommitted while lanes report
   `integrated`.** Under Allow edits, the OMP gate auto-allows `write`/`edit` but sends every
   `bash` (incl. `git status` / `git add … && git commit`) to the human gate, where it dies at
   the 25 s budget. The implement agent's own report: "git commit pending cyboflow approval
   gate." The merge gate then stamped 1/1 MERGED with zero commits — the engine trusts step
   verdicts and never checks git.
   **FIXED, both halves.** (a) `4a85bef3`: the gate gained an argument-aware `safe-bash` rung
   (acceptEdits/auto, inside the URI narrowing): provably read-only segments (line-for-line
   mirror of `safeCommandClassifier.ts`, drift-pinned by a parity test) OR local-only git writes
   (`add`/`commit`/`restore`/`rm`/`mv`; no substitution/redirection/global-option/remote
   subcommands), with an extra raw-newline refusal — mutation-verified. (b) `8688ea7c`: the
   fan-out engine consults an optional fail-soft commit probe before stamping `integrated`; a
   lane with HEAD unmoved AND a dirty tree is failed with a legible reason instead (the only
   unambiguous case — sibling lanes share the worktree).
   **Routed follow-up discovered during the fix:** the SHARED classifier's segment splitter
   treats a raw newline as an ordinary character, so `Bash {command: "git status\nrm -rf ~"}`
   auto-approves under acceptEdits on BOTH Claude substrates today. The OMP gate refuses it;
   the parity test pins the shared classifier's current verdict so a fix there flips the pin
   deliberately.
2. **Per-lane gated approvals are invisible after the first.** The backend log shows five
   `shell-approval registered (held open)` entries but only ONE `Bridged approvalCreated`; the
   Human-review badge stayed 0 while lane bashes timed out.
   **FIXED** (`e52abbdc`): root cause was `clearPendingForRun` — designed for run termination —
   being reused by the socket-disconnect path without restoring `awaiting_review → running`, so
   every later `requestApproval` waited forever and never inserted a row. The disconnect path
   now calls `abandonPendingForRun`, which shares the settle body and adds the guarded restore
   (never resurrecting a terminal run); negative-control-verified. This also repairs the same
   latent wedge on the interactive Claude substrate (a hook subprocess dying mid-wait).
3. **The workflow configure screen's LAUNCH SUMMARY shows "RUNTIME: Claude SDK" while the
   select's value is `omp-sdk`** (the quick-session summary shows the runtime correctly) —
   display-only, the run launches on OMP.
   **FIXED** (`251e3de4`): the hand-rolled ternary was replaced by an exhaustive
   `AGENT_RUNTIME_LABELS: Record<SessionAgentRuntime, string>` in `shared/types/agentRuntime.ts`
   — an unlabeled future runtime now fails typecheck instead of misrendering.
4. **Flow-run cost is blank for OMP** ("cost —" in the completion panel and Insights stats)
   while quick sessions do show a computed cost — the run-usage cost seam doesn't produce a
   figure for OMP flow runs.
   **FIXED** (`342e25e7`): the rollup sums `result` raw_events' `total_cost_usd` (Claude's raw
   key); OMP emitted `cost_usd` only. All THREE result-build sites — `projectAgentEnd` (the
   normal terminal path the brief-level analysis initially missed) plus the local-completion
   and failure builders — now emit both keys; the rollup reads one key once per row, so no
   double-count.

### 15.3 Fix-verification rerun — the same /sprint on omp-sdk (2026-08-15)

The §15.2 smoke was rerun end-to-end on the fixed build (`45530fb4`): fresh data dir, fresh
demo repo, same task (CONTRIBUTING.md), sprint on `omp-sdk` / `anthropic/claude-sonnet-4-5` /
Allow edits / programmatic. Every §15.2 defect is observably gone:

1. **The lane committed its own work.** Gate log: 6× `allowed \`bash\` (safe-bash)` (including
   the `git add`/`git commit` pair), 1× `write (edit-tool)`, 9× `read (auto-allow-tool)`, 5×
   `blocked \`task\`` (expected subagent denial), 1× socket round-trip approved. Session
   worktree ended clean at `e0ee93a docs: add CONTRIBUTING.md`; merge gate 1/1; the commit
   probe had nothing to veto.
2. **Approvals stayed visible and the run never wedged.** Pending-approvals badge went
   0 → 1 (sign-off gate) → 0 on approve; the one orchestrator-socket bash approval resolved
   without parking the run.
3. **LAUNCH SUMMARY showed `RUNTIME: OMP`** with the `omp-sdk` select value.
4. **Cost rendered everywhere it was blank before:** completion panel `cost $1.90 · 8 turns ·
   runtime 23m 35s`, Insights stats `sprint … runs 1 · cost $1.90`, session panel `$3.16`
   cumulative.

Whole run: 8 turns / ~24 min / 942k tokens; eval jury scored 100/100 with the Codex slot
again failing correctly (`ERR_AGENT_PROVIDER_DISABLED`). Also incidentally re-confirmed the
spawner-death reaping: killing the dev Electron took the warm `omp --mode rpc-ui` child and
its MCP subprocesses with it.
