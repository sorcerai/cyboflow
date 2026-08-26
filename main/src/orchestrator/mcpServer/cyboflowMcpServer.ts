#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as net from 'net';
import type { QuestionPayload } from '../../../../shared/types/questions';
import { REPORTABLE_ARTIFACT_ATYPES } from '../../../../shared/types/artifacts';
import { ASSISTANT_REFERENCE } from '../agentThread/assistantReference';
import { startParentWatchdog, resolveWatchdogIntervalMs } from './parentWatchdog';

// ---------------------------------------------------------------------------
// Env-var bootstrap — must happen before anything else
// ---------------------------------------------------------------------------

const runId = process.env.CYBOFLOW_RUN_ID;
const socketPath = process.env.CYBOFLOW_ORCH_SOCKET;

if (!runId || !socketPath) {
  process.stderr.write(
    `[Cyboflow MCP] Fatal: required env vars missing.\n` +
      `  CYBOFLOW_RUN_ID=${runId ?? '(unset)'}\n` +
      `  CYBOFLOW_ORCH_SOCKET=${socketPath ?? '(unset)'}\n`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Scope gate (S0.4 / global agent)
//
// CYBOFLOW_MCP_SCOPE=global-agent restricts this subprocess to the read +
// propose-action tool family declared below the run-scoped 31 — none of the
// run-scoped tools are listed or callable. Unset/any other value keeps the
// EXISTING tool list with ZERO behavior change, and the agent family is not
// exposed. Set only by the agent spawn's MCP entry (AgentThreadService,
// later task) — a run-scoped session spawn never sets this env var. The
// subprocess is single-scope-bound for its whole lifetime (mirrors `runId`
// being a closed-over module const), so one module-init branch is sufficient
// — no per-call gating needed.
// ---------------------------------------------------------------------------
const IS_GLOBAL_AGENT_SCOPE = process.env.CYBOFLOW_MCP_SCOPE === 'global-agent';

// ---------------------------------------------------------------------------
// Design scope (Design Mode v0 / docs/ideas/design-mode.md)
//
// CYBOFLOW_MCP_SCOPE=design restricts this subprocess to the minimal
// design-session tool family (DESIGN_TOOLS below): get the linked idea, update
// the design-spec draft, and report the ui-prototype artifact — none of the
// run-scoped tools (board/backlog/sprint/etc.) are listed OR callable, and a
// direct CallTool for one throws 'Unknown tool' (design-mode.md: scope is
// enforced by direct-invocation rejection, not merely by ListTools omission).
// Set only by an SDK design-session spawn's MCP entry (claudeCodeManager's
// mcpScope:'design'); a run-scoped session never sets it. Single-scope-bound
// for the subprocess lifetime, so one module-init branch suffices.
// ---------------------------------------------------------------------------
const IS_DESIGN_SCOPE = process.env.CYBOFLOW_MCP_SCOPE === 'design';

// ---------------------------------------------------------------------------
// Crash-isolation handlers (install early so they cover all subsequent code)
// ---------------------------------------------------------------------------

process.on('uncaughtException', (err: Error) => {
  console.error('[Cyboflow MCP] Uncaught:', err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Cyboflow MCP] Unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------
// Orchestrator IPC socket
// ---------------------------------------------------------------------------

type ResponseResolver = (response: unknown) => void;
type ResponseRejecter = (reason: Error) => void;

interface PendingRequest {
  resolve: ResponseResolver;
  reject: ResponseRejecter;
}

const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;
let ipcClient: net.Socket | null = null;

// Module-scope narrowed constant — the env-var guard above ensures this is
// always a string by the time we reach this point.
const SOCKET_PATH: string = socketPath;

function rejectAllPending(reason: Error): void {
  for (const { reject } of pendingRequests.values()) {
    reject(reason);
  }
  pendingRequests.clear();
}

function connectToOrchestrator(): net.Socket {
  const socket = net.createConnection(SOCKET_PATH);

  // Rolling receive buffer — stream sockets can split a JSON message across
  // multiple 'data' events, or batch messages without a trailing newline in
  // the first chunk.  We retain any incomplete tail for the next event.
  let recvBuffer = '';

  socket.on('data', (buf: Buffer) => {
    recvBuffer += buf.toString('utf8');
    let nl: number;
    while ((nl = recvBuffer.indexOf('\n')) !== -1) {
      const line = recvBuffer.slice(0, nl).trim();
      recvBuffer = recvBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const rid = msg['requestId'];
        if (typeof rid === 'string' && pendingRequests.has(rid)) {
          const pending = pendingRequests.get(rid)!;
          pendingRequests.delete(rid);
          pending.resolve(msg);
        }
      } catch (err) {
        console.error('[Cyboflow MCP] Failed to parse IPC response:', err, 'raw:', line);
      }
    }
  });

  socket.on('error', (err: Error) => {
    console.error('[Cyboflow MCP] IPC socket error:', err.message);
    // Belt-and-suspenders: reject any callers that are waiting, in case
    // 'close' is not emitted (or is delayed) after 'error'.
    rejectAllPending(err);
  });

  // The orchestrator went away (app quit / crash). This is a SECOND, coarser
  // tether than the spawner-death path below: this socket is APP-GLOBAL, so it
  // closes when the Electron main process dies, not when this server's `claude`
  // spawner does. It is kept because it is still correct — a server with no
  // orchestrator can do nothing useful — but it must never again be mistaken
  // for a per-run lifetime bound. See PLAN-mcp-orphan-reaper.md §2.
  //
  // LOAD-BEARING INVARIANT: a server whose spawner has died is provably useless
  // because MCP requests arrive ONLY via stdin — this socket carries only
  // server-initiated request/reply traffic (see sendQuery), never unsolicited
  // orchestrator-pushed messages. If anyone adds a push channel here
  // (cancellation, config reload, a question-gate answer path), that invariant
  // breaks and the shutdown policy below has to be revisited.
  socket.on('close', () => { shutdown('IPC socket closed'); });

  return socket;
}

function sendQuery(
  type: string,
  params: Record<string, unknown>,
  timeoutMs: number | null = 30_000,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (!ipcClient || ipcClient.destroyed) {
      reject(new Error('[Cyboflow MCP] IPC client not connected'));
      return;
    }
    const requestId = `req-${++requestCounter}-${Date.now()}`;

    // timeoutMs null = wait forever. Safe only because this process exits when
    // its SPAWNER dies (stdin EOF / the ppid watchdog — see the shutdown block
    // near the bottom of this file), which bounds a pending entry by the run.
    //
    // It is NOT made safe by the IPC socket closing, which is what this comment
    // used to claim. CYBOFLOW_ORCH_SOCKET is app-global: it outlives every run
    // in the app's lifetime, so tethering to it is exactly what leaked 40
    // orphaned servers in a single uptime. Do not restore that reasoning.
    const timer = timeoutMs === null
      ? undefined
      : setTimeout(() => { pendingRequests.delete(requestId); reject(new Error('orchestrator_timeout')); }, timeoutMs);

    pendingRequests.set(requestId, {
      resolve: (response: unknown) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(response);
      },
      reject: (reason: Error) => {
        if (timer !== undefined) clearTimeout(timer);
        reject(reason);
      },
    });

    const payload = JSON.stringify({ type, requestId, runId, ...params });
    ipcClient.write(payload + '\n');
  });
}

// Expose for use in TASK-453 tool implementations
export { sendQuery };

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'cyboflow', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// ---------------------------------------------------------------------------
// Global-agent tool family (S0.4) — the ONLY tools advertised when
// IS_GLOBAL_AGENT_SCOPE is true. Every read is cross-project (no
// CYBOFLOW_RUN_ID project binding); cyboflow_propose_action is the sole
// write-shaped tool and it NEVER executes — see its description below.
// ---------------------------------------------------------------------------
const GLOBAL_AGENT_TOOLS = [
  {
    name: 'cyboflow_overview',
    description:
      'READ-ONLY, cross-project digest: for every project, its active/recent sessions (each with its live run — workflow name, status, current step — when one exists), plus a pending blocking-gate count and a pending-question count. Compact JSON. No arguments.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cyboflow_backlog',
    description:
      "READ-ONLY, cross-project backlog listing (ideas/epics/tasks) with priority/stage/version. Omit project_id to see every project merged into one list; pass it to scope to one project. include_archived / include_done mirror cyboflow_list_tasks' semantics (both default false).",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Optional — scope to one project. Omitted = every project.' },
        task_type: { type: 'string', enum: ['idea', 'epic', 'task'], description: 'Optional filter to one entity type.' },
        include_archived: { type: 'boolean', description: 'Include archived items. Defaults to false.' },
        include_done: { type: 'boolean', description: 'Include done/retired items. Defaults to false.' },
      },
      required: [],
    },
  },
  {
    name: 'cyboflow_entity',
    description:
      "READ-ONLY: fetch one backlog entity's full body by opaque id or display ref (e.g. 'TASK-014'). A ref is unique only WITHIN a project — pass project_id to disambiguate a ref across projects (an opaque id needs no project_id, it is already globally unique).",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: "Opaque backlog id OR display ref (e.g. 'TASK-014') (required)" },
        project_id: { type: 'number', description: 'Optional — disambiguates a ref across projects.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cyboflow_queue',
    description:
      'READ-ONLY, cross-project review_items inbox listing (kind, blocking, status, title, entity link). Defaults to pending items only; pass include_resolved to see resolved/dismissed ones too. Omit project_id to see every project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Optional — scope to one project. Omitted = every project.' },
        include_resolved: { type: 'boolean', description: 'Include resolved/dismissed items. Defaults to false.' },
      },
      required: [],
    },
  },
  {
    name: 'cyboflow_workflows',
    description:
      'READ-ONLY, cross-project workflow listing (id, name, scope global|project, is_built_in, has_custom_spec). Omit project_id to see every workflow row across every project; pass it to also include that project\'s own scoped rows.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'number', description: 'Optional — also include this project\'s own scoped rows.' },
      },
      required: [],
    },
  },
  {
    name: 'cyboflow_workflow',
    description:
      "READ-ONLY: one workflow's EFFECTIVE definition (spec_json wins, else the built-in fallback) plus a server-computed `spec_hash` — pin THIS hash in a cyboflow_propose_action{kind:'edit-workflow'} call's payload as the precondition your edit was drafted against (the server re-verifies it at confirm time; propose_action itself also re-computes it server-side, ignoring anything a caller might pass). Unknown id -> 'not_found'.",
    inputSchema: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: 'The workflow id (from cyboflow_workflows) (required)' },
      },
      required: ['workflow_id'],
    },
  },
  {
    name: 'cyboflow_db_query',
    description:
      "READ-ONLY, cross-project ad-hoc SQL diagnostic query — for questions the other curated tools can't answer (e.g. 'why did session X get stuck', an event timeline, token usage). Runs on a DEDICATED readonly database connection: read-only is enforced by that connection itself, not merely by validation, so a write attempt is refused regardless. A single SELECT, WITH, or EXPLAIN statement only — no ATTACH, no PRAGMA, no multiple statements (';' followed by more SQL is rejected). Explore the schema first with `SELECT name, sql FROM sqlite_master WHERE type='table'`. Results are capped (200 rows, ~100KB). Prefer the curated tools (cyboflow_overview / _backlog / _entity / _queue / _workflows / _workflow) when they already answer the question — reach for this only when they don't.",
    inputSchema: {
      type: 'object',
      properties: {
        sql: { type: 'string', description: 'A single read-only SQL statement (SELECT/WITH/EXPLAIN) (required)' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'cyboflow_reference',
    description:
      "READ-ONLY deeper product reference on cyboflow's features (the five built-in flows, sessions/worktrees, the backlog & board, the review queue, experiments & variants). Call with NO topic (or an empty one) to get the table of contents — every topic key plus a one-line summary — then call again with a `topic` key for that section's full markdown. Serves static, curated content: use it when the user asks how a cyboflow feature works or what a flow does. An unknown topic is rejected with the list of valid keys.",
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Optional kebab-case topic key (from the no-topic table of contents). Omit to get the table of contents.',
        },
      },
      required: [],
    },
  },
  {
    name: 'cyboflow_fs_read',
    description:
      "READ-ONLY file read, scoped to the registered project folders (plus any folders the user configured as extra assistant access). Use it to read source, config, or docs to answer code-level questions about a project. Returns { path, content, truncated, totalBytes }. The path must resolve inside an allowed folder (a scope_denied error names the allowed roots so you can retry within them); secret files (.env, private keys, credential stores) are refused; binary files are refused; content is capped (~256KB) — pass offset_line + limit_lines to page through a large file.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a file inside an allowed project/extra folder (required)' },
        offset_line: { type: 'number', description: 'Optional 1-based line to start from (with limit_lines) for large-file paging.' },
        limit_lines: { type: 'number', description: 'Optional number of lines to return from offset_line.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'cyboflow_fs_list',
    description:
      "READ-ONLY directory listing, scoped to the registered project folders (plus configured extras). Returns { path, entries:[{name, type:'file'|'dir'|'symlink', size}], truncated } (capped at 500 entries). The path must resolve inside an allowed folder (scope_denied otherwise, naming the roots). Secret file NAMES are shown (metadata), but their content stays unreadable via read/grep. Use it to discover a project's layout before reading or grepping.",
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to a directory inside an allowed project/extra folder (required)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'cyboflow_fs_grep',
    description:
      "READ-ONLY recursive regex search, scoped to the registered project folders (plus configured extras). Returns { matches:[{file, line, text}], truncated, filesScanned }. Case-insensitive by default (set case_sensitive:true to change). The walk never follows symlinks and skips .git/node_modules/dist/build/.venv/__pycache__; secret and binary files are skipped. Optional `glob` filters by basename (e.g. *.ts). Caps: 200 matches, 20000 files scanned, per-line text truncated to 500 chars. An invalid regex returns invalid_regex; an out-of-scope path returns scope_denied naming the allowed roots. Use it for code-level questions; prefer cyboflow_db_query for app-state/database questions.",
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular-expression pattern to search for (required)' },
        path: { type: 'string', description: 'Absolute path to a file or directory inside an allowed folder (required)' },
        glob: { type: 'string', description: 'Optional basename glob to filter files, e.g. *.ts' },
        case_sensitive: { type: 'boolean', description: 'Optional; match case-sensitively. Defaults to false (case-insensitive).' },
        max_results: { type: 'number', description: 'Optional cap on matches, clamped to <= 200.' },
      },
      required: ['pattern', 'path'],
    },
  },
  {
    name: 'cyboflow_history',
    description:
      "READ-ONLY search over YOUR OWN past conversation transcripts with this user — your long-term memory. Your live context resets daily, but every past turn is durably kept; this tool reaches all of it. Without query: pages back through past turns newest-first (before_id continues a listing). With query (case-insensitive PLAIN-TEXT substring, not a regex): returns past turns whose text contains it, newest first, each as an excerpt around the first occurrence. role filters to 'user' or 'assistant' turns; days_back restricts to the last N days. Results are capped (limit clamps to 50, default 20, ~100KB payload) — truncated:true plus a numeric nextBeforeId mean there is more; pass nextBeforeId as before_id to continue. Use it when the user references a past conversation ('as we discussed', 'that thing from last week'), asks what was talked about before, or when earlier context would clearly help — never claim you don't remember without searching first.",
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional case-insensitive plain-text substring (not a regex). Omit to browse past turns newest-first.',
        },
        role: {
          type: 'string',
          enum: ['user', 'assistant'],
          description: "Optional — return only your turns ('assistant') or only the user's ('user').",
        },
        days_back: { type: 'number', description: 'Optional — restrict to turns from the last N days.' },
        before_id: {
          type: 'number',
          description: 'Optional paging cursor — pass a previous call\'s nextBeforeId to continue that listing.',
        },
        limit: { type: 'number', description: 'Optional turn count; clamped to <= 50 (default 20).' },
      },
      required: [],
    },
  },
  {
    name: 'cyboflow_propose_action',
    description:
      "THE ONLY write-shaped tool available to the global agent. Records a proposal — a candidate action for a human to review — and returns { proposalId }. Calling this tool NEVER executes anything: no run is launched, no task is reprioritized, no workflow is edited, nothing navigates. A human must explicitly confirm the resulting proposal card before any side effect happens, and confirmation runs through the SAME chokepoints every other write in this app uses (TaskChangeRouter / WorkflowRegistry / RunLauncher), stamped actor:'user'. After calling this tool, STOP and describe the proposal in your reply — do NOT claim the action happened, and do NOT poll or retry waiting for it to happen. `payload_json` is a JSON-encoded object (field names camelCase, matching shared/types/agentThread.ts AgentProposalPayload exactly) whose `kind` selects its shape: launch-run {kind,projectId,workflowName,substrate?,taskIds?,ideaIds?,findingIds?,note?}; reprioritize-backlog {kind,projectId,items:[{taskId,priority?,stageId?}]}; edit-workflow {kind,workflowId,definitionJson,summary?} (preconditions — the current spec hash — are captured server-side from a fresh read, never trusted from the caller, even if you include one); open-session {kind,navigation:{target:'run',runId}|{target:'quick-session',sessionId,runId?}}. An unrecognized kind or a payload missing a kind's required fields is rejected with 'invalid_payload'.",
    inputSchema: {
      type: 'object',
      properties: {
        payload_json: {
          type: 'string',
          description: 'JSON-encoded AgentProposalPayload (required) — see the tool description for the per-kind shape.',
        },
      },
      required: ['payload_json'],
    },
  },
];

