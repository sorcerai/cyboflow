# Performance: measuring cyboflow

How to measure cyboflow's CPU and memory, what the numbers mean, and the traps
that make naive measurements wrong. Load this before doing perf work.

## The one thing to know first

**In the Electron MAIN process, a timer wakeup costs far more than the work it
does.** Electron drives libuv from Chromium's CFRunLoop, so each fire is a
`__CFRunLoopDoSources0 → uv_run → uv__run_timers → RunTimers` round trip, and
re-arming a repeating timer adds a `uv__loop_interrupt` → `kevent` syscall.

The consequence is counter-intuitive and it has already bitten this codebase
once: V8's CPU profiler can report the main process at **0.1% busy** while the
OS reports the process at **2%**, because the cost is in the wakeup machinery,
not in the JS. So:

- A steady `setInterval` in main is expensive **even when its callback does
  nothing**. Prefer on-demand timers armed only while work is actually pending.
- Never conclude "main is idle" from a V8 profile alone. Cross-check with the
  OS (`ps -o cputime`) — see "Measuring honestly" below.

## The harness

```bash
pnpm dev:perf        # dev + CYBOFLOW_PERF_TRACE=1 + --inspect=9229 (main-process V8 inspector)
pnpm dev             # normal dev; renderer CDP on 9223 only
```

`pnpm dev:perf` turns on three things at once via one env var:

| Instrument | Where | Output |
|---|---|---|
| `PerfTracer` (`main/src/services/perfTracer.ts`) | main | `[perf]` — event-loop utilization, process CPU%, event-loop delay, RSS/heap, seam counters |
| `TimerCensus` (`main/src/services/timerCensus.ts`) | main | `[perf-timers]` — wakeups/sec attributed to the code that scheduled each timer |
| `perfProbe` (`frontend/src/utils/perfProbe.ts`) | renderer | `[perf-r]` — long tasks + React commits per `<PerfProfiler id>` area |

`[perf]` / `[perf-timers]` are `logger.info`, which goes to the dev server's
**stdout**, not `cyboflow-backend-debug.log` (only WARN/ERROR are persisted to
file). Redirect when launching: `pnpm dev:perf > /tmp/dev.log 2>&1`.

Add a seam counter with `perfBump('name')` — free when tracing is off.

### scripts/profile-electron.mjs

Dependency-free CDP/inspector client. Needs a running dev app.

```bash
node scripts/profile-electron.mjs sample  --label idle --duration-ms 20000   # per-process CPU + DOM/heap counters
node scripts/profile-electron.mjs cpu     --label idle --duration-ms 30000   # main-process V8 profile + self-time leaderboard
node scripts/profile-electron.mjs cpu     --target renderer --click Insights # renderer profile while driving the UI
node scripts/profile-electron.mjs heap    --label idle --duration-ms 40000   # allocation-site sampling (churn, not retention)
node scripts/profile-electron.mjs handles --label idle                       # live libuv handle census
node scripts/profile-electron.mjs inspect                                    # dump visible text + clickable controls
```

`cpu` writes the raw `.cpuprofile` to `.perf/` (git-ignored) — open it in Chrome
DevTools → Performance for the flame graph.

`cpu`, `heap`, and `handles` need `--inspect`, i.e. `pnpm dev:perf`.

## Measuring honestly

**Use a throwaway data dir.** `CYBOFLOW_DIR=/tmp/cyboflow-perf-profile pnpm dev`
keeps measurements off your real backlog and gives a reproducible starting state.

**The instrumentation is not free.** `--inspect` adds an inspector thread doing
its own `uv__io_poll`, and the tracer/census add a 5s interval plus a captured
stack per scheduled timer. Measured cost: roughly **+1% main-process CPU**. Use
`pnpm dev:perf` to *find* a problem; quote final numbers from plain `pnpm dev`.

**Always A/B against a control.** Absolute numbers mean little alone. Two
controls worth keeping:

- *Bare Electron* — a ~10-line `main.js` opening one window, run with the same
  Electron binary. Idles at **~0.03%** main-process CPU. That is the floor.
- *The previous build* — revert the change, `pnpm build:main`, re-measure under
  identical conditions.

**Ground truth for process CPU is the OS**, sampled over a long window:

