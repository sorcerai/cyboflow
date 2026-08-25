/**
 * sessionSummaryQuery — the SDK boundary for the idle-gated quick-session
 * summarizer (plan §3, `docs/proposals/session-summary-plan.md`). One call
 * produces the rolling summary plus 1-3 history sentences from a segmented
 * delta transcript, cloning the one-shot pattern of `eval/evalJudgeQuery.ts` /
 * `programmatic/monitorQuery.ts` (value-loaded lazily via
 * `utils/lazyAgentSdk` so app boot never parses the SDK).
 *
 * ALL environment-coupled inputs are injected via {@link SessionSummarizerDeps}
 * (Codex finding #5 on the v1 review): the SDK query loader, the resolved
 * model id, and the resolved claude executable path. This module contains NO
 * imports from `services/*` — the orchestrator layering rule
 * (`orchestrator/quickSessionListing.ts:13-16` keeps the same discipline).
 * The wiring site (`main/src/index.ts`, services layer) resolves
 * `resolveModelAlias('haiku')` and `resolveClaudeExecutablePath()` and passes
 * the results in as plain values — a bare `'haiku'` string handed to the SDK
 * would NOT auto-resolve through the alias table.
 *
 * Single-shot STRING prompt (not streaming-input): a bounded, tool-free,
 * one-turn query with no interactive `canUseTool` — it needs no stdin held
 * open for control round-trips and terminates on its own once the model
 * replies. (Contrast `claudeCodeManager`'s flow turns, which MUST stream
 * input to keep an AskUserQuestion gate alive.)
 *
 * ⚠️ NOT live-verifiable headlessly (it makes a real Claude call).
 *
 * Explicit non-choices (plan §3): does NOT route through `AgentThreadService`
 * / `ClaudeCodeManager.spawnCliProcess` (a real session turn on the warm
 * machinery would bump `sessions.updated_at`, the activity clock this feature
 * must never touch); does NOT use the raw `@anthropic-ai/sdk` (a second,
 * unused auth path in `main/src`).
 */
import type { loadSdkQuery } from '../../utils/lazyAgentSdk';
import type { LoggerLike } from '../types';
import { clipDeltaForPrompt } from './clipDeltaForPrompt';
import type { SummaryInputMessage } from './segmentIntoSittings';

/** Hard per-call deadline. A hung claude binary must not stall the idle-timer / lazy-catchup caller. */
export const SESSION_SUMMARY_QUERY_TIMEOUT_MS = 60_000;

/** Max history sentences per call (plan §2.4) — older segments beyond this are pre-merged. */
const HISTORY_SENTENCE_CAP = 3;

/** All environment-coupled dependencies, injected by the services-layer wiring site. */
export interface SessionSummarizerDeps {
  /** Same shape as `utils/lazyAgentSdk.loadSdkQuery` — fakeable in tests, no real SDK import here. */
  sdkQueryLoader: typeof loadSdkQuery;
  /** A CONCRETE model id (e.g. `'claude-haiku-4-5'`) — already alias-resolved by the caller. */
  modelId: string;
  /** Packaged-build asar workaround; `undefined` in dev (SDK resolves from real node_modules). */
  claudeExecutablePath: string | undefined;
}

/** Input to a single summarize() call. */
export interface SessionSummarizerInput {
  /** The current rolling summary, or '' for a session that has never been summarized. */
  previousSummary: string;
  /** The delta, already segmented into sittings (oldest first) — see `segmentIntoSittings.ts`. */
  segments: SummaryInputMessage[][];
}

/** Output of a single summarize() call. */
export interface SessionSummarizerResult {
  /** 1-2 sentences, present tense. First sentence = the session's objective; optional second = current state. */
  summary: string;
  /** One past-tense sentence per billed sitting segment, oldest first (1..3 items). */
  historySentences: string[];
  /** `total_cost_usd` from the SDK `result` message (0 if absent). */
  costUsd: number;
}

/** The function `makeSessionSummarizer` returns. */
export type SessionSummarizeFn = (input: SessionSummarizerInput) => Promise<SessionSummarizerResult>;

/**
 * Bridge a caller's optional AbortSignal onto a fresh AbortController + a
 * deadline timer (copied from `evalJudgeQuery.ts` / `monitorQuery.ts` — this
 * file intentionally does not import across the eval/programmatic dirs for a
 * ~15-line local helper).
 */
function makeDeadline(timeoutMs: number): { controller: AbortController; didTimeOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  return {
    controller,
    didTimeOut: () => timedOut,
    cleanup: () => clearTimeout(timer),
  };
}

