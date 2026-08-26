/**
 * sessionSummaryScheduler — the idle-debounced gating engine for quick-session
 * summaries (plan §5 + §2, `docs/proposals/session-summary-plan.md`).
 *
 * A per-session 5-minute `setTimeout` armed on turn-end and cleared on
 * turn-start is the idle DISCRIMINATOR; the content watermark
 * (`session_summaries.last_turn_id`) is the load-bearing gate. When the timer
 * survives to fire — or a lazy read kicks a catch-up — the full gating stack
 * (§2) runs before any Haiku call: env kill switch, config toggle, session
 * eligibility (exists / not archived / quick-sentinel / Claude runtime),
 * turn-in-flight + open-gate probes, an `updated_at` race guard, the content
 * watermark + sitting segmentation, a per-session in-flight dedupe behind a
 * global concurrency cap of 1, and an attempted-watermark retry cooldown.
 *
 * PURE MODULE — injected deps only (no `services/*` imports, same discipline as
 * `orchestrator/quickSessionListing.ts:13-16`). The db handle is a narrow
 * structural interface the real `DatabaseService` satisfies; the probes,
 * config closure, summarize fn and clock are threaded from the services-layer
 * wiring site (`main/src/index.ts`). That keeps every environment coupling out
 * of here and lets the scheduler unit-test against fakes with fake timers.
 */
import type { LoggerLike } from '../types';
import type { SessionSummarizeFn } from './sessionSummaryQuery';
import {
  SESSION_SUMMARY_IDLE_MS,
  computeWatermarkStop,
  segmentIntoSittings,
  type SummaryInputMessage,
} from './segmentIntoSittings';

/**
 * Any idle OR lazy trigger targeting the SAME watermark within this window
 * after a failed attempt is skipped (plan §2.6). This is what stops the
 * renderer's 30s summary poll from becoming a hot retry loop via lazy
 * catch-up. A new turn edge changes the target watermark and bypasses it.
 */
export const SESSION_SUMMARY_RETRY_COOLDOWN_MS = 10 * 60_000;

/** Per-session consecutive failures after which the session is suspended until restart (plan §2.6). */
export const SESSION_SUMMARY_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Slack absorbed by the `updated_at` race guard. The arming turn's own
 * activity-clock write lands asynchronously just AFTER `noteTurnEnd` records
 * the arm timestamp (the `'exit'` event fires synchronously; the events.ts
 * `updateSession` DB write is awaited after it), so a strict `updated_at >
 * armedAt` compare would re-arm on every session forever. This tolerance
 * excludes that self-write while still catching a genuine later turn (seconds+
 * after arm) that slipped past `noteTurnStart` — the case the guard exists for.
 */
export const SESSION_SUMMARY_RACE_GUARD_TOLERANCE_MS = 2_000;

/** Env kill switch — mirror of `CYBOFLOW_DISABLE_WARM_SDK` (plan §2.8). */
const KILL_SWITCH_ENV = 'CYBOFLOW_DISABLE_SESSION_SUMMARY';

/** A `sessions` row, narrowed to the columns the eligibility + race gates read. */
export interface SchedulerSessionRow {
  id: string;
  status: string;
  archived?: boolean;
  chat_run_id?: string | null;
  agent_provider?: string | null;
  agent_runtime?: string | null;
  updated_at: string;
}

