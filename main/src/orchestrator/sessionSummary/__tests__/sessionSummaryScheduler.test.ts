import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeSessionSummaryScheduler,
  SESSION_SUMMARY_RETRY_COOLDOWN_MS,
  SESSION_SUMMARY_MAX_CONSECUTIVE_FAILURES,
  SESSION_SUMMARY_RACE_GUARD_TOLERANCE_MS,
  type SessionSummaryDb,
  type SchedulerSessionRow,
  type SchedulerConversationMessage,
  type SessionSummarySchedulerDeps,
} from '../sessionSummaryScheduler';
import { SESSION_SUMMARY_IDLE_MS } from '../segmentIntoSittings';
import type { SessionSummarizeFn, SessionSummarizerResult } from '../sessionSummaryQuery';

const SID = 'sess-1';
const BASE = Date.parse('2026-01-01T00:00:00.000Z');

/** Build a UTC 'YYYY-MM-DD HH:MM:SS' string (SQLite CURRENT_TIMESTAMP shape) at BASE + offset. */
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

interface FakeDbConfig {
  session?: SchedulerSessionRow | undefined;
  summary?: { summary: string; last_turn_id: number } | undefined;
  messages?: SchedulerConversationMessage[];
  persistReturns?: boolean;
}

function makeFakeDb(cfg: FakeDbConfig) {
  const persistCalls: Array<Parameters<SessionSummaryDb['persistSessionSummaryResult']>[0]> = [];
  const db: SessionSummaryDb = {
    getSession: vi.fn(() => cfg.session),
    getSessionSummary: vi.fn(() => cfg.summary),
    getConversationMessagesAfter: vi.fn((_sid: string, afterId: number) =>
      (cfg.messages ?? []).filter((m) => m.id > afterId),
    ),
    persistSessionSummaryResult: vi.fn((params) => {
      persistCalls.push(params);
      return cfg.persistReturns ?? true;
    }),
  };
  return { db, persistCalls };
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

/** A summarize fn resolving after a controllable deferral (default: immediate). */
function makeSummarize(result: SessionSummarizerResult = OK_RESULT): SessionSummarizeFn {
  return vi.fn(async () => result);
}

function makeDeps(over: Partial<SessionSummarySchedulerDeps>, db: SessionSummaryDb): SessionSummarySchedulerDeps {
  return {
    db,
    isEnabled: () => true,
    summarize: makeSummarize(),
    isTurnInFlight: () => false,
    hasOpenGate: () => false,
    now: () => BASE,
    ...over,
  };
}

/** Flush the microtask queue so a resolved promise-chain's `.then` bodies run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('sessionSummaryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete process.env.CYBOFLOW_DISABLE_SESSION_SUMMARY;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms on turn-end and fires the summarizer at 5 minutes', async () => {
    const { db, persistCalls } = makeFakeDb({
      session: eligibleSession(),
      summary: undefined,
      messages: [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)],
    });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.noteTurnEnd(SID);
    expect(summarize).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();

    expect(summarize).toHaveBeenCalledTimes(1);
    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0]).toMatchObject({ sessionId: SID, lastTurnId: 2, summary: 'current state' });
    expect(persistCalls[0].entries).toEqual(['did a thing']);
  });

  it('clears a pending timer on turn-start (no fire)', async () => {
    const { db } = makeFakeDb({ session: eligibleSession(), messages: [convMsg(2, 'assistant', 0)] });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.noteTurnEnd(SID);
    scheduler.noteTurnStart(SID);
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS * 2);
    await flush();

    expect(summarize).not.toHaveBeenCalled();
  });

  it('no-ops on an empty delta (nothing above the watermark)', async () => {
    const { db } = makeFakeDb({
      session: eligibleSession(),
      summary: { summary: 'prev', last_turn_id: 5 },
      messages: [convMsg(3, 'assistant', 0)], // id 3 <= watermark 5 → filtered out
    });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.noteTurnEnd(SID);
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();

    expect(summarize).not.toHaveBeenCalled();
  });

  it('no-ops on a user-only delta, leaving the watermark unchanged', async () => {
    const { db, persistCalls } = makeFakeDb({
      session: eligibleSession(),
      messages: [convMsg(6, 'user', 0), convMsg(7, 'user', 1000)],
    });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.noteTurnEnd(SID);
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();

    expect(summarize).not.toHaveBeenCalled();
    expect(persistCalls).toHaveLength(0);
  });

  it('advances the watermark only past the last assistant-bearing segment (trailing user prompt excluded)', async () => {
    const { db, persistCalls } = makeFakeDb({
      session: eligibleSession(),
      // sitting 1: user+assistant (ids 1,2); big gap; trailing user-only (id 3)
      messages: [
        convMsg(1, 'user', 0),
        convMsg(2, 'assistant', 1000),
        convMsg(3, 'user', SESSION_SUMMARY_IDLE_MS + 10_000),
      ],
    });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.noteTurnEnd(SID);
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();

    expect(persistCalls).toHaveLength(1);
    expect(persistCalls[0].lastTurnId).toBe(2); // NOT 3 — the trailing user prompt stays above the watermark
  });

  it('dedupes an in-flight summarize (a refire while one is running no-ops)', async () => {
    const { db } = makeFakeDb({
      session: eligibleSession(),
      messages: [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)],
    });
    let resolveFirst!: () => void;
    const gate = new Promise<void>((r) => (resolveFirst = r));
    const summarize = vi.fn(async () => {
      await gate;
      return OK_RESULT;
    });
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    // second trigger while the first call is still awaiting the gate
    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();

    expect(summarize).toHaveBeenCalledTimes(1);
    resolveFirst();
    await flush();
  });

  it('serializes across sessions behind a global cap of 1', async () => {
    const { db: dbA } = makeFakeDb({
      session: eligibleSession({ id: 'A' }),
      messages: [convMsg(2, 'assistant', 0)],
    });
    // Single shared db handle answering for both sessions by id.
    const sessions: Record<string, SchedulerSessionRow> = {
      A: eligibleSession({ id: 'A' }),
      B: eligibleSession({ id: 'B' }),
    };
    const db: SessionSummaryDb = {
      getSession: (id) => sessions[id],
      getSessionSummary: () => undefined,
      getConversationMessagesAfter: () => [convMsg(2, 'assistant', 0)],
      persistSessionSummaryResult: () => true,
    };
    let concurrent = 0;
    let maxConcurrent = 0;
    const summarize = vi.fn(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await Promise.resolve();
      concurrent--;
      return OK_RESULT;
    });
    void dbA;
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.maybeSummarizeNow('A', 'lazy-catchup');
    scheduler.maybeSummarizeNow('B', 'lazy-catchup');
    await flush();
    await flush();

    expect(summarize).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
  });

  it('skips a same-watermark idle AND lazy trigger within the retry cooldown after a failure', async () => {
    let clock = BASE;
    const { db } = makeFakeDb({
      session: eligibleSession(),
      messages: [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)],
    });
    const summarize = vi.fn(async () => {
      throw new Error('boom');
    });
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, now: () => clock }, db));

    // First idle attempt fails → records cooldown at watermark 2.
    scheduler.noteTurnEnd(SID);
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(summarize).toHaveBeenCalledTimes(1);

    // A lazy trigger at the same watermark, still inside the cooldown → skipped.
    clock = BASE + SESSION_SUMMARY_RETRY_COOLDOWN_MS - 1;
    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    expect(summarize).toHaveBeenCalledTimes(1);

    // Past the cooldown → retried.
    clock = BASE + SESSION_SUMMARY_RETRY_COOLDOWN_MS + 1;
    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cooldown when a new turn edge changes the target watermark', async () => {
    let clock = BASE;
    const messages = [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)];
    const cfg: FakeDbConfig = { session: eligibleSession(), messages };
    const { db } = makeFakeDb(cfg);
    const summarize = vi.fn(async () => {
      throw new Error('boom');
    });
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, now: () => clock }, db));

    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    expect(summarize).toHaveBeenCalledTimes(1);

    // New turn appends id 4 (assistant) → target watermark moves 2 → 4, still in cooldown.
    messages.push(convMsg(3, 'user', 2000), convMsg(4, 'assistant', 3000));
    clock = BASE + 1000; // well inside the cooldown window
    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    expect(summarize).toHaveBeenCalledTimes(2);
  });

  it('suspends the session after 3 consecutive failures (until restart)', async () => {
    let clock = BASE;
    const messages = [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)];
    const { db } = makeFakeDb({ session: eligibleSession(), messages });
    const summarize = vi.fn(async () => {
      throw new Error('boom');
    });
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, now: () => clock }, db));

    // Drive 3 failing attempts, each moving the watermark so the cooldown never blocks.
    for (let n = 0; n < SESSION_SUMMARY_MAX_CONSECUTIVE_FAILURES; n++) {
      messages.push(convMsg(10 + n, 'assistant', 5000 + n));
      clock = BASE + n * 1000;
      scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
      await flush();
    }
    expect(summarize).toHaveBeenCalledTimes(SESSION_SUMMARY_MAX_CONSECUTIVE_FAILURES);

    // A fresh watermark that would otherwise bypass the cooldown is still parked.
    messages.push(convMsg(99, 'assistant', 9000));
    clock = BASE + 100_000;
    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    expect(summarize).toHaveBeenCalledTimes(SESSION_SUMMARY_MAX_CONSECUTIVE_FAILURES);
  });

  it('re-arms instead of firing when the activity clock moved after the arm timestamp', async () => {
    // A turn happened 10s after we armed at BASE but never cleared the timer (a
    // wiring gap) — updated_at sits past armedAt+tolerance on the FIRST fire.
    const { db } = makeFakeDb({
      session: eligibleSession({ updated_at: sqliteTs(10_000) }),
      messages: [convMsg(2, 'assistant', 0)],
    });
    const summarize = makeSummarize();
    // The clock advances between arm and fire so the re-arm's fresh armedAt
    // (captured at the first fire) sits AFTER updated_at, letting the guard pass.
    let clock = BASE;
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, now: () => clock }, db));

    scheduler.noteTurnEnd(SID); // armedAt = BASE
    clock = BASE + SESSION_SUMMARY_IDLE_MS; // now well past updated_at (BASE+10s)
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    // First fire saw updated_at (BASE+10s) > armedAt(BASE)+tolerance → re-armed, no summarize.
    expect(summarize).not.toHaveBeenCalled();

    // Second fire: re-arm's armedAt (BASE+IDLE) is past updated_at → guard passes.
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('does not re-arm for the arming turn own updated_at write (within tolerance)', async () => {
    const { db } = makeFakeDb({
      // updated_at lands just after armedAt (the self-write), inside the tolerance.
      session: eligibleSession({ updated_at: sqliteTs(SESSION_SUMMARY_RACE_GUARD_TOLERANCE_MS - 500) }),
      messages: [convMsg(2, 'assistant', 0)],
    });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.noteTurnEnd(SID);
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(summarize).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the config toggle is off, even with a pending timer', async () => {
    const { db } = makeFakeDb({ session: eligibleSession(), messages: [convMsg(2, 'assistant', 0)] });
    const summarize = makeSummarize();
    let enabled = true;
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, isEnabled: () => enabled }, db));

    scheduler.noteTurnEnd(SID);
    enabled = false; // flipped after arm — checked at fire time
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('is a no-op when the env kill switch is set', async () => {
    process.env.CYBOFLOW_DISABLE_SESSION_SUMMARY = '1';
    const { db } = makeFakeDb({ session: eligibleSession(), messages: [convMsg(2, 'assistant', 0)] });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    expect(summarize).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing session', { session: undefined }],
    ['an archived session', { session: eligibleSession({ archived: true }) }],
    ['a non-quick session (no chat_run_id sentinel)', { session: eligibleSession({ chat_run_id: null }) }],
    ['a Codex-runtime session', { session: eligibleSession({ agent_provider: 'codex' }) }],
  ])('is a no-op for %s', async (_label, cfg) => {
    const { db } = makeFakeDb({ ...cfg, messages: [convMsg(2, 'assistant', 0)] });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('drops the fire while a turn is in flight (no summarize)', async () => {
    const { db } = makeFakeDb({ session: eligibleSession(), messages: [convMsg(2, 'assistant', 0)] });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, isTurnInFlight: () => true }, db));

    scheduler.noteTurnEnd(SID);
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('drops the fire while a question/approval gate is open (no summarize)', async () => {
    const { db } = makeFakeDb({ session: eligibleSession(), messages: [convMsg(2, 'assistant', 0)] });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, hasOpenGate: () => true }, db));

    scheduler.noteTurnEnd(SID);
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS);
    await flush();
    expect(summarize).not.toHaveBeenCalled();
  });

  it('accumulates cost/calls onto persist and resets the failure record on success', async () => {
    const { db, persistCalls } = makeFakeDb({
      session: eligibleSession(),
      messages: [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)],
    });
    const scheduler = makeSessionSummaryScheduler(
      makeDeps({ summarize: makeSummarize({ ...OK_RESULT, costUsd: 0.0025 }) }, db),
    );

    scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
    await flush();
    expect(persistCalls[0].costUsdDelta).toBeCloseTo(0.0025);
  });

  it('dispose() clears a pending timer so it never fires', async () => {
    const { db } = makeFakeDb({ session: eligibleSession(), messages: [convMsg(2, 'assistant', 0)] });
    const summarize = makeSummarize();
    const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize }, db));

    scheduler.noteTurnEnd(SID);
    scheduler.dispose();
    vi.advanceTimersByTime(SESSION_SUMMARY_IDLE_MS * 2);
    await flush();
    expect(summarize).not.toHaveBeenCalled();
  });

  describe('ingestTranscript pre-read hook (PTY follow-up)', () => {
    it('runs ingestTranscript before the watermark read, so backfilled rows are summarized', async () => {
      // The db starts with an EMPTY delta; ingest backfills the rows the watermark
      // read then picks up. This proves ingest runs before the read.
      const messages: SchedulerConversationMessage[] = [];
      const { db, persistCalls } = makeFakeDb({ session: eligibleSession(), messages });
      const summarize = makeSummarize();
      const ingestTranscript = vi.fn(async () => {
        messages.push(convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000));
      });
      const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, ingestTranscript }, db));

      scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
      await flush();
      await flush();

      expect(ingestTranscript).toHaveBeenCalledTimes(1);
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(persistCalls).toHaveLength(1);
      expect(persistCalls[0].lastTurnId).toBe(2);

      // Ordering: ingest was invoked before the delta read.
      const ingestOrder = ingestTranscript.mock.invocationCallOrder[0];
      const readOrder = vi.mocked(db.getConversationMessagesAfter).mock.invocationCallOrder[0];
      expect(ingestOrder).toBeLessThan(readOrder);
    });

    it('continues to summarize existing rows when ingestTranscript rejects', async () => {
      const { db, persistCalls } = makeFakeDb({
        session: eligibleSession(),
        messages: [convMsg(1, 'user', 0), convMsg(2, 'assistant', 1000)],
      });
      const summarize = makeSummarize();
      const ingestTranscript = vi.fn(async () => {
        throw new Error('ingest outage');
      });
      const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, ingestTranscript }, db));

      scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
      await flush();
      await flush();

      expect(ingestTranscript).toHaveBeenCalledTimes(1);
      expect(summarize).toHaveBeenCalledTimes(1);
      expect(persistCalls[0].lastTurnId).toBe(2);
    });

    it('does not run ingestTranscript when a synchronous gate rejects (disabled)', async () => {
      const { db } = makeFakeDb({ session: eligibleSession(), messages: [convMsg(2, 'assistant', 0)] });
      const ingestTranscript = vi.fn(async () => {});
      const scheduler = makeSessionSummaryScheduler(
        makeDeps({ isEnabled: () => false, ingestTranscript }, db),
      );

      scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
      await flush();

      expect(ingestTranscript).not.toHaveBeenCalled();
    });

    it('no-ops (no summarize) when ingest backfills nothing and the delta stays empty', async () => {
      const { db, persistCalls } = makeFakeDb({ session: eligibleSession(), messages: [] });
      const summarize = makeSummarize();
      const ingestTranscript = vi.fn(async () => {
        /* nothing appended */
      });
      const scheduler = makeSessionSummaryScheduler(makeDeps({ summarize, ingestTranscript }, db));

      scheduler.maybeSummarizeNow(SID, 'lazy-catchup');
      await flush();
      await flush();

      expect(ingestTranscript).toHaveBeenCalledTimes(1);
      expect(summarize).not.toHaveBeenCalled();
      expect(persistCalls).toHaveLength(0);
    });
  });
});