// ---------------------------------------------------------------------------
// Design-session tool family (Design Mode v0) — the ONLY tools advertised when
// IS_DESIGN_SCOPE is true. Deliberately minimal (design-mode.md "Session
// plumbing"): read the linked idea, persist the design-spec draft, acknowledge a
// delivered feedback batch (Design Mode v1's outbox ack), report the prototype
// (ui-prototype or interactive-prototype), and mint a single follow-up backlog
// TASK (the style-kit consent gate's "Add a task to the backlog"
// option). report_artifact is the SAME tool as run scope but with its atype
// narrowed to the two prototype atypes only; create_task is likewise narrowed to
// task_type='task' with a minimal arg set.
// ---------------------------------------------------------------------------
const DESIGN_TOOLS = [
  {
    name: 'cyboflow_design_get_idea',
    description:
      "READ-ONLY: return THIS design session's linked idea — its ref, title, full markdown body, and version. No arguments (the idea is resolved from the session's design_idea_id, re-validated every call). Read it first, every session, before grounding a design. If the idea link is broken (the idea was deleted or decomposed mid-session) this errors with 'idea_link_broken' — tell the user and stop writing.",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'cyboflow_design_update_draft',
    description:
      "Persist the current design-spec draft for THIS session (standalone markdown, '### '-level subsections; the host owns the wrapping '## Design spec' H2). Each call mints a new monotonic draft_revision bound to the session's CURRENT ui-prototype artifact revision, so Approve can CAS-reject a draft written against an older prototype. Returns { draftRevision, boundArtifactRevision } (boundArtifactRevision is null when no prototype exists yet). Refresh the draft right after every prototype re-report so the pair stays in lockstep.",
    inputSchema: {
      type: 'object',
      properties: {
        spec_markdown: {
          type: 'string',
          description:
            "The full current design-spec markdown (required). Begin at '### ' subsection level (e.g. '### Baseline', '### Design', '### Implementation notes') — do NOT emit the wrapping '## Design spec' H2 yourself.",
        },
      },
      required: ['spec_markdown'],
    },
  },
  {
    name: 'cyboflow_design_ack_feedback',
    description:
      "Acknowledge a batch of design feedback AFTER you have applied it and re-reported the prototype. The host sends the feedback as a revision turn carrying a batch id and an attempt id — echo both back here VERBATIM, together with the prototype artifact revision that now contains the change (the `boundArtifactRevision` cyboflow_design_update_draft returns after your re-report). This is what moves the batch to 'applied' and marks the user's comments addressed: WITHOUT it the feedback stays open no matter what you changed. First ack wins — a duplicate or late ack for the same batch is acknowledged-and-discarded (returns { applied: false }), never an error, so acknowledging a batch you suspect was already handled is always safe.",
    inputSchema: {
      type: 'object',
      properties: {
        batch_id: {
          type: 'string',
          description: 'The feedback batch id from the revision turn, verbatim (required).',
        },
        attempt_id: {
          type: 'string',
          description: 'The delivery attempt id from the revision turn, verbatim (required).',
        },
        prototype_revision: {
          type: 'integer',
          description:
            'The prototype artifact revision that now contains the applied feedback (required) — the `boundArtifactRevision` returned by cyboflow_design_update_draft after your re-report.',
        },
      },
      required: ['batch_id', 'attempt_id', 'prototype_revision'],
    },
  },
  {
    name: 'cyboflow_report_artifact',
    description:
      'Create or update THIS design session\'s single prototype mockup. Only **`ui-prototype`** (static HTML+CSS, no JS) or **`interactive-prototype`** (JS-enabled canvas) are reportable in a design session — no other artifact type. Write a self-contained index.html to $CYBOFLOW_RUN_ARTIFACTS_DIR/prototype/index.html and pass payload_json {"fileName":"prototype/index.html"} — an inline "html" key is rejected. There is ONE prototype per session: re-reporting ENRICHES it in place (and advances its revision). Returns { artifactId }.',
    inputSchema: {
      type: 'object',
      properties: {
        atype: {
          type: 'string',
          // Narrowed to the design-session artifact types. A design session
          // iterates ONE prototype (static or interactive) — every other atype is
          // rejected in handleDesignScopeCallTool before it can be forwarded.
          enum: ['ui-prototype', 'interactive-prototype'],
          description: "Artifact type (required) — 'ui-prototype' or 'interactive-prototype' in a design session.",
        },
        label: { type: 'string', description: 'Short tab/card label for the prototype (required)' },
        payload_json: {
          type: 'string',
          description:
            'Optional JSON payload: {"fileName":"prototype/index.html"} pointing at the static HTML+CSS mockup you already wrote under $CYBOFLOW_RUN_ARTIFACTS_DIR (a top-level "html" key is rejected — write the file, don\'t inline it).',
        },
      },
      required: ['atype', 'label'],
    },
  },
  {
    name: 'cyboflow_create_task',
    description:
      "Create ONE backlog TASK for follow-up work surfaced during this design session — canonically the style-kit consent gate's \"Add a task to the backlog\" option (a task to create the project's design system later). NARROWED in design scope: always creates a task_type='task' entity (category 'chore'); ideas, epics, and every other backlog write are unavailable here. Returns { task_id, ref }.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task title (required)' },
        body: {
          type: 'string',
          description:
            'Optional markdown body — what to build and any decisions already made (e.g. the intended style-kit location).',
        },
        priority: {
          type: 'string',
          enum: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'],
          description: "Optional priority (P0-P6); defaults to 'P2'.",
        },
      },
      required: ['title'],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (IS_DESIGN_SCOPE) {
    return { tools: DESIGN_TOOLS };
  }
  if (IS_GLOBAL_AGENT_SCOPE) {
    return { tools: GLOBAL_AGENT_TOOLS };
  }
  return {
    tools: [
      {
        name: 'cyboflow_list_pending_approvals',
        description:
          'Return all pending TOOL-PERMISSION approvals (canUseTool gates) across every running workflow in this Cyboflow workspace. Read-only. NOTE: this surface does NOT include human question/decision gates — an AskUserQuestion gate (e.g. approve-idea) lives in the questions surface and renders as an inline card in the run chat, so an empty result here does not mean no human gate is pending.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'cyboflow_get_run',
        description:
          "Fetch a workflow run's state (status, workflow name, timestamps, last 10 events) by ID. Read-only.",
        inputSchema: {
          type: 'object',
          properties: {
            run_id: { type: 'string', description: 'The workflow_runs.id to fetch' },
          },
          required: ['run_id'],
        },
      },
      {
        name: 'cyboflow_submit_checkpoint',
        description:
          'Record a checkpoint marker for the current run. This is an observational marker only — it does not change run status, approve anything, or notify the user.',
        inputSchema: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Short identifier for the checkpoint' },
            note: { type: 'string', description: 'Optional longer description' },
          },
          required: ['label'],
        },
      },
      {
        name: 'cyboflow_report_step',
        description:
          'Report the current workflow phase/step for the current run by its step id. This is an OBSERVATIONAL signal that drives the Workflow Progress panel only — it does NOT pause the run, change run status, approve anything, or notify the user (contrast with the PreToolUse approval gate). The run is bound from CYBOFLOW_RUN_ID, so there is no run_id argument.',
        inputSchema: {
          type: 'object',
          properties: {
            step_id: { type: 'string', description: "The workflow step id to mark as current (must exist in this run's workflow definition)" },
            status: { type: 'string', enum: ['running', 'done'], description: "Optional step status; defaults to 'running'" },
          },
          required: ['step_id'],
        },
      },
      {
        name: 'cyboflow_request_user_input',
        description:
          'Ask one or more workflow questions through the Cyboflow Human Review queue. This call BLOCKS until the human answers. Use it whenever a workflow asks for AskUserQuestion or request_user_input; never continue past the gate before this tool returns.',
        inputSchema: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              minItems: 1,
              maxItems: 4,
              items: {
                type: 'object',
                properties: {
                  header: { type: 'string', description: 'Short label for the question.' },
                  question: { type: 'string', description: 'Full question text.' },
                  multi_select: { type: 'boolean', description: 'Whether multiple options may be selected. Defaults to false.' },
                  options: {
                    type: 'array',
                    minItems: 2,
                    maxItems: 4,
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        description: { type: 'string' },
                        preview: { type: 'string', description: 'Optional markdown preview shown with this option.' },
                      },
                      required: ['label'],
                    },
                  },
                },
                required: ['header', 'question', 'options'],
              },
            },
          },
          required: ['questions'],
        },
      },
      {
        name: 'cyboflow_create_task',
        description:
          'Create a backlog idea/epic/task for THIS run\'s project. The task is run-bound (no project argument — the project is derived from CYBOFLOW_RUN_ID), routes through the single write chokepoint, and appears on the board. A task may sit directly under an idea (originating_idea_id, no parent_epic_id) ONLY when it is that idea\'s single task; creating a SECOND task-less-of-an-epic under the same idea is rejected with error idea_needs_epic — mint an epic (named after the idea) and pass parent_epic_id on every task.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Task title (required)' },
            task_type: { type: 'string', enum: ['idea', 'epic', 'task'], description: "Optional task type; defaults to 'idea'" },
            summary: { type: 'string', description: 'Optional SHORT one-line descriptor shown on the board card (keep it to a sentence). For the rich spec / acceptance criteria, use body.' },
            body: { type: 'string', description: 'Optional full markdown body — the canonical rich detail (the idea spec, the task description + acceptance criteria, file/dependency hints). This is what the entity artifact renders, so prefer it for anything multi-line; leave summary as the short caption.' },
            priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'], description: "Optional priority (P0-P6); defaults to 'P2'" },
            category: { type: 'string', enum: ['feature', 'bug', 'chore'], description: "Optional entity CLASSIFICATION (feature|bug|chore); defaults to 'feature'. Unrelated to cyboflow_report_finding's free-text grouping `category`." },
            repo: { type: 'string', description: 'Optional repo identifier' },
            parent_epic_id: { type: 'string', description: 'Optional parent epic id' },
            board_id: { type: 'string', description: 'Optional board id; defaults to the project default board' },
            initial_stage_id: { type: 'string', description: "Optional initial stage id; defaults to the board's first idea stage" },
            scope: { type: 'string', enum: ['small', 'large'], description: "Optional idea size hint; only meaningful for task_type='idea' (ignored on epic/task entities)" },
            originating_idea_id: {
              type: 'string',
              description:
                "Optional project-scoped idea ref-or-id (e.g. 'IDEA-009' or its opaque id) this epic/task originates from — only meaningful for task_type='epic'|'task' (ignored on idea creates). REQUIRED practice on a multi-idea planner run: an epic/task created without this on a run seeded with more than one idea is left with lineage NULL rather than guessed.",
            },
          },
          required: ['title'],
        },
      },
      {
        name: 'cyboflow_update_task',
        description:
          'Update editable fields of an existing task. Re-parenting via parent_epic_id is only valid for type=\'task\' (otherwise rejected with error invalid_parent); a stale expected_version is rejected with error concurrency. Re-parenting a task OFF its epic (parent_epic_id=null) or onto an idea that already has another epic-less task is rejected with error idea_needs_epic — a multi-task idea must keep its tasks under an epic.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task id to update (required)' },
            title: { type: 'string', description: 'Optional new title' },
            summary: { type: 'string', description: 'Optional new SHORT one-line descriptor shown on the board card. For the rich spec / acceptance criteria, use body.' },
            body: { type: 'string', description: 'Optional new full markdown body — the canonical rich detail rendered in the entity artifact (idea spec, task description + acceptance criteria). Prefer it over summary for anything multi-line.' },
            priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'], description: 'Optional new priority (P0-P6)' },
            category: { type: 'string', enum: ['feature', 'bug', 'chore'], description: "Optional new entity CLASSIFICATION (feature|bug|chore). Unrelated to cyboflow_report_finding's free-text grouping `category`." },
            repo: { type: 'string', description: 'Optional new repo identifier' },
            parent_epic_id: { type: 'string', description: 'Optional parent epic id (re-parent)' },
            expected_version: { type: 'number', description: 'Optional expected version for optimistic concurrency' },
            scope: { type: 'string', enum: ['small', 'large'], description: "Optional idea size hint; only meaningful for idea entities (ignored on epic/task entities)" },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'cyboflow_set_task_stage',
        description:
          'Move a task to a planning/terminal stage. Execution stages are orchestrator-derived and will be rejected (error forbidden_stage); a task with active runs will be rejected (error active_runs).',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task id to move (required)' },
            stage_id: { type: 'string', description: 'The target stage id (required)' },
            expected_version: { type: 'number', description: 'Optional expected version for optimistic concurrency' },
          },
          required: ['task_id', 'stage_id'],
        },
      },
      {
        name: 'cyboflow_add_task_dependency',
        description:
          'Record a task->task dependency edge for THIS run\'s project. task_id is the BLOCKED task; depends_on_task_id is the PREREQUISITE that must finish first. Each may be given as the opaque task id OR the display ref (e.g. TASK-001) — pass the ref straight from the sprint task list, it is resolved automatically. Routes through the single write chokepoint. Both must be real TASKS in this project (rejected with error invalid_dependency otherwise); a self-edge is rejected (invalid_dependency); an edge that would create a cycle among blocking edges is rejected (error dependency_cycle); re-adding an existing edge is an idempotent no-op. Default kind=\'blocking\' participates in sprint ordering; kind=\'related\' is advisory metadata only.',
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The BLOCKED task — opaque id or display ref e.g. TASK-001 (required)' },
            depends_on_task_id: { type: 'string', description: 'The PREREQUISITE that must finish first — opaque id or display ref e.g. TASK-001 (required)' },
            kind: { type: 'string', enum: ['blocking', 'related'], description: "Optional edge kind; defaults to 'blocking'" },
          },
          required: ['task_id', 'depends_on_task_id'],
        },
      },
      {
        name: 'cyboflow_set_idea_component',
        description:
          "Set one idea's component ledger state (migration 101's idea component ledger — idea-spec/prototype/architecture/epics/stories, each complete|incomplete|skipped). Routes through the single IdeaComponentRouter write chokepoint with source:'flow'; sourceRunId and the idea's builtAgainstVersion are resolved by the tool itself from THIS run, never accepted as input. idea_id may be the opaque idea id OR its display ref (e.g. 'IDEA-009') — resolved the same way as cyboflow_get_task. Setting a state ALWAYS clears any prior staleness on that component (an explicit stamp is a reviewed judgment, even 'still incomplete'). Stamp AFTER the body write that completes a component, never before — see cyboflow_get_task's description for why order matters.",
        inputSchema: {
          type: 'object',
          properties: {
            idea_id: { type: 'string', description: "Opaque idea id OR display ref (e.g. 'IDEA-009') (required)" },
            component: {
              type: 'string',
              enum: ['idea-spec', 'prototype', 'architecture', 'epics', 'stories'],
              description: 'Which of the five tracked idea components to set (required)',
            },
            state: {
              type: 'string',
              enum: ['complete', 'incomplete', 'skipped'],
              description: "The component's new state (required). 'skipped' must only be set deliberately — it is never inferred.",
            },
          },
          required: ['idea_id', 'component', 'state'],
        },
      },
      {
        name: 'cyboflow_list_tasks',
        description:
          "List the backlog (ideas/epics/tasks) for THIS run's project. Read-only and run-bound (no project argument — the project is derived from CYBOFLOW_RUN_ID). Returns COMPACT items WITHOUT their markdown body — use cyboflow_get_task to fetch one item's full body by the id or ref this tool returns. By default archived items and done/retired items are hidden; opt in with include_archived / include_done. Use this before cyboflow_create_task to check whether an idea/task already exists and avoid creating a duplicate.",
        inputSchema: {
          type: 'object',
          properties: {
            task_type: { type: 'string', enum: ['idea', 'epic', 'task'], description: 'Optional filter to one entity type; omit to list all three' },
            include_archived: { type: 'boolean', description: 'Optional; include archived items (archived_at set). Defaults to false.' },
            include_done: { type: 'boolean', description: "Optional; include done/retired items (isDone, or a decomposed idea). Defaults to false." },
          },
          required: [],
        },
      },
      {
        name: 'cyboflow_get_task',
        description:
          "Fetch ONE backlog entity with its FULL markdown body, by opaque id OR display ref (e.g. IDEA-009, EPIC-002, TASK-014) — pass a ref straight from cyboflow_list_tasks, it is resolved automatically. Read-only, scoped to THIS run's project: an id/ref that belongs to another project is reported as not_found. For an IDEA, the response also includes an 'attachments' array — [{ id, label, mimeType, path }], `path` a RESOLVED ABSOLUTE on-disk path (never base64/dataURLs) — read the image bytes yourself via the Read tool; an idea with none returns attachments: []. Epics/tasks carry no 'attachments' key. For an idea with an approved design (Design Mode), the response also includes 'approved_design': { approved_at, draft_revision, prototype_revision, snapshot_path }, `snapshot_path` a RESOLVED ABSOLUTE on-disk path to the approved prototype snapshot HTML — read it directly via the Read tool, no export step needed. An idea with no approved design omits the key. For an IDEA, the response ALSO includes 'components' — the idea component ledger, always all FIVE entries (idea-spec, prototype, architecture, epics, stories; see cyboflow_set_idea_component to write one), each `{ component, state, source, sourceRunId, sourceSessionId, builtAgainstVersion, staleAt, staleReason, updatedAt }`. `state` is one of complete|incomplete|skipped. CRITICAL: an `incomplete` component with `staleAt` non-null is NOT the same as one never started — it means prior work exists (from before the idea's body changed underneath it) and needs RE-VERIFICATION, not a redo from scratch; `staleAt === null` on an `incomplete` component means truly not started. Epics/tasks carry no 'components' key.",
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'Opaque backlog id OR display ref (e.g. TASK-014) to fetch (required)' },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'cyboflow_update_sprint_task',
        description:
          "Report per-task progress for THIS sprint run's task lanes (the structured per-task progress rail). The lane is run-bound: the batch is derived from CYBOFLOW_RUN_ID's workflow_runs.batch_id (a run launched without a sprint task batch is rejected with error sprint_lane_requires_batch_run). At least one of status / current_step is required. status='integrated' means the task is complete AND committed in the session worktree. This does NOT move the task on the board (board stages are orchestrator-derived) and does NOT pause the run.",
        inputSchema: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: 'The task whose lane to update — opaque id OR display ref e.g. TASK-001 (required; must be in this sprint batch; the ref is resolved automatically, pass it straight from the sprint task list)' },
            status: {
              type: 'string',
              enum: ['queued', 'running', 'integrated', 'failed', 'blocked'],
              description: "Optional new lane status; 'integrated' = task complete + committed in the session worktree",
            },
            current_step: {
              type: 'string',
              // NOT an enum: the lane step vocabulary is now CHAIN-DERIVED (a
              // workflow's fanOut.inner ids, editable via the workflow editor) —
              // authoritatively validated server-side against the calling run's
              // resolved chain, not client-side against a fixed list. See the
              // CallTool handler below.
              description:
                "Optional per-task lane step the executing subagent is on — must be one of this run's lane step ids (the fan-out chain listed in the orchestrator's instructions; canonical default: implement, write-tests, code-review, task-verify, visual-verify, awaiting-verify), authoritatively validated server-side. Use 'awaiting-verify' to park the lane at the visual merge-gate after firing cyboflow_request_verification — the verifier drives the lane off it (PASS→integrated, FAIL→implement loopback).",
            },
            attempt: {
              type: 'number',
              description: '1-based attempt counter; report when re-delegating implement after a verify failure',
            },
          },
          required: ['task_id'],
        },
      },
      {
        name: 'cyboflow_create_sprint_batch',
        description:
          "Materialize the approved task plan into a sprint batch for THIS run, stamping the run's batch_id MID-RUN (the 'ship' workflow handoff seam: planner decomposition → sprint execution in one continuous run). Run-bound (no run argument — derived from CYBOFLOW_RUN_ID). Pass task_ids to materialize the human-approved subset from the approve-plan gate; omit it to materialize ALL tasks this run created. IDEMPOTENT: if the batch already exists this returns created:false without re-minting. Each id is intersected with the tasks this run actually created; unknown ids are dropped. After this succeeds, cyboflow_update_sprint_task lane writes work and the swimlane canvas appears. Errors: ship_no_tasks_to_materialize (nothing to batch), ship_batch_too_large (subset exceeds the substrate cap).",
        inputSchema: {
          type: 'object',
          properties: {
            task_ids: {
              type: 'array',
              description:
                'Optional human-approved task id subset to materialize (the approve-plan selection). Omit to materialize ALL tasks this run created.',
              items: { type: 'string' },
            },
          },
          required: [],
        },
      },
      {
        name: 'cyboflow_report_finding',
        description:
          'Report a NON-BLOCKING observation, decision, or human action item into THIS project\'s unified review queue (the human-attention inbox). The item is run-bound (no project argument — the project is derived from CYBOFLOW_RUN_ID), routes through the single review-item chokepoint, and surfaces in the review queue. By default findings are NON-BLOCKING (the run is never paused, status is unchanged, the user is not interrupted). For kind:\'finding\', set blocking:true ONLY for a defect that no retry or loopback in the current step chain will fix — e.g. a lane that has exhausted its attempt budget, or a hazard in shared state that must stop the run now. If the step you are on has a loopback that will address the issue (a code-review ## Blocking defect, a failing test, a task-verify FAIL), the loopback IS the response — do NOT also file a finding; a blocking one would park the run and hand a human a defect the chain is about to fix itself. Blocking kind:\'decision\' gates (planner/ship guards, eval verdicts) are unaffected by this guidance. This is OBSERVATIONAL — contrast with the PreToolUse approval gate.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short headline for the item (required)' },
            body: { type: 'string', description: 'Markdown detail / context for the item (required)' },
            severity: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Optional severity; only meaningful for findings' },
            kind: { type: 'string', enum: ['finding', 'decision', 'human_task'], description: "Optional item kind; defaults to 'finding'" },
            blocking: { type: 'boolean', description: 'Optional — whether this item gates run resume; defaults to false (non-blocking)' },
            entity_type: { type: 'string', enum: ['idea', 'epic', 'task'], description: 'Optional soft entity link type (must be paired with entity_id)' },
            entity_id: { type: 'string', description: 'Optional soft entity link id (must be paired with entity_type)' },
            category: { type: 'string', description: "Optional FREE-TEXT finding category for review-queue grouping (e.g. 'security', 'perf', 'post-merge-bug'). Unrelated to the entity classification enum (feature|bug|chore) on cyboflow_create_task/cyboflow_update_task." },
            locations: {
              type: 'array',
              description: 'Optional file:line locations the finding refers to',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path (required within a location)' },
                  line: { type: 'number', description: 'Optional 1-based line number' },
                },
                required: ['path'],
              },
            },
            suggested_fix: { type: 'string', description: 'Optional prose suggesting how to fix the finding' },
            proposed_target: { type: 'string', enum: ['backlog', 'docs', 'prompt', 'fix'], description: 'Optional hint for where accepting the finding should land: backlog = promote to task, docs = a docs/ edit, prompt = a workflow-prompt/CLAUDE.md edit, fix = a quick fix applied in-place' },
            impact: {
              type: 'object',
              description: 'Optional verification impact (all members optional)',
              properties: {
                ran_count: { type: 'number', description: 'How many times a regression-guard ran' },
                caught_regressions: { type: 'number', description: 'How many regressions it caught' },
                token_delta: { type: 'number', description: 'Token delta attributable to the finding' },
                note: { type: 'string', description: 'Free-text impact note' },
              },
            },
            payload_json: { type: 'string', description: 'Optional per-kind payload JSON; its discriminant must equal kind' },
          },
          required: ['title', 'body'],
        },
      },
      {
        name: 'cyboflow_get_selected_findings',
        description:
          'Return the findings the human selected to compound for THIS run; read-only; bound from CYBOFLOW_RUN_ID.',
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'cyboflow_list_run_findings',
        description:
          "Return the still-open findings THIS run filed itself, each with the review_items.id cyboflow_resolve_finding needs; read-only; bound from CYBOFLOW_RUN_ID (no arguments). This is how a run acts on its OWN findings instead of deferring all of them: cyboflow_report_finding is fire-and-forget and never returns the minted id, so the ids only exist here. The set spans the WHOLE run (every task lane's code review plus the sprint-wide review), oldest first, and each row carries { id, title, body, severity, priority, source, category, blocking, proposedTarget, suggestedFix, locations }. Returns ONLY findings an agent reported (source 'agent:<label>'): anything already resolved or dismissed is excluded (so a re-entered step never re-triages its own disposals), as is everything system-minted — the orchestrator's machine-audience mailbox AND the visual merge-gate's own verdict findings (loopback records answered by the loopback, and low-confidence/timeout warnings about RENDERED output that no source-code read can refute). Mid-run only: a terminal run is rejected with run_not_active. Distinct from cyboflow_get_selected_findings, which returns the findings a HUMAN seeded into a Compound run.",
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'cyboflow_resolve_finding',
        description:
          'Resolve a finding the run consumed; records the correct resolution prefix; routes through the review-item chokepoint. Call this immediately after each finding\'s action lands — resolves are rejected once the run reaches a terminal status.',
        inputSchema: {
          type: 'object',
          properties: {
            review_item_id: { type: 'string', description: 'The review_items.id of the finding to resolve (required)' },
            resolution_kind: {
              type: 'string',
              enum: ['fixed', 'triaged', 'promoted'],
              description: "How the finding was resolved: fixed = quick fix applied in-place, triaged = reviewed/dispositioned (e.g. a docs edit), promoted = minted a backlog task (pair with task_id)",
            },
            note: { type: 'string', description: 'Optional free-text note appended to the resolution (e.g. compound)' },
            task_id: { type: 'string', description: 'Optional minted task id; recorded when resolution_kind=promoted' },
          },
          required: ['review_item_id', 'resolution_kind'],
        },
      },
      {
        name: 'cyboflow_report_artifact',
        description:
          'Create or update a run deliverable ("artifact") for THIS run — e.g. a static UI-prototype mockup, a captured screenshot gallery, a generated report, or a custom canvas. The artifact appears as its own tab in the center pane and in the right-rail Artifacts panel. The run is derived from CYBOFLOW_RUN_ID (no run argument). There is one artifact per atype per run: calling again with the same atype ENRICHES the existing one (and returns the same id). The templated deliverables idea-spec, decomposed-stories, arch-design, approve-ideas and approve-designs are auto-created by the orchestrator (arch-design/approve-designs derive from the ideas’ "## Architecture design" sections; approve-ideas/approve-designs render the batch’s idea rows — you do NOT report these gate/spec surfaces, you open their gate via cyboflow_report_finding instead); screenshots, ui-prototype, and generic are reported BY YOU with this tool. For ui-prototype, first write a self-contained static index.html (inline CSS only, no <script>/JS, no dev server) to $CYBOFLOW_RUN_ARTIFACTS_DIR/prototype/index.html and pass payload_json.fileName — an inline "html" key is rejected. For screenshots, first write the PNG bytes into the run artifacts dir ($CYBOFLOW_RUN_ARTIFACTS_DIR) and pass their BASENAMES in payload_json.fileNames. Returns { artifactId }.',
        inputSchema: {
          type: 'object',
          properties: {
            atype: {
              type: 'string',
              // DERIVED from the artifact-policy registry (reportable atypes) —
              // 'arch-design'/'approve-designs' are absent because they are
              // auto-mint-only (reportable:false). See the validAtypes comment in
              // the CallTool handler below.
              enum: REPORTABLE_ARTIFACT_ATYPES,
              description: 'Artifact type (required). ui-prototype renders a static HTML+CSS mockup in a sandboxed frame from a file you already wrote (no dev server, no JS; inline html is rejected); interactive-prototype is the JS-enabled design-mode canvas (same on-disk file contract; scripts run, network egress still blocked); generic renders an embedded live canvas from a {url}; screenshots renders an on-disk PNG gallery (you write the files + report their basenames); compound-recommendations renders a markdown doc from payload_json.markdown (the Compound flow’s summary-of-recommendations); verify-runbook renders the same way for the verify-setup flow’s runbook proposal (the surface its approve-runbook gate reviews, enriched in place with the proof outcomes); project-brief renders a markdown doc from payload_json.markdown — the Launch flow’s project brief; approve-ideas / approve-designs are the per-idea Approve/Deny gate surfaces (auto-created — open the gate via cyboflow_report_finding); idea-spec / decomposed-stories / arch-design are the auto-created templates.',
            },
            label: { type: 'string', description: 'Short tab/card label for the artifact (required)' },
            payload_json: {
              type: 'string',
              description: 'Optional JSON payload. For ui-prototype: {"fileName":"prototype/index.html"} pointing at the static HTML+CSS mockup you already wrote under $CYBOFLOW_RUN_ARTIFACTS_DIR (a top-level "html" key is rejected — write the file, don\'t inline it). For generic: {"url":"http://localhost:8081"}. For screenshots: {"fileNames":["home.png","detail.png"]} (BASENAMES of PNGs you wrote under $CYBOFLOW_RUN_ARTIFACTS_DIR).',
            },
          },
          required: ['atype', 'label'],
        },
      },
      {
        name: 'cyboflow_commit_artifact',
        description:
          'Persist a run artifact into the repo so it survives session close (session-only artifacts are otherwise dropped when the run closes). The run is derived from CYBOFLOW_RUN_ID. Pass the artifact_id returned by cyboflow_report_artifact. Returns { artifactId }.',
        inputSchema: {
          type: 'object',
          properties: {
            artifact_id: { type: 'string', description: 'The artifact id to commit (from cyboflow_report_artifact)' },
            payload_json: { type: 'string', description: 'Optional final payload JSON to store alongside the commit' },
          },
          required: ['artifact_id'],
        },
      },
      {
        name: 'cyboflow_request_verification',
        description:
          'Request a visual verification of a rendered deliverable for THIS run (derived from CYBOFLOW_RUN_ID — no run argument). FIRE-AND-CONTINUE: this returns { requestId, type, snapshotSha, dirtyWorktree } IMMEDIATELY and the lane NEVER blocks on the verdict — the main-process scheduler deploys the verification agent and delivers the verdict asynchronously (to the screenshots artifact + the review queue). The PREFERRED form is `task`: a composed verification task (the `## Visual verification task` fence object task-verify emits — version/summary/build/serve/target/behaviors, matching VerificationTaskV1) that the agent independently builds, drives, and judges. `intent` + `url`/`html_path` remain the LEGACY degenerate form (a bare acceptance sentence and a pre-live target, no build/behaviors) — still accepted for backward compatibility and simple checks. When the request is not enqueued this is a no-op that returns { skipped: true, reason } (never an error). RELAY `reason` VERBATIM and NEVER INFER A CAUSE IT DOES NOT STATE: several unrelated conditions skip a request — the master switch being off, an immutable run stamp, no proven runbook, a capability suppression — they have different fixes, and a guess reads to the user as a diagnosis. `type_override` can only NARROW within the run\'s resolved capability — it cannot enable a disabled run or add a backend the host lacks. QUICK CHAT SESSIONS may fire this too, not just sprint/ship flow lanes — it returns immediately and the chat continues; cyboflow_await_verification is the opt-in in-turn wait, cyboflow_get_verifications is the later-turn cold read once the request_id is gone. COST: firing this spends real per-project verification budget and deploys an SDK agent that runs the project\'s build/serve commands in an isolated snapshot worktree — treat it as a costly action, not a free read. DIRTY-TREE CONTRACT (load-bearing): the verification runs against a DETACHED checkout at `snapshotSha`, so UNCOMMITTED WORK IS INVISIBLE to it — prefer committing before verifying. When `dirtyWorktree` is true you MUST state both the verified sha and the dirty flag alongside ANY verdict you relay: a PASS on a dirty tree certifies the commit, not what the user is looking at, and must never be reported as unqualified. When — and only when — the returned `reason` is "no proven verification runbook for this project (run verification setup)", that is ACTIONABLE rather than a dead end: offer to run the verify-setup flow. Do not volunteer that diagnosis for any other reason string.',
        inputSchema: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              description:
                'Natural-language acceptance the verifier judges against, e.g. "the settings panel shows the new visual-verify toggle, default off" (required unless `task` is passed — a task-form call derives it from task.summary). LEGACY form when passed alone with `url`/`html_path`. When `task` is ALSO passed, `task` is authoritative for the deliverable/behaviors and `intent` may simply repeat task.summary.',
            },
            task: {
              type: 'object',
              description:
                'PREFERRED form: a composed VerificationTaskV1 object ({ version: 1, summary, build?, serve?, target?, behaviors, viewports?, timeoutMs?, taskRef? }) — the task-verify subagent\'s `## Visual verification task` fence, passed through verbatim. Validated strictly server-side; malformed shapes are rejected with an `invalid_verification_task` error naming the offending field. When present, `task` supersedes `url`/`html_path`/`viewports` for the persisted deliverable.',
            },
            type_override: {
              type: 'string',
              enum: [
                'static-render-snapshot',
                'interactive-web-behavior',
                'responsive-multi-viewport',
                'native-desktop',
                'mobile-flow',
              ],
              description:
                "Optional agent-declared verification type. NARROWS only — an override outside the run's resolved chain is dropped; it can never enable a disabled run.",
            },
            url: { type: 'string', description: 'Optional URL of the running deliverable to capture (e.g. http://localhost:5173).' },
            html_path: { type: 'string', description: 'Optional path to a static HTML file to render + capture.' },
            viewports: {
              type: 'array',
              description: 'Optional viewport list for responsive-multi-viewport captures.',
              items: {
                type: 'object',
                properties: {
                  width: { type: 'number', description: 'Viewport width in px (required within a viewport)' },
                  height: { type: 'number', description: 'Viewport height in px (required within a viewport)' },
                  label: { type: 'string', description: 'Optional viewport label (e.g. "mobile", "desktop")' },
                },
                required: ['width', 'height'],
              },
            },
            baseline_key: { type: 'string', description: 'Optional golden-baseline key to compare against (absent = intent-only judging).' },
            task_ref: {
              type: 'string',
              description:
                "Optional lane ref of the task this verification is for (e.g. \"TASK-008\"), used by the visual merge-gate to drive the async verdict onto the right lane. Pass YOUR task's ref in a multi-task sprint; omit for a single-task run.",
            },
            setup_proof: {
              type: 'boolean',
              description:
                "Optional — mark this request as the verify-setup flow's PROOF run rather than ordinary lane traffic. VERIFY-SETUP-FLOW-ONLY, SERVER-ENFORCED: the request is rejected with error 'setup_proof_not_authorized' unless it comes from a run whose FROZEN workflow identity is 'verify-setup' — no other flow (sprint/ship/compound) can claim this, whatever it passes. It also requires a valid pin (see runbook_hash) or is rejected with 'setup_proof_requires_pin'; an unpinned setup-proof request is pure budget/gate bypass with no offsetting proof, so it is never allowed through. Authorized, a setup-proof run is EXEMPT from the project's lifetime verification budget (and never counted against it), drains at LOWER priority than live sprint lanes (promoted after 5 minutes so it cannot starve), may execute an UNPROVEN runbook draft (being unproven is exactly what it is trying to fix — gating it would deadlock the bootstrap), and, when it PASSES while pinned, causes the ENGINE to mark that runbook revision proven. You never mark a runbook proven yourself. Defaults to false.",
            },
            runbook_hash: {
              type: 'string',
              description:
                'Optional — the portable-runbook content hash returned by cyboflow_register_verify_runbook. Pin the revision this request must execute (verify-setup flow, paired with setup_proof + runbook_local_version). MEANINGFUL ONLY INSIDE THE SETUP-PROOF ENVELOPE: without setup_proof:true this field is IGNORED — the server drops it before enqueue and the engine resolves and pins the project\'s PROVEN revision itself, so you can neither redirect an ordinary request onto another revision nor suppress the injection by pinning a hash. REQUIRED when setup_proof is true: the hash must resolve to a draft this project actually registered (via cyboflow_register_verify_runbook) or the request is rejected with \'setup_proof_requires_pin\' — see setup_proof.',
            },
            runbook_local_version: {
              type: 'number',
              description:
                'Optional — the machine-local record CAS version returned alongside runbook_hash. Must be passed WITH runbook_hash (half a pin is ignored): together they let the runner execute exactly that revision or reject with a structured mismatch instead of improvising. IGNORED without setup_proof:true, exactly like runbook_hash — an ordinary request carries no caller-supplied pin at all. REQUIRED when setup_proof is true — see setup_proof.',
            },
          },
          // `intent` is required for the legacy form only — a `task`-form call
          // derives it from task.summary, so neither field is schema-required.
          required: [],
        },
      },
      {
        name: 'cyboflow_run_eval',
        description:
          "Request an ad-hoc code-review eval of THIS session's current working-tree diff against its base. FIRE-AND-CONTINUE: returns { status, rubricVersion } immediately ('queued' | 'requeued' = replaced a prior ad-hoc verdict | 'in_flight' = one is already grading); a 3-slot jury (2×Claude + 1×Codex) grades asynchronously and the verdict lands as a non-blocking review-queue item. Errors: adhoc_eval_tagged_run_rejected (A/B-tagged runs auto-grade; ad-hoc would distort arm comparison), adhoc_eval_exists_auto (the run already has its canonical automatic eval), adhoc_eval_no_diff (no diff to grade), run_not_found. Explicit calls bypass the automatic-eval on/off settings.",
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'cyboflow_await_verification',
        description:
          "BLOCKS until a verification request you already enqueued reaches a verdict, then returns it inline: { status, failureClass, feedback, errorMessage }. Meaningful for the verify-setup flow, whose derive → prove-by-running → diagnose → re-prove loop needs each outcome inside the same turn; ordinary sprint lanes must NOT use it (they fire cyboflow_request_verification, park at awaiting-verify, and the merge gate drives the verdict onto the lane asynchronously). Run-bound: the request must belong to THIS run. `status` is one of passed | failed | low_confidence | skipped | timeout — or, if your wait budget expires first, the request's still-live status (queued/leased/running) with errorMessage 'await timeout', which means YOU stopped waiting, not that the request failed (it keeps running and still delivers its verdict to the artifacts + review queue). On a failure, `failureClass` is the harness's attribution — 'env' (an environment problem it PROVED: failed preflight, occupied port, lock contention), 'deliverable' (the commands genuinely do not stand the project up), or 'ambiguous' (no corroboration either way) — and is the thing to read before deciding what to change.",
        inputSchema: {
          type: 'object',
          properties: {
            request_id: {
              type: 'string',
              description: 'The verification request id cyboflow_request_verification returned (required).',
            },
            timeout_ms: {
              type: 'number',
              description:
                'Optional wait budget in milliseconds. Defaults to 15 minutes and is clamped to the 20-minute ceiling (the longest a verification request may itself run — waiting past it cannot surface a verdict that does not exist).',
            },
          },
          required: ['request_id'],
        },
      },
      {
        name: 'cyboflow_get_verifications',
        description:
          "Lists THIS run's verification requests and their outcomes, newest first — a NON-BLOCKING cold read, never a wait. Each row: id, status, verifyType, attempt, failureClass, feedback, errorMessage, enqueuedAt, endedAt, snapshotSha, screenshotFiles. WHY IT EXISTS: cyboflow_await_verification can only answer for a request_id you are still holding; after a context compaction those ids are gone, and this is how you find out what happened to verifications you already fired. `screenshotFiles` is PER-REQUEST and may be `null` — that means this engine persisted no exact per-request file list (the legacy capture path), NOT that no screenshots exist; distinguish it from `[]`, which means the agent ran and captured nothing. SCOPE CAVEAT: the scope is THIS run — in a quick chat session that means the session's own quick sentinel, so it will NOT list verifications fired by structured flow runs the session hosted, even though the artifacts pane does show those; reading an empty list as \"no verifications exist\" is a mistake without this caveat in mind. `snapshotSha` is what the verdict actually certifies — pair it with `dirtyWorktree` from the enqueue reply before relaying any verdict.",
        inputSchema: {
          type: 'object',
          properties: {
            request_id: {
              type: 'string',
              description: 'Optional verification request id to narrow the listing to a single row; omit to list every request for this run.',
            },
          },
          required: [],
        },
      },
      {
        name: 'cyboflow_register_verify_runbook',
        description:
          "Register (or refresh) the MACHINE-LOCAL half of THIS project's verification runbook and return { hash, version, committed, warning? } — the content-addressed hash of the committed portable half and the CAS version of the local record. Meaningful for the verify-setup flow. It reads `.cyboflow/verify-runbook.json` from THIS run's worktree itself (there is no content argument — COMMIT the file first, then register: the returned hash addresses what you actually committed, which is what a later request is pinned to). `committed: false` means the file is NOT present at HEAD, so the proof's detached snapshot will not contain it — the usual cause is a project that ignores or locally-excludes `.cyboflow/`, which makes a plain `git add` a silent no-op; re-add with `git add -f`, commit, and register again. Registering always produces an 'unproven-draft': new content is by definition unproven, and only a PASSING setup_proof verification promotes it. Re-register after every edit — the hash changes, so the old record no longer describes what you are proving. Errors come back verbatim and name the offending file or key (e.g. \"portable runbook is not valid JSON: …\", \"portable runbook declares no \\\"cdp-app\\\" modality\") so you can fix the file and retry.",
        inputSchema: {
          type: 'object',
          properties: {
            modality: {
              type: 'string',
              enum: ['web', 'cdp-app', 'native-screen'],
              description:
                "Which modality's record to register; the portable runbook must declare an entry for it. 'mobile' is not registrable — it is deferred (pending the Xcode MCP) and no execution path could satisfy it.",
            },
            bindings_json: {
              type: 'string',
              description:
                'Optional JSON object of HOST-STABLE resolved lever bindings — binary paths, the data-dir lever name, ABI facts. NEVER request-scoped values: ports and temp dirs are leased per request by the scheduler, and a persisted one would go stale or collide. Validated as parseable JSON.',
            },
          },
          required: ['modality'],
        },
      },
      // ---------------------------------------------------------------------
      // Workflow + variant configuration (edit flows / configure variants from
      // a quick session instead of the UI). WARNING: editing a BUILT-IN
      // workflow (planner/sprint/compound/ship) edits the single GLOBAL row
      // shared by every project. Custom flows and variants are safer to edit.
      // ---------------------------------------------------------------------
      {
        name: 'cyboflow_list_workflows',
        description:
          "List the workflows available in THIS run's project (the built-in launch/planner/sprint/compound/ship plus any custom flows), reconciling the in-repo built-ins first. Read-only, run-bound (no project argument). Returns COMPACT rows (id, name, scope global|project, is_built_in, permission_mode, has_custom_spec) WITHOUT the full step graph — use cyboflow_get_workflow to fetch one flow's definition. Call this first to discover workflow ids before editing.",
        inputSchema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'cyboflow_get_workflow',
        description:
          "Fetch ONE workflow's EFFECTIVE definition (the phase/step graph the editor seeds from — a saved spec_json wins, else the built-in fallback), plus its metadata and baseline rotation participation, by workflow id. Read-only. The returned `definition` is the exact shape cyboflow_update_workflow expects back (round-trippable): edit it and pass it as definition_json — including whichever of `providerModel`/`codexModel` it already carries; this call does NOT rewrite the persisted keys for you. Per-agent config lives in an optional `agentConfigs` overlay on the definition — `{ [agentKey]: { model?, runtime?, providerModel?, effort? } }`, keyed by a step's `agent` value — which pins a per-agent model, routes an agent onto a non-Claude provider (`runtime: 'codex-sdk'` + `providerModel` — the model id for that provider, e.g. a Codex model), or sets a per-agent reasoning `effort` (Claude `low..max` / Codex `none..xhigh`; a value outside the resolved provider's scale is dropped at spawn); it is absent on unedited built-ins. `codexModel` is a deprecated alias of `providerModel` still accepted on write (an explicit `providerModel` wins when both are set), for a definition an older writer already saved. NOT_FOUND (error 'not_found') when the id is unknown.",
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: { type: 'string', description: 'The workflow id (from cyboflow_list_workflows)' },
          },
          required: ['workflow_id'],
        },
      },
      {
        name: 'cyboflow_update_workflow',
        description:
          "Save an edited workflow definition onto a workflow's spec_json (the editor's \"Save\"). `definition_json` is a JSON-encoded WorkflowDefinition (get the current one from cyboflow_get_workflow, edit, pass it back) — it is re-validated by the same strict schema the UI uses (malformed → error 'invalid_definition'; bad JSON → 'invalid_json'). Per-agent model pins and non-Claude-provider routing live in the definition's optional `agentConfigs` overlay (`{ [agentKey]: { model?, runtime?, providerModel?, effort? } }`; the deprecated `codexModel` key is still accepted — `providerModel` wins when both are set). WARNING: editing a global built-in changes it for EVERY project. Unknown id → error 'not_found'.",
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: { type: 'string', description: 'The workflow id to update (required)' },
            definition_json: {
              type: 'string',
              description: 'JSON-encoded WorkflowDefinition — the full edited graph (required)',
            },
          },
          required: ['workflow_id', 'definition_json'],
        },
      },
      {
        name: 'cyboflow_reset_workflow',
        description:
          "Reset a BUILT-IN workflow's spec back to its static in-repo default (the editor's \"Reset to default\"), discarding any saved edits. Only valid for a built-in flow — resetting a custom flow is rejected (error 'not_a_builtin'). Unknown id → 'not_found'. WARNING: resets the global built-in for every project.",
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: { type: 'string', description: 'The built-in workflow id to reset (required)' },
          },
          required: ['workflow_id'],
        },
      },
      {
        name: 'cyboflow_create_workflow',
        description:
          "Create a brand-new CUSTOM workflow (\"Save as new flow\"). `name` must not collide with a built-in or an existing flow (collision → error 'already_exists'; a reserved name → 'reserved'). `definition_json` (optional JSON-encoded WorkflowDefinition, validated like update) seeds the graph — omit to start empty. `scope` = 'global' (default; shared across every project) or 'project' (this run's project only).",
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Unique workflow name (required)' },
            definition_json: {
              type: 'string',
              description: 'Optional JSON-encoded WorkflowDefinition to seed the flow; omit for an empty flow.',
            },
            permission_mode: {
              type: 'string',
              enum: ['default', 'acceptEdits', 'auto', 'dontAsk'],
              description: "Optional default permission mode; defaults to 'default'.",
            },
            scope: {
              type: 'string',
              enum: ['global', 'project'],
              description: "Optional scope; 'global' (default) shares the flow across projects, 'project' pins it to this run's project.",
            },
          },
          required: ['name'],
        },
      },
      {
        name: 'cyboflow_delete_workflow',
        description:
          "Delete a workflow. Refused for reserved global built-ins (error 'reserved') and for any flow that has run history (error 'run_history' — retire/keep it instead, since deleting would cascade its run + Insights history). Unknown id → 'not_found'. Safe for custom flows with no runs.",
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: { type: 'string', description: 'The workflow id to delete (required)' },
          },
          required: ['workflow_id'],
        },
      },
      {
        name: 'cyboflow_list_variants',
        description:
          "List a workflow's A/B variants (newest-first). Read-only. Returns COMPACT rows (id, label, model, execution_model, weight, status draft|active|paused|retired, has_agent_overrides). NOTE: `has_agent_overrides` reflects only the `agent_overrides_json` blob (Claude prompt/model tweaks); a variant can still carry per-agent model pins or Codex routing via its `definition_json` `agentConfigs` and show `has_agent_overrides: false` — fetch the variant's definition to see those. ARCHIVED variants (migration 116) are OMITTED — an archived variant still exists, still holds its status and run history, and is still pinnable by id; it is just hidden from this listing, so an empty result is not proof the workflow has no variants. Use before creating/editing variants to see what already exists.",
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: { type: 'string', description: 'The parent workflow id (required)' },
          },
          required: ['workflow_id'],
        },
      },
      {
        name: 'cyboflow_create_variant',
        description:
          "Create a new variant of a workflow, snapshotting its CURRENT resolved definition, seeded status='draft' (opt into rotation later via cyboflow_set_variant_status / cyboflow_update_variant weight). `label` must be unique within the workflow (collision → error 'already_exists'). Unknown workflow → 'not_found'.",
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: { type: 'string', description: 'The parent workflow id (required)' },
            label: { type: 'string', description: 'Unique variant label within the workflow (required)' },
          },
          required: ['workflow_id', 'label'],
        },
      },
      {
        name: 'cyboflow_update_variant',
        description:
          "Patch a variant in place. All fields optional: `definition_json` (JSON-encoded WorkflowDefinition, re-snapshots + validated like update_workflow), `agent_overrides_json` (a JSON string of `{ [agentKey]: { systemPrompt?, model? } }`, or null to clear), `model` (alias or null), `execution_model` ('orchestrated'|'programmatic'|null), `weight` (non-negative integer rotation share), `label`. Past runs are unaffected. Unknown id → 'not_found'. PER-AGENT NON-CLAUDE-PROVIDER ROUTING does NOT go in `agent_overrides_json` (that carries Claude prompt/model-alias tweaks only) — to run specific agents on Codex (or a future non-Claude provider), put an `agentConfigs` overlay in `definition_json`: `{ ..., \"agentConfigs\": { \"<agentKey>\": { \"runtime\": \"codex-sdk\", \"providerModel\": \"<that provider's model id>\" } } }`, where agentKey = the step's `agent` value (e.g. implement / write-tests / code-review). The deprecated `codexModel` key is still accepted in place of `providerModel`. A mixed Claude+Codex flow only routes those Codex steps under `execution_model: 'programmatic'` — set it too. There is no per-agent reasoning-effort field; Codex agents inherit the Codex CLI default effort.",
        inputSchema: {
          type: 'object',
          properties: {
            variant_id: { type: 'string', description: 'The variant id to update (required)' },
            definition_json: {
              type: 'string',
              description:
                "Optional JSON-encoded WorkflowDefinition to re-snapshot. This is where per-agent config lives: an `agentConfigs` overlay `{ [agentKey]: { model?, runtime?, providerModel?, effort? } }` pins a Claude model per agent OR routes an agent onto a non-Claude provider (`runtime: 'codex-sdk'` + `providerModel` — the deprecated `codexModel` key is still accepted). Get the current definition from cyboflow_get_workflow, add/edit `agentConfigs`, pass it back.",
            },
            agent_overrides_json: {
              type: ['string', 'null'],
              description: 'Optional JSON string of per-agent CLAUDE overrides `{ [agentKey]: { systemPrompt?, model? } }` (custom prompt + Claude model alias only — NOT Codex runtime/model, which go in definition_json agentConfigs); pass null to clear.',
            },
            model: { type: ['string', 'null'], description: 'Optional per-variant model alias; null clears it.' },
            execution_model: {
              type: ['string', 'null'],
              enum: ['orchestrated', 'programmatic', null],
              description: 'Optional per-variant execution model; null clears it.',
            },
            weight: { type: 'number', description: 'Optional rotation weight (non-negative integer).' },
            label: { type: 'string', description: 'Optional new label (must stay unique within the workflow).' },
          },
          required: ['variant_id'],
        },
      },
      {
        name: 'cyboflow_set_variant_status',
        description:
          "Transition a variant's rotation status: 'draft' (pinnable/experiment-usable, never auto-rotated), 'active' (competes in the randomized rotation), 'paused' (temporarily out), 'retired' (permanently out but stats stay resolvable). Unknown id → 'not_found'.",
        inputSchema: {
          type: 'object',
          properties: {
            variant_id: { type: 'string', description: 'The variant id (required)' },
            status: {
              type: 'string',
              enum: ['draft', 'active', 'paused', 'retired'],
              description: 'The target rotation status (required)',
            },
          },
          required: ['variant_id', 'status'],
        },
      },
      {
        name: 'cyboflow_delete_variant',
        description:
          "Delete a variant. Refused (error 'run_history') when any run references it — retire it via cyboflow_set_variant_status instead so per-variant stats stay resolvable. Unknown id → 'not_found'. Safe for a variant with no runs.",
        inputSchema: {
          type: 'object',
          properties: {
            variant_id: { type: 'string', description: 'The variant id to delete (required)' },
          },
          required: ['variant_id'],
        },
      },
      {
        name: 'cyboflow_set_baseline_rotation',
        description:
          "Configure a workflow's BASELINE (its live definition) participation in the A/B rotation: `in_rotation` opts the baseline in/out, `weight` sets its rotation share (non-negative integer). When in rotation the baseline competes on equal footing with active variants. Returns the updated participation. Unknown workflow → 'not_found'.",
        inputSchema: {
          type: 'object',
          properties: {
            workflow_id: { type: 'string', description: 'The workflow id (required)' },
            in_rotation: { type: 'boolean', description: 'Optional — opt the baseline into/out of rotation.' },
            weight: { type: 'number', description: 'Optional baseline rotation weight (non-negative integer).' },
          },
          required: ['workflow_id'],
        },
      },
    ],
  };
});