```bash
PID=$(ps aux | grep "[E]lectron.app/Contents/MacOS/Electron \." | awk '{print $2}' | head -1)
t0=$(ps -o cputime= -p $PID); sleep 90; t1=$(ps -o cputime= -p $PID)   # diff / 90s
top -l 3 -s 5 -pid $PID -stats pid,cpu,idlew,mem                       # IDLEW = idle wakeups
```

Idle wakeups track battery drain better than CPU% does; they are the metric the
timer census is designed to move.

**Renderer numbers under `pnpm dev` are inflated.** Vite serves React's
development JSX runtime, and `jsxDEV` dominates any renderer profile taken this
way — a navigation profile showed it at ~50% of renderer busy time. Dev-mode
renderer CPU is useful for *relative* comparison and for spotting structural
problems (re-render storms, leaks); it is not a valid absolute figure. Main-process
numbers do NOT have this problem — `main/dist` is the same `tsc` output in dev
and prod.

## Measuring with ACTIVE sessions

Idle numbers miss the parsing/streaming hot paths entirely. To load the app for
real, drive it from outside over the renderer's own bridges — no UI clicking
needed, and it works headlessly:

```bash
# 1. anything the preload exposes, via CDP (window.electronAPI)
node scripts/eval-cdp.mjs "window.electronAPI.sessions.createQuick({ prompt:'', projectId:1,
  worktreeMode:'worktree', agentProvider:'codex', agentRuntime:'codex-sdk', agentModel:'gpt-5.6-luna' })"

# 2. any tRPC procedure, via window.electronTRPC (superjson-wrapped: input is { json: <value> })
node scripts/trpc-call.mjs cyboflow.runs.start mutation \
  '{"workflowId":"wf-global-sprint","projectId":1,"sessionId":"<id>",
    "agentProvider":"claude","agentRuntime":"claude-sdk","substrate":"sdk",
    "taskIds":["<taskId>"],"permissionMode":"dontAsk"}'
```

Point the project at a THROWAWAY git repo — a sprint agent really does commit.
`agentModel` is the unified, provider-normalized field for both providers
(`sonnet` for Claude; a catalog id like `gpt-5.6-luna` for Codex — get the live
list from `window.electronAPI.models.getCodexCatalog()`, it is discovered
dynamically and is NOT in the source).

Two gotchas that will silently give you a useless measurement:

- **Starting a run programmatically does not open its subscriptions.** The
  `throttleAsyncIterator` subscriptions (`events`, `agentThread`) only exist
  while the renderer is watching. If `throttle.js` is absent from
  `[perf-timers]`, nothing is subscribed.
- **The run view streams over the raw `cyboflow:stream:<runId>` IPC channel,
  not the throttled tRPC path.** Opening a run exercises the parser and the raw
  channel; it does not exercise the throttle.

`[perf]`'s seam counters (`raw.claude` / `raw.codex`) are the load level. Always
normalize CPU **per raw event** when comparing two runs — agent pacing varies a
lot between runs, so raw busy-ms comparisons are misleading.

### Baselines with two concurrent sprints (Claude sonnet + Codex Luna)

| Metric | Value |
|---|---|
| Main-process CPU | 0.65–3% (bursty, tracks event rate) |
| Main-process JS busy per raw event | ~0.65ms |
| Event-loop utilization | ~0.0% (never the bottleneck) |
| Main-process heap | ~47MB, flat; ~1.4 MB/min allocated |
| Main-process RSS | 160–280MB, trending DOWN as runs settle |

## Known-good baselines (empty workspace, idle, plain `pnpm dev`)

Recorded 2026-08-13 on macOS/arm64, Electron 37.6.0. Regressions against these
are worth investigating.