/** A `conversation_messages` row, narrowed to what the delta read needs. */
export interface SchedulerConversationMessage {
  id: number;
  message_type: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

/**
 * The narrow database surface the scheduler reads/writes. The real
 * `DatabaseService` satisfies this structurally (its `getSession` /
 * `getSessionSummary` / `getConversationMessagesAfter` /
 * `persistSessionSummaryResult` return the wider row types, which are
 * assignable to these). Tests pass a hand-rolled fake.
 */
export interface SessionSummaryDb {
  getSession(sessionId: string): SchedulerSessionRow | undefined;
  getSessionSummary(sessionId: string): { summary: string; last_turn_id: number } | undefined;
  getConversationMessagesAfter(sessionId: string, afterId: number): SchedulerConversationMessage[];
  persistSessionSummaryResult(params: {
    sessionId: string;
    summary: string;
    lastTurnId: number;
    costUsdDelta: number;
    entries: string[];
  }): boolean;
}

export interface SessionSummarySchedulerDeps {
  db: SessionSummaryDb;
  /** The config toggle, checked at FIRE time so a settings change lands on pending timers (plan §2.8). */
  isEnabled: () => boolean;
  /** The one-shot Haiku summarizer (from `makeSessionSummarizer`). */
  summarize: SessionSummarizeFn;
  /** True while a logical turn is running for the session (plan §2.3): drop, the turn's own turn-end re-arms. */
  isTurnInFlight: (sessionId: string) => boolean;
  /** True while an AskUserQuestion / permission gate is open for the session (plan §2.3): drop. */
  hasOpenGate: (sessionId: string) => boolean;
  /**
   * OPTIONAL pre-read backfill hook (PTY follow-up). When present it runs inside
   * the queued async section, AFTER the sync gates and BEFORE the watermark read,
   * to ingest an interactive session's Claude-CLI JSONL transcript into
   * `conversation_messages` (SDK sessions get an immediately-resolving no-op). A
   * rejected promise is logged and swallowed — an ingest outage must never kill
   * summaries for SDK sessions or previously-ingested content.
   */
  ingestTranscript?: (sessionId: string) => Promise<void>;
  /** Injectable clock (defaults to `Date.now`) so fake-timer tests control "now". */
  now?: () => number;
  logger?: LoggerLike;
}

/** Reason a summarize was attempted — only affects logging (plan §5). */
export type SessionSummaryTrigger = 'idle' | 'lazy-catchup';

interface ArmedTimer {
  timer: ReturnType<typeof setTimeout>;
  /** Wall-clock ms the timer was armed at, for the `updated_at` race guard. */
  armedAt: number;
}

interface FailureRecord {
  attemptedWatermark: number;
  lastAttemptAt: number;
  consecutiveFailures: number;
  suspended: boolean;
}

/** The scheduler's public surface (also the shape the wiring helper + tests depend on). */
export interface SessionSummarySchedulerLike {
  noteTurnEnd(sessionId: string): void;
  noteTurnStart(sessionId: string): void;
  maybeSummarizeNow(sessionId: string, reason: SessionSummaryTrigger): void;
  dispose(): void;
}

/**
 * Parse a `sessions.updated_at` value to epoch ms. SQLite's `CURRENT_TIMESTAMP`
 * / `datetime('now')` write `'YYYY-MM-DD HH:MM:SS'` with no zone indicator
 * (implicitly UTC); a real ISO string already carries `'T'`/`'Z'`/an offset.
 * Mirrors `segmentIntoSittings.parseTimestampMs`. Returns null on an
 * unparseable value so the race guard can treat it as "unknown" (no re-arm).
 */
function parseTimestampMs(timestamp: string): number | null {
  const looksIsoAlready =
    timestamp.includes('T') || timestamp.includes('Z') || /[+-]\d{2}:\d{2}$/.test(timestamp);
  const normalized = looksIsoAlready ? timestamp : `${timestamp}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

export function makeSessionSummaryScheduler(
  deps: SessionSummarySchedulerDeps,
): SessionSummarySchedulerLike {
  const now = deps.now ?? Date.now;
  const timers = new Map<string, ArmedTimer>();
  const inFlight = new Set<string>();
  const failures = new Map<string, FailureRecord>();
  /** Global concurrency cap of 1 — a simple promise-chain queue (plan §2.5). */
  let queue: Promise<void> = Promise.resolve();
  let disposed = false;

  function clearTimer(sessionId: string): void {
    const armed = timers.get(sessionId);
    if (armed) {
      clearTimeout(armed.timer);
      timers.delete(sessionId);
    }
  }

  function noteTurnEnd(sessionId: string): void {
    if (disposed) return;
    clearTimer(sessionId);
    const armedAt = now();
    const timer = setTimeout(() => {
      // The timer is spent — drop it before firing so a race-guard re-arm inside
      // fire() installs a fresh one rather than colliding with this entry.
      timers.delete(sessionId);
      fire(sessionId, 'idle', armedAt);
    }, SESSION_SUMMARY_IDLE_MS);
    timers.set(sessionId, { timer, armedAt });
  }

  function noteTurnStart(sessionId: string): void {
    // Never guarded by `disposed` — clearing a pending timer during teardown is
    // always safe (dispose() clears them all anyway), and this keeps the input
    // seam (§2.2) a pure no-op after shutdown.
    clearTimer(sessionId);
  }

  function maybeSummarizeNow(sessionId: string, reason: SessionSummaryTrigger): void {
    // Lazy catch-up (§2.7) bypasses the timer, so there is no arm timestamp and
    // the `updated_at` race guard is skipped (the turn-in-flight probe still
    // protects against summarizing a partial mid-turn transcript).
    fire(sessionId, reason, undefined);
  }

  /**
   * Run the SYNCHRONOUS gates (§2.8 eligibility, §2.3 state + race guard, §2.6
   * suspension, §2.5 per-session dedupe); if they survive, mark the session
   * in-flight and enqueue the async body behind the global cap-1 queue. `armedAt`
   * is set only for the idle-timer path (enables the race guard).
   *
   * The watermark read + sitting segmentation + retry cooldown live in `runFire`
   * (the async body), NOT here, so an optional transcript-ingest pre-read (the
   * PTY follow-up) can backfill `conversation_messages` BEFORE the delta is
   * computed. The in-flight dedupe stays synchronous and BEFORE the enqueue so
   * two triggers can never double-queue the same session.
   */
  function fire(sessionId: string, reason: SessionSummaryTrigger, armedAt: number | undefined): void {
    if (disposed) return;

    // §2.8 env kill switch + config toggle (both checked at fire time).
    if (process.env[KILL_SWITCH_ENV] === '1') return;
    if (!deps.isEnabled()) return;

    // §2.8 eligibility: exists / not archived / quick sentinel / Claude runtime.
    const session = deps.db.getSession(sessionId);
    if (!session) return;
    if (session.archived) return;
    if (session.chat_run_id === null || session.chat_run_id === undefined) return;
    // NULL provider ⇒ Claude default ⇒ eligible; only an explicit Codex session
    // is excluded (its turn lifecycle the scheduler does not observe — §2.8).
    if (session.agent_provider === 'codex') return;

    // §2.3 fire-time state gates.
    if (deps.isTurnInFlight(sessionId)) return;
    if (deps.hasOpenGate(sessionId)) return;

    // §2.3 race guard (idle path only): if the activity clock moved past the arm
    // timestamp (minus self-write tolerance), a turn happened after we armed —
    // re-arm and wait for its own turn-end rather than summarizing now.
    if (armedAt !== undefined) {
      const updatedAtMs = parseTimestampMs(session.updated_at);
      if (updatedAtMs !== null && updatedAtMs > armedAt + SESSION_SUMMARY_RACE_GUARD_TOLERANCE_MS) {
        noteTurnEnd(sessionId);
        return;
      }
    }

    // §2.6 suspension — a session with too many consecutive failures is parked
    // until app restart (the in-memory record is gone on the next boot).
    if (failures.get(sessionId)?.suspended) return;

    // §2.5 per-session dedupe (a refire while a call is in flight no-ops) — kept
    // synchronous and BEFORE the enqueue so ingest+watermark-read can move async
    // without ever double-queuing the session.
    if (inFlight.has(sessionId)) return;
    inFlight.add(sessionId);

    // §2.5 global cap of 1 — chain the async body; the sync gates above already ran.
    queue = queue.then(() => runFire(sessionId, reason));
  }

  /**
   * The async body behind the cap-1 queue: optional transcript-ingest pre-read →
   * §2.4 watermark read + sitting segmentation → §2.6 retry cooldown → the Haiku
   * call + persist. Owns the in-flight release for EVERY exit path (empty delta,
   * materiality floor, cooldown skip, success, error).
   */
  async function runFire(sessionId: string, reason: SessionSummaryTrigger): Promise<void> {
    try {
      if (disposed) return;

      // PTY follow-up: backfill the interactive session's transcript into
      // conversation_messages before the watermark read. A rejected promise is
      // logged and swallowed — continue on whatever rows are already in the DB
      // (an SDK session's ingest hook is an immediately-resolving no-op).
      if (deps.ingestTranscript) {
        try {
          await deps.ingestTranscript(sessionId);
        } catch (err) {
          deps.logger?.warn('[sessionSummaryScheduler] transcript ingest failed', {
            sessionId,
            reason,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (disposed) return;
      }

      // §2.4 content watermark + sitting segmentation.
      const previous = deps.db.getSessionSummary(sessionId);
      const watermark = previous?.last_turn_id ?? 0;
      const previousSummary = previous?.summary ?? '';
      const rows = deps.db.getConversationMessagesAfter(sessionId, watermark);
      if (rows.length === 0) return; // empty delta → silent no-op

      const messages: SummaryInputMessage[] = rows.map((row) => ({
        id: row.id,
        role: row.message_type,
        content: row.content,
        timestamp: row.timestamp,
      }));
      const segments = segmentIntoSittings(messages, SESSION_SUMMARY_IDLE_MS);
      const { newWatermark, billableSegments } = computeWatermarkStop(segments);
      // Materiality floor: no assistant-bearing segment → nothing to bill, watermark unchanged.
      if (billableSegments.length === 0) return;

      // §2.6 retry cooldown — keyed by the post-ingest target watermark. A new
      // turn edge moves `newWatermark` and so bypasses the cooldown automatically.
      const failure = failures.get(sessionId);
      if (
        failure &&
        failure.attemptedWatermark === newWatermark &&
        now() - failure.lastAttemptAt < SESSION_SUMMARY_RETRY_COOLDOWN_MS
      ) {
        return;
      }

      await runSummarize(sessionId, reason, previousSummary, billableSegments, newWatermark);
    } finally {
      inFlight.delete(sessionId);
    }
  }

  async function runSummarize(
    sessionId: string,
    reason: SessionSummaryTrigger,
    previousSummary: string,
    billableSegments: SummaryInputMessage[][],
    newWatermark: number,
  ): Promise<void> {
    try {
      if (disposed) return;
      const result = await deps.summarize({ previousSummary, segments: billableSegments });
      const persisted = deps.db.persistSessionSummaryResult({
        sessionId,
        summary: result.summary,
        lastTurnId: newWatermark,
        costUsdDelta: result.costUsd,
        entries: result.historySentences,
      });
      // Success (or a benign "session gone" false): clear the failure record so
      // the next delta is not gated by a stale cooldown.
      failures.delete(sessionId);
      if (!persisted) {
        deps.logger?.debug('[sessionSummaryScheduler] session gone before persist', { sessionId, reason });
      }
    } catch (err) {
      const prior = failures.get(sessionId);
      const consecutiveFailures = (prior?.consecutiveFailures ?? 0) + 1;
      failures.set(sessionId, {
        attemptedWatermark: newWatermark,
        lastAttemptAt: now(),
        consecutiveFailures,
        suspended: consecutiveFailures >= SESSION_SUMMARY_MAX_CONSECUTIVE_FAILURES,
      });
      deps.logger?.warn('[sessionSummaryScheduler] summarize failed', {
        sessionId,
        reason,
        attemptedWatermark: newWatermark,
        consecutiveFailures,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // NOTE: the in-flight release lives in `runFire`'s finally (it owns every
    // exit path), so this function must NOT touch `inFlight`.
  }

  function dispose(): void {
    disposed = true;
    for (const armed of timers.values()) clearTimeout(armed.timer);
    timers.clear();
  }

  return { noteTurnEnd, noteTurnStart, maybeSummarizeNow, dispose };
}