async function executeMcpQuery(
  type: string,
  params: Record<string, unknown>,
  timeoutMs?: number | null,
): Promise<CallToolResult> {
  try {
    const queryPromise = sendQuery(type, params, timeoutMs);
    const response = await queryPromise;
    if (
      typeof response !== 'object' ||
      response === null ||
      !('ok' in response) ||
      typeof (response as { ok: unknown }).ok !== 'boolean'
    ) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_orchestrator_response' }) }] };
    }
    type OkResponse = { ok: boolean; data?: unknown; error?: string };
    const resp = response as OkResponse;
    if (!resp.ok) {
      const errorText = typeof resp.error === 'string' && resp.error.length > 0
        ? resp.error
        : 'orchestrator_error';
      return { content: [{ type: 'text', text: JSON.stringify({ error: errorText }) }] };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data) }] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
  }
}

/**
 * Uniform invalid-arguments CallToolResult. Used by the workflow/variant config
 * cases below to keep their arg-validation terse (the earlier cases inline the
 * same shape).
 */
function invalidArgs(expected: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected }) }] };
}

/**
 * IPC budget for the BLOCKING `cyboflow_await_verification` call
 * (docs/proposals/verification-setup-flow.md §5.2 seam 2). Deliberately larger
 * than the orchestrator handler's own 20-minute clamp: whichever side gives up
 * first owns the answer the agent sees, and the handler's answer ("still
 * queued/running — I stopped waiting") is diagnostic while this transport's
 * ('orchestrator_timeout') is not.
 */