| Metric | Value |
|---|---|
| Main-process CPU, idle | ~0.30% (bare-Electron floor: 0.03%) |
| Main-process idle wakeups | ~2 per 3s |
| Main-process timer wakeups | ~0/s (only the tracer's own, when enabled) |
| Main-process heap | ~44MB, **0 bytes/min allocated at idle** |
| Main-process RSS | ~180MB |
| Renderer JS heap, idle | ~25MB |
| Renderer script time, idle | ~0ms per 15s |
| Main-process CPU during UI navigation | ~0.5% |

Renderer DOM growth across repeated navigation converges (node delta per round
253 → 44 → 0), i.e. views mount once and stay — not a leak.

## Fixed: the 60Hz subscription tick (2026-08-13)

`throttleAsyncIterator` (`main/src/orchestrator/trpc/throttle.ts`) used to arm a
`setInterval(1000/hz)` for the entire life of every tRPC subscription. At
`hz=60`, two live subscriptions fired **~98 times/second** between them while
doing **0.8ms of real work per 5000ms** — ~99.98% pure wakeup overhead, burning
~1.5% of a core on a completely idle app.

It now arms a single `setTimeout` only while a value is actually pending, so an
idle subscription holds **no timer at all**. Emission semantics are unchanged
(`lastEmitAt` is seeded at construction, so the first value is still held for a
full `intervalMs` rather than emitted on the leading edge).

Measured, plain `pnpm dev`, identical conditions:

| | idle main CPU | idle wakeups |
|---|---|---|
| Before | 1.76% | 20 / 3s |
| After | **0.30%** | **2 / 3s** |

`throttle.test.ts` pins the invariant ("holds no timer while the source is
idle") so the steady-interval shape cannot come back unnoticed.

## Fixed: ZodError construction per streamed event (2026-08-13)

Profiling the main process under two concurrent sprints put **`ZodError`
construction at 59% of all main-process JS**, with GC (churning those errors)
next at 10%.

`claudeStreamEventSchema` is a 7-branch `z.union` (a plain union, not a
`discriminatedUnion` — Zod 3 rejects nested discriminated unions as branches).
Zod has no fast path for that: it tries each branch in order and **constructs a
full ZodError for every one that does not match**, including the branches it
discards before reaching the one that does. Each ZodError captures a stack
trace. So every streamed event — and a Codex run emits hundreds, none of which
match the Claude schema at all — paid for up to 7 of them.

Every branch pins a distinct top-level `type` literal, so the matching branch is
fully determined by `type` alone. `claudeStreamEventSchemaByType` now dispatches
on it and parses exactly ONE branch. This is semantically identical (a value
whose `type` is X cannot match a branch pinning a different literal; a
missing/non-string `type` matches nothing either way) and is guarded in both
directions by compile-time coverage bridges plus a test asserting the map agrees
with the full union on accepted AND rejected values.

Microbenchmark, realistic mixed corpus: **21.3µs → 1.4µs per event (14.8×)**.

Measured live, two concurrent sprints, same instrumented build:

| | busy JS | ZodError | GC | raw events | JS per event |
|---|---|---|---|---|---|
| Before | 737.6ms | 433.9ms (58.8%) | 72.2ms | 210 | 3.51ms |
| After | 293.5ms | 25.7ms (8.8%) | 15.6ms | 453 | **0.65ms** |

**5.4× less main-process CPU per streamed event** — and the "after" window
carried 2.2× the event volume, so the comparison understates the win.

### Follow-up: the INNER unions (same day)

Re-profiling attributed the 8.8% residual back to `narrow` itself, not to some
other subsystem: the branches carry their own plain unions, and
`contentBlockSchema` is parsed once **per content block** of every assistant
message. `z.union([text, tool_use, thinking])` therefore rebuilt a ZodError per
non-matching block type, per block.

All the block schemas are plain objects pinning a distinct `type`, so these are
exactly what Zod 3's `discriminatedUnion` is for (the nesting constraint that
forced the top-level union does not apply here). Converted:

- `contentBlockSchema` → `z.discriminatedUnion('type', …)`
- user `content: z.array(z.union([tool_result, text]))` → `z.array(z.discriminatedUnion('type', …))`

Accept/reject behaviour is identical; only the error SHAPE on failure changes,
and the sole consumer discards the error. Benchmarked on assistant events with
1/4/12 content blocks: **8.3µs → 4.3µs per event (1.9×)**.

`tool_use_result` is deliberately left as a `z.union` — its arms are an object
and an array with no shared discriminant, so it cannot be converted, and it is
optional + low-volume.

Cumulative for the parser: **21.3µs → ~1.4µs** on the mixed corpus, and
assistant-heavy traffic gets the extra 1.9× on top.