/** Concatenate the text blocks of an SDK assistant message (string or block[]). Mirrors monitorQuery.ts. */
function extractAssistantText(message: unknown): string {
  if (typeof message !== 'object' || message === null) return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

/** Strip an optional ```json ... ``` (or bare ```) fence wrapping the model's response. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

/** Parsed + validated shape of the model's JSON response. */
interface ParsedSummaryResponse {
  summary: string;
  historySentences: string[];
}

/**
 * Parse and validate the model's raw text response. Throws on anything
 * malformed — this module owns no retry policy, the scheduler does (plan
 * §2.6): a throw here means "this attempt failed", nothing more.
 */
function parseSummaryResponse(rawText: string): ParsedSummaryResponse {
  const jsonText = stripCodeFences(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(
      `session summary response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('session summary response is not a JSON object');
  }
  const obj = parsed as Record<string, unknown>;

  const summary = obj.summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('session summary response is missing a non-empty "summary" string');
  }

  const historyRaw = obj.history_sentences;
  if (!Array.isArray(historyRaw) || historyRaw.length < 1 || historyRaw.length > HISTORY_SENTENCE_CAP) {
    throw new Error(
      `session summary response "history_sentences" must be an array of 1..${HISTORY_SENTENCE_CAP} items`,
    );
  }
  const historySentences = historyRaw.map((item, i) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new Error(`session summary response "history_sentences[${i}]" must be a non-empty string`);
    }
    return item;
  });

  return { summary, historySentences };
}

/**
 * Merge the oldest segments down to `cap` total when a caller passes more
 * sittings than the model is asked to summarize per call (plan §2.4: "older
 * segments beyond the cap are merged into the first sentence"). Defensive —
 * the scheduler (commit-3) is expected to already respect the cap via
 * `computeWatermarkStop`, but this module must not silently drop a segment if
 * it doesn't.
 */
function mergeSegmentsToCap(
  segments: readonly SummaryInputMessage[][],
  cap: number,
): { segments: SummaryInputMessage[][]; mergedCount: number } {
  if (segments.length <= cap) {
    return { segments: segments.map((segment) => [...segment]), mergedCount: 0 };
  }
  const mergeCount = segments.length - cap + 1;
  const mergedFirst = segments.slice(0, mergeCount).flat();
  const rest = segments.slice(mergeCount).map((segment) => [...segment]);
  return { segments: [mergedFirst, ...rest], mergedCount: mergeCount };
}

/** Re-split a flat, order-preserved message list back into segments of the given lengths. */
function reGroupByLengths(
  flat: readonly SummaryInputMessage[],
  lengths: readonly number[],
): SummaryInputMessage[][] {
  const grouped: SummaryInputMessage[][] = [];
  let offset = 0;
  for (const length of lengths) {
    grouped.push(flat.slice(offset, offset + length));
    offset += length;
  }
  return grouped;
}

function formatMessageBlock(message: SummaryInputMessage): string {
  const label = message.role === 'user' ? 'USER' : 'ASSISTANT';
  return `${label}: ${message.content}`;
}

/**
 * Build the single prompt string: previous rolling summary + the delta
 * transcript with explicit `--- SITTING N ---` markers, `USER:`/`ASSISTANT:`
 * blocks, capped to `HISTORY_SENTENCE_CAP` sittings (merging older ones into
 * the first) and clipped via `clipDeltaForPrompt`.
 */
function buildPrompt(previousSummary: string, rawSegments: readonly SummaryInputMessage[][]): string {
  const { segments: cappedSegments, mergedCount } = mergeSegmentsToCap(rawSegments, HISTORY_SENTENCE_CAP);

  const lengths = cappedSegments.map((segment) => segment.length);
  const clippedFlat = clipDeltaForPrompt(cappedSegments.flat());
  const clippedSegments = reGroupByLengths(clippedFlat, lengths);

  const transcriptBlocks = clippedSegments.map((segment, i) => {
    const body = segment.map(formatMessageBlock).join('\n');
    return `--- SITTING ${i + 1} ---\n${body}`;
  });

  const mergeNote =
    mergedCount > 0
      ? ` SITTING 1 below actually merges ${mergedCount} earlier sittings that happened before the ones shown separately — write ONE sentence for it that covers all of them together.`
      : '';

  return [
    'You are maintaining a rolling summary and a per-sitting history for an ongoing coding chat session.',
    '',
    'Previous rolling summary (empty for a session summarized for the first time):',
    previousSummary.length > 0 ? previousSummary : '(none yet)',
    '',
    `The delta transcript below is split into ${clippedSegments.length} "sitting" segment(s) — bursts of` +
      ` activity separated by an idle gap — oldest first.${mergeNote}`,
    '',
    ...transcriptBlocks,
    '',
    'Respond with EXACTLY ONE JSON object and nothing else — no prose outside the object (a ```json fence',
    'around the whole object is fine, but no extra text before or after it):',
    '{"summary": "<1-2 sentences, present tense>",',
    ' "history_sentences": ["<one past-tense sentence per sitting segment above, oldest first>"]}',
    'The FIRST sentence of "summary" MUST state the session\'s objective — what the user is trying to',
    'build or achieve overall (e.g. "Working on a prototype of a dynamic background."), carrying the',
    'objective forward from the previous rolling summary unless the delta shows it changed. The optional',
    'second sentence gives the current state of that work.',
    `Return EXACTLY ${clippedSegments.length} item(s) in "history_sentences", one per sitting segment shown` +
      ` above in the same order. NEVER return more than ${HISTORY_SENTENCE_CAP} items.`,
  ].join('\n');
}

/**
 * Build the production summarizer. All environment-coupled state lives in
 * `deps`; `logger` and `timeoutMs` are optional (the latter primarily so
 * tests can pin a short deadline instead of waiting out the real 60s).
 */
export function makeSessionSummarizer(
  deps: SessionSummarizerDeps,
  logger?: LoggerLike,
  timeoutMs: number = SESSION_SUMMARY_QUERY_TIMEOUT_MS,
): SessionSummarizeFn {
  return async function summarize(input: SessionSummarizerInput): Promise<SessionSummarizerResult> {
    if (input.segments.length === 0 || input.segments.every((segment) => segment.length === 0)) {
      throw new Error('sessionSummaryQuery: segments must contain at least one message');
    }

    const { controller, didTimeOut, cleanup } = makeDeadline(timeoutMs);
    try {
      const prompt = buildPrompt(input.previousSummary, input.segments);
      const query = await deps.sdkQueryLoader();
      const q = query({
        prompt,
        options: {
          maxTurns: 1,
          allowedTools: [],
          model: deps.modelId,
          pathToClaudeCodeExecutable: deps.claudeExecutablePath,
          abortController: controller,
        },
      });

      let assistantText = '';
      let costUsd = 0;
      let resultErrorMessage: string | null = null;

      // The SDK surfaces a failed run by THROWING out of the iterator (it
      // replaces the exit error with the error-result text, e.g. "Claude Code
      // returned an error result: Reached maximum number of turns (1)"), so the
      // `msg.subtype` branch below is not the only failure path — and an
      // uncaught throw here would discard assistantText we may already hold in
      // full. Capture it and decide after the loop.
      let streamError: unknown = null;
      try {
        for await (const msg of q) {
          if (msg.type === 'assistant') {
            const text = extractAssistantText(msg.message);
            if (text.length > 0) assistantText = text;
          } else if (msg.type === 'result') {
            costUsd = typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0;
            if (msg.subtype !== 'success') {
              resultErrorMessage = `session summary query returned a non-success result (${msg.subtype})`;
            }
          }
        }
      } catch (err) {
        streamError = err;
      }

      const failure = streamError
        ? streamError instanceof Error
          ? streamError.message
          : String(streamError)
        : didTimeOut()
          ? `session summary query timed out after ${timeoutMs}ms`
          : resultErrorMessage;

      if (failure && assistantText.length === 0) {
        throw new Error(failure);
      }
      if (assistantText.length === 0) {
        throw new Error('session summary query produced no assistant text');
      }

      // Salvage: a run can end in an error (a turn-cap overrun, an abort) after
      // the model has already emitted its complete answer. parseSummaryResponse
      // is strict — it only returns for well-formed, fully-populated JSON — so
      // clearing it means the response IS complete, whatever ended the stream.
      // A truncated one fails to parse and we rethrow the original cause below,
      // which is the right verdict.
      let parsed: ParsedSummaryResponse;
      try {
        parsed = parseSummaryResponse(assistantText);
      } catch (parseErr) {
        if (failure) throw new Error(failure);
        throw parseErr;
      }
      if (failure) {
        logger?.warn('[sessionSummaryQuery] recovered a complete summary from a failed run', {
          error: failure,
        });
      }
      return { summary: parsed.summary, historySentences: parsed.historySentences, costUsd };
    } catch (err) {
      const message = didTimeOut()
        ? `session summary query timed out after ${timeoutMs}ms`
        : err instanceof Error
          ? err.message
          : String(err);
      logger?.warn('[sessionSummaryQuery] summarize failed', { error: message });
      throw new Error(message);
    } finally {
      cleanup();
    }
  };
}