const AWAIT_VERIFICATION_TRANSPORT_TIMEOUT_MS = 22 * 60_000;

function invalidQuestionArguments(): CallToolResult {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        error: 'invalid_arguments',
        expected: 'each question requires header, question, 2-4 valid options, and optional multi_select',
      }),
    }],
  };
}

// ---------------------------------------------------------------------------
// Global-agent CallTool dispatch (S0.4) — the ONLY tools reachable when
// IS_GLOBAL_AGENT_SCOPE is true. Snake_case wire args -> camelCase
// mcpQueryHandler params, same 4-layer pattern as the run-scoped cases below.
// ---------------------------------------------------------------------------
async function handleGlobalAgentCallTool(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}): Promise<CallToolResult> {
  switch (request.params.name) {
    case 'cyboflow_overview': {
      // No arguments — cross-project, run-unbound.
      return executeMcpQuery('mcp-overview', {});
    }

    case 'cyboflow_backlog': {
      const args = (request.params.arguments ?? {}) as {
        project_id?: unknown;
        task_type?: unknown;
        include_archived?: unknown;
        include_done?: unknown;
      };
      const { project_id, task_type, include_archived, include_done } = args;
      if (project_id !== undefined && typeof project_id !== 'number') {
        return invalidArgs('project_id: number (optional)');
      }
      if (task_type !== undefined && task_type !== 'idea' && task_type !== 'epic' && task_type !== 'task') {
        return invalidArgs("task_type: 'idea' | 'epic' | 'task' (optional)");
      }
      if (include_archived !== undefined && typeof include_archived !== 'boolean') {
        return invalidArgs('include_archived: boolean (optional)');
      }
      if (include_done !== undefined && typeof include_done !== 'boolean') {
        return invalidArgs('include_done: boolean (optional)');
      }
      const queryParams: Record<string, unknown> = {};
      if (project_id !== undefined) queryParams['projectId'] = project_id;
      if (task_type !== undefined) queryParams['taskType'] = task_type;
      if (include_archived !== undefined) queryParams['includeArchived'] = include_archived;
      if (include_done !== undefined) queryParams['includeDone'] = include_done;
      return executeMcpQuery('mcp-backlog', queryParams);
    }

    case 'cyboflow_entity': {
      const args = (request.params.arguments ?? {}) as { task_id?: unknown; project_id?: unknown };
      const { task_id, project_id } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return invalidArgs('task_id: string');
      }
      if (project_id !== undefined && typeof project_id !== 'number') {
        return invalidArgs('project_id: number (optional)');
      }
      const queryParams: Record<string, unknown> = { taskId: task_id };
      if (project_id !== undefined) queryParams['projectId'] = project_id;
      return executeMcpQuery('mcp-entity', queryParams);
    }

    case 'cyboflow_queue': {
      const args = (request.params.arguments ?? {}) as { project_id?: unknown; include_resolved?: unknown };
      const { project_id, include_resolved } = args;
      if (project_id !== undefined && typeof project_id !== 'number') {
        return invalidArgs('project_id: number (optional)');
      }
      if (include_resolved !== undefined && typeof include_resolved !== 'boolean') {
        return invalidArgs('include_resolved: boolean (optional)');
      }
      const queryParams: Record<string, unknown> = {};
      if (project_id !== undefined) queryParams['projectId'] = project_id;
      if (include_resolved !== undefined) queryParams['includeResolved'] = include_resolved;
      return executeMcpQuery('mcp-queue', queryParams);
    }

    case 'cyboflow_workflows': {
      const args = (request.params.arguments ?? {}) as { project_id?: unknown };
      const { project_id } = args;
      if (project_id !== undefined && typeof project_id !== 'number') {
        return invalidArgs('project_id: number (optional)');
      }
      const queryParams: Record<string, unknown> = {};
      if (project_id !== undefined) queryParams['projectId'] = project_id;
      return executeMcpQuery('mcp-workflows', queryParams);
    }

    case 'cyboflow_workflow': {
      const args = (request.params.arguments ?? {}) as { workflow_id?: unknown };
      const { workflow_id } = args;
      if (typeof workflow_id !== 'string' || workflow_id.length === 0) {
        return invalidArgs('workflow_id: string');
      }
      return executeMcpQuery('mcp-workflow', { workflowId: workflow_id });
    }

    case 'cyboflow_db_query': {
      const args = (request.params.arguments ?? {}) as { sql?: unknown };
      const { sql } = args;
      if (typeof sql !== 'string' || sql.length === 0) {
        return invalidArgs('sql: string (a single read-only SELECT/WITH/EXPLAIN statement)');
      }
      return executeMcpQuery('mcp-db-query', { sql });
    }

    case 'cyboflow_reference': {
      // Static, curated product reference — served DIRECTLY from the imported
      // content module. Unlike every other global-agent tool it does NOT
      // round-trip through executeMcpQuery / the orchestrator socket: the
      // content is compiled into this process, so there is nothing to fetch.
      const args = (request.params.arguments ?? {}) as { topic?: unknown };
      const { topic } = args;
      if (topic !== undefined && typeof topic !== 'string') {
        return invalidArgs('topic: string (optional kebab-case topic key)');
      }
      const validKeys = Object.keys(ASSISTANT_REFERENCE);
      if (topic === undefined || topic.length === 0) {
        // No topic → table of contents (key + title + one-liner per topic).
        const toc = validKeys.map((key) => ({
          topic: key,
          title: ASSISTANT_REFERENCE[key].title,
          oneLiner: ASSISTANT_REFERENCE[key].oneLiner,
        }));
        return { content: [{ type: 'text', text: JSON.stringify({ topics: toc }) }] };
      }
      const entry = ASSISTANT_REFERENCE[topic];
      if (!entry) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_topic', validTopics: validKeys }) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ topic, title: entry.title, body: entry.body }) }] };
    }

    case 'cyboflow_fs_read': {
      const args = (request.params.arguments ?? {}) as { path?: unknown; offset_line?: unknown; limit_lines?: unknown };
      const { path: fsPath, offset_line, limit_lines } = args;
      if (typeof fsPath !== 'string' || fsPath.length === 0) {
        return invalidArgs('path: string');
      }
      if (offset_line !== undefined && typeof offset_line !== 'number') {
        return invalidArgs('offset_line: number (optional)');
      }
      if (limit_lines !== undefined && typeof limit_lines !== 'number') {
        return invalidArgs('limit_lines: number (optional)');
      }
      const queryParams: Record<string, unknown> = { path: fsPath };
      if (offset_line !== undefined) queryParams['offsetLine'] = offset_line;
      if (limit_lines !== undefined) queryParams['limitLines'] = limit_lines;
      return executeMcpQuery('mcp-fs-read', queryParams);
    }

    case 'cyboflow_fs_list': {
      const args = (request.params.arguments ?? {}) as { path?: unknown };
      const { path: fsPath } = args;
      if (typeof fsPath !== 'string' || fsPath.length === 0) {
        return invalidArgs('path: string');
      }
      return executeMcpQuery('mcp-fs-list', { path: fsPath });
    }

    case 'cyboflow_fs_grep': {
      const args = (request.params.arguments ?? {}) as {
        pattern?: unknown;
        path?: unknown;
        glob?: unknown;
        case_sensitive?: unknown;
        max_results?: unknown;
      };
      const { pattern, path: fsPath, glob, case_sensitive, max_results } = args;
      if (typeof pattern !== 'string' || pattern.length === 0) {
        return invalidArgs('pattern: string');
      }
      if (typeof fsPath !== 'string' || fsPath.length === 0) {
        return invalidArgs('path: string');
      }
      if (glob !== undefined && typeof glob !== 'string') {
        return invalidArgs('glob: string (optional)');
      }
      if (case_sensitive !== undefined && typeof case_sensitive !== 'boolean') {
        return invalidArgs('case_sensitive: boolean (optional)');
      }
      if (max_results !== undefined && typeof max_results !== 'number') {
        return invalidArgs('max_results: number (optional)');
      }
      const queryParams: Record<string, unknown> = { pattern, path: fsPath };
      if (glob !== undefined) queryParams['glob'] = glob;
      if (case_sensitive !== undefined) queryParams['caseSensitive'] = case_sensitive;
      if (max_results !== undefined) queryParams['maxResults'] = max_results;
      return executeMcpQuery('mcp-fs-grep', queryParams);
    }

    case 'cyboflow_history': {
      const args = (request.params.arguments ?? {}) as {
        query?: unknown;
        role?: unknown;
        days_back?: unknown;
        before_id?: unknown;
        limit?: unknown;
      };
      const { query, role, days_back, before_id, limit } = args;
      if (query !== undefined && typeof query !== 'string') {
        return invalidArgs('query: string (optional case-insensitive plain-text substring)');
      }
      if (role !== undefined && role !== 'user' && role !== 'assistant') {
        return invalidArgs("role: 'user' | 'assistant' (optional)");
      }
      if (days_back !== undefined && typeof days_back !== 'number') {
        return invalidArgs('days_back: number (optional)');
      }
      if (before_id !== undefined && typeof before_id !== 'number') {
        return invalidArgs('before_id: number (optional)');
      }
      if (limit !== undefined && typeof limit !== 'number') {
        return invalidArgs('limit: number (optional)');
      }
      const queryParams: Record<string, unknown> = {};
      if (query !== undefined) queryParams['query'] = query;
      if (role !== undefined) queryParams['role'] = role;
      if (days_back !== undefined) queryParams['daysBack'] = days_back;
      if (before_id !== undefined) queryParams['beforeId'] = before_id;
      if (limit !== undefined) queryParams['limit'] = limit;
      return executeMcpQuery('mcp-history', queryParams);
    }

    case 'cyboflow_propose_action': {
      const args = (request.params.arguments ?? {}) as { payload_json?: unknown };
      const { payload_json } = args;
      if (typeof payload_json !== 'string' || payload_json.length === 0) {
        return invalidArgs('payload_json: string (JSON-encoded AgentProposalPayload)');
      }
      return executeMcpQuery('mcp-propose-action', { payloadJson: payload_json });
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
}

// ---------------------------------------------------------------------------
// Design-scope CallTool dispatch (Design Mode v0) — the ONLY tools reachable
// when IS_DESIGN_SCOPE is true. A run-scoped OR global-agent tool name falls
// through to the default 'Unknown tool' throw (design-mode.md: rejected on
// direct invocation, not merely unlisted). report_artifact is the same
// mcp-report-artifact path as run scope, but its atype is validated to be
// EXACTLY 'ui-prototype' here BEFORE forwarding.
// ---------------------------------------------------------------------------
async function handleDesignScopeCallTool(request: {
  params: { name: string; arguments?: Record<string, unknown> };
}): Promise<CallToolResult> {
  switch (request.params.name) {
    case 'cyboflow_design_get_idea': {
      // No arguments — the idea is resolved server-side from the session link.
      return executeMcpQuery('mcp-design-get-idea', {});
    }

    case 'cyboflow_design_update_draft': {
      const args = (request.params.arguments ?? {}) as { spec_markdown?: unknown };
      const { spec_markdown } = args;
      if (typeof spec_markdown !== 'string' || spec_markdown.length === 0) {
        return invalidArgs('spec_markdown: string');
      }
      return executeMcpQuery('mcp-design-update-draft', { specMarkdown: spec_markdown });
    }

    case 'cyboflow_design_ack_feedback': {
      const args = (request.params.arguments ?? {}) as {
        batch_id?: unknown;
        attempt_id?: unknown;
        prototype_revision?: unknown;
      };
      const { batch_id, attempt_id, prototype_revision } = args;
      if (typeof batch_id !== 'string' || batch_id.length === 0) {
        return invalidArgs('batch_id: string');
      }
      if (typeof attempt_id !== 'string' || attempt_id.length === 0) {
        return invalidArgs('attempt_id: string');
      }
      if (typeof prototype_revision !== 'number' || !Number.isInteger(prototype_revision)) {
        return invalidArgs('prototype_revision: integer');
      }
      return executeMcpQuery('mcp-design-ack-feedback', {
        batchId: batch_id,
        attemptId: attempt_id,
        prototypeRevision: prototype_revision,
      });
    }

    case 'cyboflow_report_artifact': {
      const args = (request.params.arguments ?? {}) as {
        atype?: unknown;
        label?: unknown;
        payload_json?: unknown;
      };
      const { atype, label, payload_json } = args;
      // Design scope reports a prototype ONLY — ui-prototype (static) or
      // interactive-prototype (JS canvas). Reject any other atype BEFORE
      // forwarding to the shared mcp-report-artifact path.
      if (atype !== 'ui-prototype' && atype !== 'interactive-prototype') {
        return invalidArgs(
          "atype: ui-prototype | interactive-prototype (design sessions report only a prototype)",
        );
      }
      if (typeof label !== 'string' || label.length === 0) {
        return invalidArgs('label: string');
      }
      if (payload_json !== undefined && typeof payload_json !== 'string') {
        return invalidArgs('payload_json: string (optional)');
      }
      const queryParams: Record<string, unknown> = { atype, label };
      if (payload_json !== undefined) queryParams['payloadJson'] = payload_json;
      return executeMcpQuery('mcp-report-artifact', queryParams);
    }

    case 'cyboflow_create_task': {
      const args = (request.params.arguments ?? {}) as {
        title?: unknown;
        body?: unknown;
        priority?: unknown;
      };
      const { title, body, priority } = args;
      if (typeof title !== 'string' || title.length === 0) {
        return invalidArgs('title: string');
      }
      if (body !== undefined && typeof body !== 'string') {
        return invalidArgs('body: string (optional)');
      }
      if (
        priority !== undefined &&
        priority !== 'P0' &&
        priority !== 'P1' &&
        priority !== 'P2' &&
        priority !== 'P3' &&
        priority !== 'P4' &&
        priority !== 'P5' &&
        priority !== 'P6'
      ) {
        return invalidArgs("priority: 'P0'..'P6' (optional)");
      }
      // Design scope mints follow-up TASKS only — taskType/category are pinned
      // server-side here, never taken from the caller.
      const queryParams: Record<string, unknown> = { title, taskType: 'task', category: 'chore' };
      if (body !== undefined) queryParams['body'] = body;
      if (priority !== undefined) queryParams['priority'] = priority;
      return executeMcpQuery('mcp-create-task', queryParams);
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (IS_DESIGN_SCOPE) {
    return handleDesignScopeCallTool(request);
  }
  if (IS_GLOBAL_AGENT_SCOPE) {
    return handleGlobalAgentCallTool(request);
  }
  switch (request.params.name) {
    case 'cyboflow_list_pending_approvals': {
      return executeMcpQuery('mcp-list-pending-approvals', {});
    }

    case 'cyboflow_get_run': {
      const args = (request.params.arguments ?? {}) as { run_id?: unknown };
      const { run_id } = args;
      if (typeof run_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'run_id: string' }),
            },
          ],
        };
      }
      return executeMcpQuery('mcp-get-run', { targetRunId: run_id });
    }

    case 'cyboflow_submit_checkpoint': {
      const args = (request.params.arguments ?? {}) as { label?: unknown; note?: unknown };
      const { label, note } = args;
      if (typeof label !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'label: string' }),
            },
          ],
        };
      }
      if (note !== undefined && typeof note !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'note: string (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { label };
      if (note !== undefined) queryParams['note'] = note;
      return executeMcpQuery('mcp-submit-checkpoint', queryParams);
    }

    case 'cyboflow_report_step': {
      const args = (request.params.arguments ?? {}) as { step_id?: unknown; status?: unknown };
      const { step_id, status } = args;
      if (typeof step_id !== 'string' || step_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'step_id: string' }),
            },
          ],
        };
      }
      if (status !== undefined && status !== 'running' && status !== 'done') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "status: 'running' | 'done' (optional)" }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { stepId: step_id };
      if (status !== undefined) queryParams['status'] = status;
      return executeMcpQuery('mcp-report-step', queryParams);
    }

    case 'cyboflow_request_user_input': {
      const args = (request.params.arguments ?? {}) as { questions?: unknown };
      if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > 4) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'questions: array (1-4)' }) }],
        };
      }

      const questions: QuestionPayload[] = [];
      for (const rawQuestion of args.questions) {
        if (typeof rawQuestion !== 'object' || rawQuestion === null || Array.isArray(rawQuestion)) {
          return invalidQuestionArguments();
        }
        const question = rawQuestion as Record<string, unknown>;
        if (
          typeof question['header'] !== 'string'
          || question['header'].trim().length === 0
          || typeof question['question'] !== 'string'
          || question['question'].trim().length === 0
          || !Array.isArray(question['options'])
          || question['options'].length < 2
          || question['options'].length > 4
          || (question['multi_select'] !== undefined && typeof question['multi_select'] !== 'boolean')
        ) {
          return invalidQuestionArguments();
        }

        const options: QuestionPayload['options'][number][] = [];
        for (const rawOption of question['options']) {
          if (typeof rawOption !== 'object' || rawOption === null || Array.isArray(rawOption)) {
            return invalidQuestionArguments();
          }
          const option = rawOption as Record<string, unknown>;
          if (
            typeof option['label'] !== 'string'
            || option['label'].trim().length === 0
            || (option['description'] !== undefined && typeof option['description'] !== 'string')
            || (option['preview'] !== undefined && typeof option['preview'] !== 'string')
          ) {
            return invalidQuestionArguments();
          }
          options.push({
            label: option['label'],
            ...(typeof option['description'] === 'string' ? { description: option['description'] } : {}),
            ...(typeof option['preview'] === 'string' ? { preview: option['preview'] } : {}),
          });
        }

        questions.push({
          header: question['header'],
          question: question['question'],
          multiSelect: question['multi_select'] === true,
          options,
        });
      }

      // Human question gates legitimately block for days (sessions get left
      // open over a weekend) — no bridge timeout: the gate waits as long as the
      // run is alive (socket close exits this process). The only remaining
      // bound is the substrate MCP client's own cap (Codex: tool_timeout_sec
      // in runConfig.buildMcpConfig; Claude has none).
      return executeMcpQuery('mcp-request-user-input', { questions }, null);
    }

    case 'cyboflow_create_task': {
      const args = (request.params.arguments ?? {}) as {
        title?: unknown;
        task_type?: unknown;
        summary?: unknown;
        body?: unknown;
        priority?: unknown;
        category?: unknown;
        repo?: unknown;
        parent_epic_id?: unknown;
        board_id?: unknown;
        initial_stage_id?: unknown;
        scope?: unknown;
        originating_idea_id?: unknown;
      };
      const { title, task_type, summary, body, priority, category, repo, parent_epic_id, board_id, initial_stage_id, scope, originating_idea_id } = args;
      if (typeof title !== 'string' || title.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'title: string' }),
            },
          ],
        };
      }
      if (task_type !== undefined && task_type !== 'idea' && task_type !== 'epic' && task_type !== 'task') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "task_type: 'idea' | 'epic' | 'task' (optional)" }),
            },
          ],
        };
      }
      if (summary !== undefined && typeof summary !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'summary: string (optional)' }),
            },
          ],
        };
      }
      if (body !== undefined && typeof body !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'body: string (optional)' }),
            },
          ],
        };
      }
      if (
        priority !== undefined &&
        priority !== 'P0' &&
        priority !== 'P1' &&
        priority !== 'P2' &&
        priority !== 'P3' &&
        priority !== 'P4' &&
        priority !== 'P5' &&
        priority !== 'P6'
      ) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "priority: 'P0'..'P6' (optional)" }),
            },
          ],
        };
      }
      if (category !== undefined && category !== 'feature' && category !== 'bug' && category !== 'chore') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "category: 'feature' | 'bug' | 'chore' (optional)" }),
            },
          ],
        };
      }
      if (repo !== undefined && typeof repo !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'repo: string (optional)' }),
            },
          ],
        };
      }
      if (parent_epic_id !== undefined && typeof parent_epic_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'parent_epic_id: string (optional)' }),
            },
          ],
        };
      }
      if (board_id !== undefined && typeof board_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'board_id: string (optional)' }),
            },
          ],
        };
      }
      if (initial_stage_id !== undefined && typeof initial_stage_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'initial_stage_id: string (optional)' }),
            },
          ],
        };
      }
      if (scope !== undefined && scope !== 'small' && scope !== 'large') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "scope: 'small' | 'large' (optional)" }),
            },
          ],
        };
      }
      if (originating_idea_id !== undefined && typeof originating_idea_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'originating_idea_id: string (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { title };
      if (task_type !== undefined) queryParams['taskType'] = task_type;
      if (summary !== undefined) queryParams['summary'] = summary;
      if (body !== undefined) queryParams['body'] = body;
      if (priority !== undefined) queryParams['priority'] = priority;
      if (category !== undefined) queryParams['category'] = category;
      if (repo !== undefined) queryParams['repo'] = repo;
      if (parent_epic_id !== undefined) queryParams['parentEpicId'] = parent_epic_id;
      if (board_id !== undefined) queryParams['boardId'] = board_id;
      if (initial_stage_id !== undefined) queryParams['initialStageId'] = initial_stage_id;
      if (scope !== undefined) queryParams['scope'] = scope;
      if (originating_idea_id !== undefined) queryParams['originatingIdeaId'] = originating_idea_id;
      return executeMcpQuery('mcp-create-task', queryParams);
    }

    case 'cyboflow_update_task': {
      const args = (request.params.arguments ?? {}) as {
        task_id?: unknown;
        title?: unknown;
        summary?: unknown;
        body?: unknown;
        priority?: unknown;
        category?: unknown;
        repo?: unknown;
        parent_epic_id?: unknown;
        expected_version?: unknown;
        scope?: unknown;
      };
      const { task_id, title, summary, body, priority, category, repo, parent_epic_id, expected_version, scope } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }),
            },
          ],
        };
      }
      if (title !== undefined && typeof title !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'title: string (optional)' }),
            },
          ],
        };
      }
      if (summary !== undefined && typeof summary !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'summary: string (optional)' }),
            },
          ],
        };
      }
      if (body !== undefined && typeof body !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'body: string (optional)' }),
            },
          ],
        };
      }
      if (
        priority !== undefined &&
        priority !== 'P0' &&
        priority !== 'P1' &&
        priority !== 'P2' &&
        priority !== 'P3' &&
        priority !== 'P4' &&
        priority !== 'P5' &&
        priority !== 'P6'
      ) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "priority: 'P0'..'P6' (optional)" }),
            },
          ],
        };
      }
      if (category !== undefined && category !== 'feature' && category !== 'bug' && category !== 'chore') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "category: 'feature' | 'bug' | 'chore' (optional)" }),
            },
          ],
        };
      }
      if (repo !== undefined && typeof repo !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'repo: string (optional)' }),
            },
          ],
        };
      }
      if (parent_epic_id !== undefined && typeof parent_epic_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'parent_epic_id: string (optional)' }),
            },
          ],
        };
      }
      if (expected_version !== undefined && typeof expected_version !== 'number') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'expected_version: number (optional)' }),
            },
          ],
        };
      }
      if (scope !== undefined && scope !== 'small' && scope !== 'large') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "scope: 'small' | 'large' (optional)" }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { taskId: task_id };
      if (title !== undefined) queryParams['title'] = title;
      if (summary !== undefined) queryParams['summary'] = summary;
      if (body !== undefined) queryParams['body'] = body;
      if (priority !== undefined) queryParams['priority'] = priority;
      if (category !== undefined) queryParams['category'] = category;
      if (repo !== undefined) queryParams['repo'] = repo;
      if (parent_epic_id !== undefined) queryParams['parentEpicId'] = parent_epic_id;
      if (expected_version !== undefined) queryParams['expectedVersion'] = expected_version;
      if (scope !== undefined) queryParams['scope'] = scope;
      return executeMcpQuery('mcp-update-task', queryParams);
    }

    case 'cyboflow_set_task_stage': {
      const args = (request.params.arguments ?? {}) as {
        task_id?: unknown;
        stage_id?: unknown;
        expected_version?: unknown;
      };
      const { task_id, stage_id, expected_version } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }),
            },
          ],
        };
      }
      if (typeof stage_id !== 'string' || stage_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'stage_id: string' }),
            },
          ],
        };
      }
      if (expected_version !== undefined && typeof expected_version !== 'number') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'expected_version: number (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { taskId: task_id, stageId: stage_id };
      if (expected_version !== undefined) queryParams['expectedVersion'] = expected_version;
      return executeMcpQuery('mcp-set-task-stage', queryParams);
    }

    case 'cyboflow_add_task_dependency': {
      const args = (request.params.arguments ?? {}) as {
        task_id?: unknown;
        depends_on_task_id?: unknown;
        kind?: unknown;
      };
      const { task_id, depends_on_task_id, kind } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }) },
          ],
        };
      }
      if (typeof depends_on_task_id !== 'string' || depends_on_task_id.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'depends_on_task_id: string' }),
            },
          ],
        };
      }
      if (kind !== undefined && kind !== 'blocking' && kind !== 'related') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "kind: 'blocking' | 'related' (optional)" }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { taskId: task_id, dependsOnTaskId: depends_on_task_id };
      if (kind !== undefined) queryParams['dependencyKind'] = kind;
      return executeMcpQuery('mcp-add-task-dependency', queryParams);
    }

    case 'cyboflow_set_idea_component': {
      const args = (request.params.arguments ?? {}) as {
        idea_id?: unknown;
        component?: unknown;
        state?: unknown;
      };
      const { idea_id, component, state } = args;
      if (typeof idea_id !== 'string' || idea_id.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'idea_id: string' }) },
          ],
        };
      }
      if (
        component !== 'idea-spec' &&
        component !== 'prototype' &&
        component !== 'architecture' &&
        component !== 'epics' &&
        component !== 'stories'
      ) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'invalid_arguments',
                expected: "component: 'idea-spec' | 'prototype' | 'architecture' | 'epics' | 'stories'",
              }),
            },
          ],
        };
      }
      if (state !== 'complete' && state !== 'incomplete' && state !== 'skipped') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'invalid_arguments',
                expected: "state: 'complete' | 'incomplete' | 'skipped'",
              }),
            },
          ],
        };
      }
      return executeMcpQuery('mcp-set-idea-component', { ideaId: idea_id, component, state });
    }

    case 'cyboflow_list_tasks': {
      const args = (request.params.arguments ?? {}) as {
        task_type?: unknown;
        include_archived?: unknown;
        include_done?: unknown;
      };
      const { task_type, include_archived, include_done } = args;
      if (task_type !== undefined && task_type !== 'idea' && task_type !== 'epic' && task_type !== 'task') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "task_type: 'idea' | 'epic' | 'task' (optional)" }),
            },
          ],
        };
      }
      if (include_archived !== undefined && typeof include_archived !== 'boolean') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'include_archived: boolean (optional)' }),
            },
          ],
        };
      }
      if (include_done !== undefined && typeof include_done !== 'boolean') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'include_done: boolean (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = {};
      if (task_type !== undefined) queryParams['taskType'] = task_type;
      if (include_archived !== undefined) queryParams['includeArchived'] = include_archived;
      if (include_done !== undefined) queryParams['includeDone'] = include_done;
      return executeMcpQuery('mcp-list-tasks', queryParams);
    }

    case 'cyboflow_get_task': {
      const args = (request.params.arguments ?? {}) as { task_id?: unknown };
      const { task_id } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }) },
          ],
        };
      }
      return executeMcpQuery('mcp-get-task', { taskId: task_id });
    }

    case 'cyboflow_update_sprint_task': {
      const args = (request.params.arguments ?? {}) as {
        task_id?: unknown;
        status?: unknown;
        current_step?: unknown;
        attempt?: unknown;
      };
      const { task_id, status, current_step, attempt } = args;
      if (typeof task_id !== 'string' || task_id.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string' }) },
          ],
        };
      }
      if (
        status !== undefined &&
        status !== 'queued' &&
        status !== 'running' &&
        status !== 'integrated' &&
        status !== 'failed' &&
        status !== 'blocked'
      ) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'invalid_arguments',
                expected: "status: 'queued' | 'running' | 'integrated' | 'failed' | 'blocked' (optional)",
              }),
            },
          ],
        };
      }
      // NOT a fixed-enum check: a confirmed pre-existing bug had this list missing
      // 'awaiting-verify' — sprint.md/ship.md instruct the orchestrator to park
      // lanes there and this check rejected it with invalid_arguments before the
      // call ever reached the socket. The lane step vocabulary is chain-derived
      // (per-run fanOut.inner ids) and validated server-side by
      // SprintLaneStore.updateLane against the calling run's resolved chain —
      // this client-side check now only guards the wire shape (non-empty string).
      if (current_step !== undefined && (typeof current_step !== 'string' || current_step.length === 0)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'invalid_arguments',
                expected: 'current_step: non-empty string (optional) — validated server-side',
              }),
            },
          ],
        };
      }
      if (attempt !== undefined && (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'attempt: integer >= 1 (optional)' }),
            },
          ],
        };
      }
      if (status === undefined && current_step === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'invalid_arguments',
                expected: 'at least one of status / current_step',
              }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { taskId: task_id };
      if (status !== undefined) queryParams['status'] = status;
      if (current_step !== undefined) queryParams['currentStepId'] = current_step;
      if (attempt !== undefined) queryParams['attempt'] = attempt;
      return executeMcpQuery('mcp-update-sprint-task', queryParams);
    }

    case 'cyboflow_create_sprint_batch': {
      const args = (request.params.arguments ?? {}) as { task_ids?: unknown };
      const { task_ids } = args;
      const queryParams: Record<string, unknown> = {};
      if (task_ids !== undefined) {
        if (!Array.isArray(task_ids) || task_ids.some((id) => typeof id !== 'string' || id.length === 0)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: 'invalid_arguments',
                  expected: 'task_ids: string[] (optional, non-empty strings)',
                }),
              },
            ],
          };
        }
        queryParams['taskIds'] = task_ids;
      }
      return executeMcpQuery('mcp-create-sprint-batch', queryParams);
    }

    case 'cyboflow_report_finding': {
      const args = (request.params.arguments ?? {}) as {
        title?: unknown;
        body?: unknown;
        severity?: unknown;
        kind?: unknown;
        blocking?: unknown;
        entity_type?: unknown;
        entity_id?: unknown;
        category?: unknown;
        locations?: unknown;
        suggested_fix?: unknown;
        proposed_target?: unknown;
        impact?: unknown;
        payload_json?: unknown;
      };
      const { title, body, severity, kind, blocking, entity_type, entity_id, category, locations, suggested_fix, proposed_target, impact, payload_json } = args;
      if (typeof title !== 'string' || title.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'title: string' }) },
          ],
        };
      }
      if (typeof body !== 'string' || body.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'body: string' }) },
          ],
        };
      }
      if (severity !== undefined && severity !== 'info' && severity !== 'warning' && severity !== 'error') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "severity: 'info' | 'warning' | 'error' (optional)" }),
            },
          ],
        };
      }
      if (kind !== undefined && kind !== 'finding' && kind !== 'decision' && kind !== 'human_task') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "kind: 'finding' | 'decision' | 'human_task' (optional)" }),
            },
          ],
        };
      }
      if (blocking !== undefined && typeof blocking !== 'boolean') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'blocking: boolean (optional)' }),
            },
          ],
        };
      }
      if (entity_type !== undefined && entity_type !== 'idea' && entity_type !== 'epic' && entity_type !== 'task') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "entity_type: 'idea' | 'epic' | 'task' (optional)" }),
            },
          ],
        };
      }
      if (entity_id !== undefined && typeof entity_id !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'entity_id: string (optional)' }),
            },
          ],
        };
      }
      if (payload_json !== undefined && typeof payload_json !== 'string') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'payload_json: string (optional)' }),
            },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { title, body };
      if (severity !== undefined) queryParams['severity'] = severity;
      if (kind !== undefined) queryParams['kind'] = kind;
      if (blocking !== undefined) queryParams['blocking'] = blocking;
      if (entity_type !== undefined) queryParams['entityType'] = entity_type;
      if (entity_id !== undefined) queryParams['entityId'] = entity_id;
      // The structured finding extras are passed through UNVALIDATED — the
      // handler unknown-guards each shape and DROPS malformed members so an agent
      // typo can never fail a finding write (see handleReportFinding).
      if (category !== undefined) queryParams['category'] = category;
      if (locations !== undefined) queryParams['locations'] = locations;
      if (suggested_fix !== undefined) queryParams['suggestedFix'] = suggested_fix;
      if (proposed_target !== undefined) queryParams['proposedTarget'] = proposed_target;
      if (impact !== undefined) queryParams['impact'] = impact;
      if (payload_json !== undefined) queryParams['payloadJson'] = payload_json;
      return executeMcpQuery('mcp-report-finding', queryParams);
    }

    case 'cyboflow_get_selected_findings': {
      // Read-only; bound from CYBOFLOW_RUN_ID — no arguments.
      return executeMcpQuery('mcp-get-selected-findings', {});
    }

    case 'cyboflow_list_run_findings': {
      // Read-only; bound from CYBOFLOW_RUN_ID — no arguments.
      return executeMcpQuery('mcp-list-run-findings', {});
    }

    case 'cyboflow_resolve_finding': {
      const args = (request.params.arguments ?? {}) as {
        review_item_id?: unknown;
        resolution_kind?: unknown;
        note?: unknown;
        task_id?: unknown;
      };
      const { review_item_id, resolution_kind, note, task_id } = args;
      if (typeof review_item_id !== 'string' || review_item_id.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'review_item_id: string' }) },
          ],
        };
      }
      if (resolution_kind !== 'fixed' && resolution_kind !== 'triaged' && resolution_kind !== 'promoted') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: "resolution_kind: 'fixed' | 'triaged' | 'promoted'" }),
            },
          ],
        };
      }
      if (note !== undefined && typeof note !== 'string') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'note: string (optional)' }) },
          ],
        };
      }
      if (task_id !== undefined && typeof task_id !== 'string') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_id: string (optional)' }) },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { reviewItemId: review_item_id, resolutionKind: resolution_kind };
      if (note !== undefined) queryParams['note'] = note;
      if (task_id !== undefined) queryParams['taskId'] = task_id;
      return executeMcpQuery('mcp-resolve-finding', queryParams);
    }

    case 'cyboflow_report_artifact': {
      const args = (request.params.arguments ?? {}) as {
        atype?: unknown;
        label?: unknown;
        payload_json?: unknown;
      };
      const { atype, label, payload_json } = args;
      // DERIVED from the artifact-policy registry (reportable:true), the SAME
      // list the ListTools enum above advertises — so the two can never drift.
      // 'arch-design'/'approve-designs' are excluded (reportable:false,
      // auto-mint-only): an agent-reported arch-design would lack source_ref and
      // render a broken tab. 'compound-recommendations' IS reportable — it is
      // payload-backed (payload_json.markdown), so it renders correctly with
      // source_ref NULL, unlike the entity-backed templated atypes.
      // 'eval-report' is likewise payload-backed but SYSTEM-MINTED ONLY
      // (reportable:false — EvalWorker composes it from the scored verdict): an
      // agent-authored one would be an unscored doc wearing the verdict tab.
      const validAtypes: string[] = REPORTABLE_ARTIFACT_ATYPES;
      if (typeof atype !== 'string' || !validAtypes.includes(atype)) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: `atype: ${validAtypes.join(' | ')}` }) },
          ],
        };
      }
      if (typeof label !== 'string' || label.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'label: string' }) }],
        };
      }
      if (payload_json !== undefined && typeof payload_json !== 'string') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'payload_json: string (optional)' }) },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { atype, label };
      if (payload_json !== undefined) queryParams['payloadJson'] = payload_json;
      return executeMcpQuery('mcp-report-artifact', queryParams);
    }

    case 'cyboflow_commit_artifact': {
      const args = (request.params.arguments ?? {}) as { artifact_id?: unknown; payload_json?: unknown };
      const { artifact_id, payload_json } = args;
      if (typeof artifact_id !== 'string' || artifact_id.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'artifact_id: string' }) },
          ],
        };
      }
      if (payload_json !== undefined && typeof payload_json !== 'string') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'payload_json: string (optional)' }) },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { artifactId: artifact_id };
      if (payload_json !== undefined) queryParams['payloadJson'] = payload_json;
      return executeMcpQuery('mcp-commit-artifact', queryParams);
    }

    case 'cyboflow_request_verification': {
      const args = (request.params.arguments ?? {}) as {
        intent?: unknown;
        task?: unknown;
        type_override?: unknown;
        url?: unknown;
        html_path?: unknown;
        viewports?: unknown;
        baseline_key?: unknown;
        task_ref?: unknown;
        setup_proof?: unknown;
        runbook_hash?: unknown;
        runbook_local_version?: unknown;
      };
      const {
        intent: rawIntent,
        task,
        type_override,
        url,
        html_path,
        viewports,
        baseline_key,
        task_ref,
        setup_proof,
        runbook_hash,
        runbook_local_version,
      } = args;
      // `intent` is required for the LEGACY form only. A task-form call (the
      // fan-out prose passes just `task` + `task_ref`) derives a best-effort
      // intent from task.summary here — unvalidated; the handler strictly
      // validates the task server-side and derives the persisted deliverable
      // from it, so this stand-in never drives judging on the task path.
      const taskSummary =
        typeof task === 'object' && task !== null && !Array.isArray(task)
          ? (task as { summary?: unknown }).summary
          : undefined;
      const intent =
        typeof rawIntent === 'string' && rawIntent.length > 0
          ? rawIntent
          : typeof taskSummary === 'string' && taskSummary.length > 0
            ? taskSummary
            : undefined;
      if (intent === undefined) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'invalid_arguments', expected: 'intent: string (or task.summary)' }),
            },
          ],
        };
      }
      const validTypes = [
        'static-render-snapshot',
        'interactive-web-behavior',
        'responsive-multi-viewport',
        'native-desktop',
        'mobile-flow',
      ];
      if (type_override !== undefined && (typeof type_override !== 'string' || !validTypes.includes(type_override))) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: `type_override: ${validTypes.join(' | ')} (optional)` }) },
          ],
        };
      }
      if (url !== undefined && typeof url !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'url: string (optional)' }) }],
        };
      }
      if (html_path !== undefined && typeof html_path !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'html_path: string (optional)' }) }],
        };
      }
      if (baseline_key !== undefined && typeof baseline_key !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'baseline_key: string (optional)' }) }],
        };
      }
      if (task_ref !== undefined && typeof task_ref !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'task_ref: string (optional)' }) }],
        };
      }
      if (setup_proof !== undefined && typeof setup_proof !== 'boolean') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'setup_proof: boolean (optional)' }) }],
        };
      }
      if (runbook_hash !== undefined && typeof runbook_hash !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'runbook_hash: string (optional)' }) }],
        };
      }
      if (runbook_local_version !== undefined && typeof runbook_local_version !== 'number') {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'invalid_arguments', expected: 'runbook_local_version: number (optional)' }) },
          ],
        };
      }
      const queryParams: Record<string, unknown> = { intent };
      // `task` is threaded through VERBATIM, unvalidated — the handler strictly
      // validates its shape server-side (parseVerificationTaskV1) so a malformed
      // task can never silently coerce into a bogus deliverable. When present it
      // supersedes intent/url/html_path/viewports for the persisted deliverable
      // (§5.2 dual-format contract), though `intent` stays wire-required above so
      // every call carries SOME acceptance text even before task-verify's prompt
      // contract (a later slice) starts omitting it.
      if (task !== undefined) queryParams['task'] = task;
      if (type_override !== undefined) queryParams['typeOverride'] = type_override;
      if (url !== undefined) queryParams['url'] = url;
      if (html_path !== undefined) queryParams['htmlPath'] = html_path;
      // viewports / baselineKey are passed through UNVALIDATED — the handler
      // narrows the deliverable shape and DROPS malformed members so an agent typo
      // can never fail a fire-and-continue request.
      if (viewports !== undefined) queryParams['viewports'] = viewports;
      if (baseline_key !== undefined) queryParams['baselineKey'] = baseline_key;
      // taskRef: the lane attribution for the visual merge-gate (verdict→lane).
      if (task_ref !== undefined) queryParams['taskRef'] = task_ref;
      // §3.6/§5.2 seam 3 (verification-setup-flow): the setup flow's proof
      // channel. The two pin halves are threaded independently and the HANDLER
      // requires both before it stamps anything — half a pin is not a pin, and
      // dropping it there (rather than here) keeps one rule at one site.
      if (setup_proof !== undefined) queryParams['setupProof'] = setup_proof;
      if (runbook_hash !== undefined) queryParams['runbookHash'] = runbook_hash;
      if (runbook_local_version !== undefined) queryParams['runbookLocalVersion'] = runbook_local_version;
      return executeMcpQuery('mcp-request-verification', queryParams);
    }

    case 'cyboflow_run_eval': {
      // Run-bound + parameterless: the graded artifact is THIS run's current diff
      // (the run comes from CYBOFLOW_RUN_ID via the transport envelope), so there
      // is nothing to validate. Fire-and-continue — the reply is the queue status,
      // never the verdict.
      return executeMcpQuery('mcp-run-eval', {});
    }

    case 'cyboflow_await_verification': {
      const args = (request.params.arguments ?? {}) as { request_id?: unknown; timeout_ms?: unknown };
      const { request_id, timeout_ms } = args;
      if (typeof request_id !== 'string' || request_id.length === 0) {
        return invalidArgs('request_id: string (the id cyboflow_request_verification returned)');
      }
      if (timeout_ms !== undefined && (typeof timeout_ms !== 'number' || !Number.isFinite(timeout_ms))) {
        return invalidArgs('timeout_ms: number (optional)');
      }
      // `request_id` is renamed to `verificationRequestId` on the wire: every
      // message on this socket already carries its OWN `requestId` correlation
      // id, and colliding the two would make the handler answer the wrong call.
      const queryParams: Record<string, unknown> = { verificationRequestId: request_id };
      if (timeout_ms !== undefined) queryParams['timeoutMs'] = timeout_ms;
      // The TRANSPORT budget must outlive the HANDLER's wait budget, or the
      // socket would give up first and hand the caller 'orchestrator_timeout'
      // instead of the handler's honest answer ("still running, I stopped
      // waiting"). Same pattern as the question gate's 30-minute transport
      // budget, sized here off the handler's own 20-minute clamp plus slack.
      return executeMcpQuery('mcp-await-verification', queryParams, AWAIT_VERIFICATION_TRANSPORT_TIMEOUT_MS);
    }

    case 'cyboflow_get_verifications': {
      const args = (request.params.arguments ?? {}) as { request_id?: unknown };
      const { request_id } = args;
      if (request_id !== undefined && (typeof request_id !== 'string' || request_id.length === 0)) {
        return invalidArgs('request_id: string (optional; the id cyboflow_request_verification returned)');
      }
      // `request_id` is renamed to `verificationRequestId` on the wire: every
      // message on this socket already carries its OWN `requestId` correlation
      // id, and colliding the two would make the handler answer the wrong call.
      const queryParams: Record<string, unknown> = {};
      if (request_id !== undefined) queryParams['verificationRequestId'] = request_id;
      // NON-BLOCKING cold read — no custom transport timeout. The extended
      // AWAIT_VERIFICATION_TRANSPORT_TIMEOUT_MS budget exists only for the
      // BLOCKING await tool above; this handler answers from the DB immediately.
      return executeMcpQuery('mcp-get-verifications', queryParams);
    }

    case 'cyboflow_register_verify_runbook': {
      const args = (request.params.arguments ?? {}) as { modality?: unknown; bindings_json?: unknown };
      const { modality, bindings_json } = args;
      if (modality !== 'web' && modality !== 'cdp-app' && modality !== 'native-screen') {
        return invalidArgs("modality: 'web' | 'cdp-app' | 'native-screen'");
      }
      if (bindings_json !== undefined && typeof bindings_json !== 'string') {
        return invalidArgs('bindings_json: string (optional, JSON object)');
      }
      const queryParams: Record<string, unknown> = { modality };
      // Parseability is re-checked server-side (one validation site); the type
      // guard here only keeps a non-string off the wire.
      if (bindings_json !== undefined) queryParams['bindingsJson'] = bindings_json;
      return executeMcpQuery('mcp-register-verify-runbook', queryParams);
    }

    case 'cyboflow_list_workflows': {
      // Run-bound (project derived from CYBOFLOW_RUN_ID) — no arguments.
      return executeMcpQuery('mcp-list-workflows', {});
    }

    case 'cyboflow_get_workflow': {
      const args = (request.params.arguments ?? {}) as { workflow_id?: unknown };
      const { workflow_id } = args;
      if (typeof workflow_id !== 'string' || workflow_id.length === 0) {
        return invalidArgs('workflow_id: string');
      }
      return executeMcpQuery('mcp-get-workflow', { workflowId: workflow_id });
    }

    case 'cyboflow_update_workflow': {
      const args = (request.params.arguments ?? {}) as { workflow_id?: unknown; definition_json?: unknown };
      const { workflow_id, definition_json } = args;
      if (typeof workflow_id !== 'string' || workflow_id.length === 0) {
        return invalidArgs('workflow_id: string');
      }
      if (typeof definition_json !== 'string' || definition_json.length === 0) {
        return invalidArgs('definition_json: string (JSON-encoded WorkflowDefinition)');
      }
      return executeMcpQuery('mcp-update-workflow', { workflowId: workflow_id, definitionJson: definition_json });
    }

    case 'cyboflow_reset_workflow': {
      const args = (request.params.arguments ?? {}) as { workflow_id?: unknown };
      const { workflow_id } = args;
      if (typeof workflow_id !== 'string' || workflow_id.length === 0) {
        return invalidArgs('workflow_id: string');
      }
      return executeMcpQuery('mcp-reset-workflow', { workflowId: workflow_id });
    }

    case 'cyboflow_create_workflow': {
      const args = (request.params.arguments ?? {}) as {
        name?: unknown;
        definition_json?: unknown;
        permission_mode?: unknown;
        scope?: unknown;
      };
      const { name, definition_json, permission_mode, scope } = args;
      if (typeof name !== 'string' || name.length === 0) {
        return invalidArgs('name: string');
      }
      if (definition_json !== undefined && typeof definition_json !== 'string') {
        return invalidArgs('definition_json: string (optional, JSON-encoded WorkflowDefinition)');
      }
      if (
        permission_mode !== undefined &&
        permission_mode !== 'default' &&
        permission_mode !== 'acceptEdits' &&
        permission_mode !== 'auto' &&
        permission_mode !== 'dontAsk'
      ) {
        return invalidArgs("permission_mode: 'default' | 'acceptEdits' | 'auto' | 'dontAsk' (optional)");
      }
      if (scope !== undefined && scope !== 'global' && scope !== 'project') {
        return invalidArgs("scope: 'global' | 'project' (optional)");
      }
      const queryParams: Record<string, unknown> = { name };
      if (definition_json !== undefined) queryParams['definitionJson'] = definition_json;
      if (permission_mode !== undefined) queryParams['permissionMode'] = permission_mode;
      if (scope !== undefined) queryParams['scope'] = scope;
      return executeMcpQuery('mcp-create-workflow', queryParams);
    }

    case 'cyboflow_delete_workflow': {
      const args = (request.params.arguments ?? {}) as { workflow_id?: unknown };
      const { workflow_id } = args;
      if (typeof workflow_id !== 'string' || workflow_id.length === 0) {
        return invalidArgs('workflow_id: string');
      }
      return executeMcpQuery('mcp-delete-workflow', { workflowId: workflow_id });
    }

    case 'cyboflow_list_variants': {
      const args = (request.params.arguments ?? {}) as { workflow_id?: unknown };
      const { workflow_id } = args;
      if (typeof workflow_id !== 'string' || workflow_id.length === 0) {
        return invalidArgs('workflow_id: string');
      }
      return executeMcpQuery('mcp-list-variants', { workflowId: workflow_id });
    }

    case 'cyboflow_create_variant': {
      const args = (request.params.arguments ?? {}) as { workflow_id?: unknown; label?: unknown };
      const { workflow_id, label } = args;
      if (typeof workflow_id !== 'string' || workflow_id.length === 0) {
        return invalidArgs('workflow_id: string');
      }
      if (typeof label !== 'string' || label.length === 0) {
        return invalidArgs('label: string');
      }
      return executeMcpQuery('mcp-create-variant', { workflowId: workflow_id, label });
    }

    case 'cyboflow_update_variant': {
      const args = (request.params.arguments ?? {}) as {
        variant_id?: unknown;
        definition_json?: unknown;
        agent_overrides_json?: unknown;
        model?: unknown;
        execution_model?: unknown;
        weight?: unknown;
        label?: unknown;
      };
      const { variant_id, definition_json, agent_overrides_json, model, execution_model, weight, label } = args;
      if (typeof variant_id !== 'string' || variant_id.length === 0) {
        return invalidArgs('variant_id: string');
      }
      if (definition_json !== undefined && typeof definition_json !== 'string') {
        return invalidArgs('definition_json: string (optional, JSON-encoded WorkflowDefinition)');
      }
      // null is a MEANINGFUL clear for agent_overrides_json / model / execution_model.
      if (agent_overrides_json !== undefined && agent_overrides_json !== null && typeof agent_overrides_json !== 'string') {
        return invalidArgs('agent_overrides_json: string | null (optional)');
      }
      if (model !== undefined && model !== null && typeof model !== 'string') {
        return invalidArgs('model: string | null (optional)');
      }
      if (
        execution_model !== undefined &&
        execution_model !== null &&
        execution_model !== 'orchestrated' &&
        execution_model !== 'programmatic'
      ) {
        return invalidArgs("execution_model: 'orchestrated' | 'programmatic' | null (optional)");
      }
      if (weight !== undefined && (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0)) {
        return invalidArgs('weight: integer >= 0 (optional)');
      }
      if (label !== undefined && (typeof label !== 'string' || label.length === 0)) {
        return invalidArgs('label: non-empty string (optional)');
      }
      if (
        definition_json === undefined &&
        agent_overrides_json === undefined &&
        model === undefined &&
        execution_model === undefined &&
        weight === undefined &&
        label === undefined
      ) {
        return invalidArgs('at least one field to update');
      }
      const queryParams: Record<string, unknown> = { variantId: variant_id };
      if (definition_json !== undefined) queryParams['definitionJson'] = definition_json;
      if (agent_overrides_json !== undefined) queryParams['agentOverridesJson'] = agent_overrides_json;
      if (model !== undefined) queryParams['model'] = model;
      if (execution_model !== undefined) queryParams['executionModel'] = execution_model;
      if (weight !== undefined) queryParams['weight'] = weight;
      if (label !== undefined) queryParams['label'] = label;
      return executeMcpQuery('mcp-update-variant', queryParams);
    }

    case 'cyboflow_set_variant_status': {
      const args = (request.params.arguments ?? {}) as { variant_id?: unknown; status?: unknown };
      const { variant_id, status } = args;
      if (typeof variant_id !== 'string' || variant_id.length === 0) {
        return invalidArgs('variant_id: string');
      }
      if (status !== 'draft' && status !== 'active' && status !== 'paused' && status !== 'retired') {
        return invalidArgs("status: 'draft' | 'active' | 'paused' | 'retired'");
      }
      return executeMcpQuery('mcp-set-variant-status', { variantId: variant_id, status });
    }

    case 'cyboflow_delete_variant': {
      const args = (request.params.arguments ?? {}) as { variant_id?: unknown };
      const { variant_id } = args;
      if (typeof variant_id !== 'string' || variant_id.length === 0) {
        return invalidArgs('variant_id: string');
      }
      return executeMcpQuery('mcp-delete-variant', { variantId: variant_id });
    }

    case 'cyboflow_set_baseline_rotation': {
      const args = (request.params.arguments ?? {}) as {
        workflow_id?: unknown;
        in_rotation?: unknown;
        weight?: unknown;
      };
      const { workflow_id, in_rotation, weight } = args;
      if (typeof workflow_id !== 'string' || workflow_id.length === 0) {
        return invalidArgs('workflow_id: string');
      }
      if (in_rotation !== undefined && typeof in_rotation !== 'boolean') {
        return invalidArgs('in_rotation: boolean (optional)');
      }
      if (weight !== undefined && (typeof weight !== 'number' || !Number.isInteger(weight) || weight < 0)) {
        return invalidArgs('weight: integer >= 0 (optional)');
      }
      if (in_rotation === undefined && weight === undefined) {
        return invalidArgs('at least one of in_rotation / weight');
      }
      const queryParams: Record<string, unknown> = { workflowId: workflow_id };
      if (in_rotation !== undefined) queryParams['inRotation'] = in_rotation;
      if (weight !== undefined) queryParams['weight'] = weight;
      return executeMcpQuery('mcp-set-baseline-rotation', queryParams);
    }

    default:
      throw new Error(`Unknown tool: ${request.params.name}`);
  }
});

