import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireSessionSummaryScheduler } from '../wireSessionSummaryScheduler';
import {
  makeSessionSummaryScheduler,
  type SessionSummaryDb,
  type SchedulerSessionRow,
  type SchedulerConversationMessage,
  type SessionSummarySchedulerDeps,
} from '../sessionSummaryScheduler';
import { SESSION_SUMMARY_IDLE_MS } from '../segmentIntoSittings';
import type { SessionSummarizeFn, SessionSummarizerResult } from '../sessionSummaryQuery';

/**
 * Composition-level tests (plan §8 / Codex finding #7): real EventEmitters
 * standing in for `claudeCodeManager` + the `SubstrateDispatchFacade`, the REAL
 * `wireSessionSummaryScheduler` under test, and a real scheduler over a fake
 * db + fake summarize. The scheduler's methods are driven by EVENTS, not called
 * by hand — the one exception is the PTY input seam (`scheduler.noteTurnStart`
 * from the `sessions:input` IPC handler), which is a direct call in production
 * too (plan §2.2), so representing it as a direct call is faithful.
 */

const SID = 'sess-1';
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

function sqliteTs(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

function convMsg(
  id: number,
  message_type: 'user' | 'assistant',
  offsetMs: number,
): SchedulerConversationMessage {
  return { id, message_type, content: `msg ${id}`, timestamp: new Date(BASE + offsetMs).toISOString() };
}

function eligibleSession(overrides: Partial<SchedulerSessionRow> = {}): SchedulerSessionRow {
  return {
    id: SID,
    status: 'completed',
    archived: false,
    chat_run_id: '__quick__',
    agent_provider: 'claude',
    agent_runtime: 'claude-sdk',
    updated_at: sqliteTs(0),
    ...overrides,
  };
}

const OK_RESULT: SessionSummarizerResult = {
  summary: 'current state',
  historySentences: ['did a thing'],
  costUsd: 0.0001,
};

interface Harness {
  claudeManager: EventEmitter;
  facade: EventEmitter;
  summarize: SessionSummarizeFn;
  persistCalls: Array<{ lastTurnId: number; entries: string[] }>;
  messages: SchedulerConversationMessage[];
  gateOpen: { value: boolean };
  turnInFlight: { value: boolean };
  scheduler: ReturnType<typeof makeSessionSummaryScheduler>;
  unwire: () => void;
}

function makeHarness(opts: {
  session?: SchedulerSessionRow;
  summary?: { summary: string; last_turn_id: number };
  messages?: SchedulerConversationMessage[];
  summarizeResult?: SessionSummarizerResult;
  summarizeThrows?: boolean;
} = {}): Harness {
  const claudeManager = new EventEmitter();
  const facade = new EventEmitter();
  const messages = opts.messages ?? [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)];
  const persistCalls: Array<{ lastTurnId: number; entries: string[] }> = [];
  const gateOpen = { value: false };
  const turnInFlight = { value: false };

  const db: SessionSummaryDb = {
    getSession: () => opts.session ?? eligibleSession(),
    getSessionSummary: () => opts.summary,
    getConversationMessagesAfter: (_sid, afterId) => messages.filter((m) => m.id > afterId),
    persistSessionSummaryResult: (params) => {
      persistCalls.push({ lastTurnId: params.lastTurnId, entries: params.entries });
      return true;
    },
  };

  const summarize: SessionSummarizeFn = vi.fn(async () => {
    if (opts.summarizeThrows) throw new Error('boom');
    return opts.summarizeResult ?? OK_RESULT;
  });

  const deps: SessionSummarySchedulerDeps = {
    db,
    isEnabled: () => true,
    summarize,
    isTurnInFlight: () => turnInFlight.value,
    hasOpenGate: () => gateOpen.value,
    now: () => BASE,
  };
  const scheduler = makeSessionSummaryScheduler(deps);
  const unwire = wireSessionSummaryScheduler({ claudeManager, facade, scheduler });

  return { claudeManager, facade, summarize, persistCalls, messages, gateOpen, turnInFlight, scheduler, unwire };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('wireSessionSummaryScheduler (composition)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.CYBOFLOW_DISABLE_SESSION_SUMMARY;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms on an SDK exit event and clears on a spawned event', async () => {
    const h = makeHarness();

    h.claudeManager.emit('exit', { sessionId: SID }); // arm
    h.claudeManager.emit('spawned', { sessionId: SID }); // clear (next turn started)
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS * 2);
    await flush();
    expect(h.summarize).not.toHaveBeenCalled();

    // A fresh exit with no following spawned fires once.
    h.claudeManager.emit('exit', { sessionId: SID });
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('PTY relay turn: the input-seam clear prevents a stale timer firing mid-turn (no spawned)', async () => {
    const h = makeHarness();

    // A PTY turn ends → Stop-hook turn-end arms the timer.
    h.facade.emit('turn-end', { sessionId: SID });

    // The user sends the next composer turn via sessions:input. On a live REPL
    // this emits NO 'spawned' — the IPC handler clears the timer directly.
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS / 2);
    h.scheduler.noteTurnStart(SID); // the input-seam clear (plan §2.2)

    // The long relay turn runs past the original idle window; the stale timer
    // must not fire because it was cleared.
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(h.summarize).not.toHaveBeenCalled();

    // The relay turn finally ends → re-arm → one summarize.
    h.facade.emit('turn-end', { sessionId: SID });
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('open question gate: the armed timer fires, the open-gate probe skips, then re-arm summarizes once', async () => {
    const h = makeHarness();
    h.gateOpen.value = true;

    // The PTY Stop hook fires turn-end even while an AskUserQuestion gate is open.
    h.facade.emit('turn-end', { sessionId: SID });
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(h.summarize).not.toHaveBeenCalled(); // open-gate probe dropped it

    // The human answers → the turn resumes and later ends for real.
    h.gateOpen.value = false;
    h.facade.emit('turn-end', { sessionId: SID });
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('summarizes only after the assistant message is present at fire time (SDK exit ordering)', async () => {
    // The assistant row is committed BEFORE the exit event (production ordering);
    // model that by having the message already readable when exit fires.
    const h = makeHarness({ messages: [convMsg(1, 'user', 0), convMsg(2, 'assistant', 500)] });

    h.claudeManager.emit('exit', { sessionId: SID });
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();

    expect(h.summarize).toHaveBeenCalledTimes(1);
    expect(h.persistCalls[0].lastTurnId).toBe(2);
  });

  it('teardown (dispose) after an exit prevents a summarize mid-shutdown', async () => {
    const h = makeHarness();

    h.claudeManager.emit('exit', { sessionId: SID }); // arm
    h.scheduler.dispose(); // app shutdown before the idle timer fires
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS * 2);
    await flush();
    expect(h.summarize).not.toHaveBeenCalled();
  });

  it('repeated lazy reads after one failed attempt make exactly one call per cooldown window', async () => {
    let clock = BASE;
    const h = makeHarnessWithClock({ summarizeThrows: true }, () => clock);

    // Three "reads" in quick succession (the renderer's 30s poll) → one attempt.
    h.scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    h.scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    clock = BASE + 30_000;
    h.scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();

    expect(h.summarize).toHaveBeenCalledTimes(1);
  });

  it('restart with multiple missed sittings → one call, all assistant-bearing sittings billed, correct watermark', async () => {
    const gap = SESSION_SUMMARY_IDLE_MS + 10_000;
    const messages = [
      convMsg(1, 'user', 0),
      convMsg(2, 'assistant', 1000),
      convMsg(3, 'user', gap),
      convMsg(4, 'assistant', gap + 1000),
      convMsg(5, 'user', gap * 2),
      convMsg(6, 'assistant', gap * 2 + 1000),
    ];
    const h = makeHarness({ messages });

    // A single lazy catch-up on first view after restart.
    h.scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();

    expect(h.summarize).toHaveBeenCalledTimes(1);
    const call = (h.summarize as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      segments: SchedulerConversationMessage[][];
    };
    expect(call.segments).toHaveLength(3); // three assistant-bearing sittings
    expect(h.persistCalls[0].lastTurnId).toBe(6);
  });
});

/** Variant of makeHarness with an injectable clock (for cooldown assertions). */
function makeHarnessWithClock(
  opts: Parameters<typeof makeHarness>[0],
  now: () => number,
): Harness {
  const claudeManager = new EventEmitter();
  const facade = new EventEmitter();
  const messages = opts?.messages ?? [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)];
  const persistCalls: Array<{ lastTurnId: number; entries: string[] }> = [];
  const gateOpen = { value: false };
  const turnInFlight = { value: false };
  const db: SessionSummaryDb = {
    getSession: () => opts?.session ?? eligibleSession(),
    getSessionSummary: () => opts?.summary,
    getConversationMessagesAfter: (_sid, afterId) => messages.filter((m) => m.id > afterId),
    persistSessionSummaryResult: (params) => {
      persistCalls.push({ lastTurnId: params.lastTurnId, entries: params.entries });
      return true;
    },
  };
  const summarize: SessionSummarizeFn = vi.fn(async () => {
    if (opts?.summarizeThrows) throw new Error('boom');
    return opts?.summarizeResult ?? OK_RESULT;
  });
  const scheduler = makeSessionSummaryScheduler({
    db,
    isEnabled: () => true,
    summarize,
    isTurnInFlight: () => turnInFlight.value,
    hasOpenGate: () => gateOpen.value,
    now,
  });
  const unwire = wireSessionSummaryScheduler({ claudeManager, facade, scheduler });
  return { claudeManager, facade, summarize, persistCalls, messages, gateOpen, turnInFlight, scheduler, unwire };
}