// ---------------------------------------------------------------------------
// Shutdown + spawner-death detection
//
// INSTALLED AT MODULE SCOPE ON PURPOSE — never inside main(). 'end' is emitted
// exactly once; a listener attached after `await server.connect()` misses an
// already-emitted 'end' forever, which recreates the very orphan class this
// exists to prevent. Module scope is always safe because no I/O event is
// delivered before the event loop starts, so nothing can be missed here.
// See PLAN-mcp-orphan-reaper.md §5.
// ---------------------------------------------------------------------------

let shuttingDown = false;

/**
 * Idempotent shutdown. 'close' follows 'end' on a readable stream, so this
 * double-fires by construction; `process.exit` on the first call preempts the
 * second today, but the guard is what keeps that true if any async cleanup
 * (buffer flush, socket end-wait) is ever added below.
 */
function shutdown(reason: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[Cyboflow MCP] ${reason} — exiting`);
  if (ipcClient) ipcClient.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// FAST PATH: the spawner closing its end of the pipe. Fires in milliseconds
// rather than up to one watchdog interval, but is not a guarantee — the MCP
// SDK's StdioServerTransport.close() pauses stdin when it was the sole 'data'
// listener, after which EOF is never observed, and 'end' only fires at all once
// something has put stdin in flowing mode (the transport's own 'data' listener
// does this, so the pre-connect window is covered by the watchdog below, not by
// this). Attaching 'end'/'close' neither resumes nor consumes the stream, so it
// cannot perturb the transport's own reads.
process.stdin.on('end', () => shutdown('stdin EOF'));
process.stdin.on('close', () => shutdown('stdin closed'));

// GUARANTEE: poll for reparent-to-launchd. See parentWatchdog.ts for why ppid is
// the primary signal and stdin EOF the optimization, not the reverse.
startParentWatchdog({
  intervalMs: resolveWatchdogIntervalMs(),
  onOrphaned: (reason) => shutdown(reason),
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    ipcClient = connectToOrchestrator();

    // Give the socket time to establish before the MCP handshake begins
    await new Promise<void>((r) => setTimeout(r, 100));

    await server.connect(new StdioServerTransport());
  } catch (err) {
    console.error('[Cyboflow MCP] Fatal error in main:', err);
    process.exit(1);
  }
}

main();
