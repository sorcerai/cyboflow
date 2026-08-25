/**
 * transcriptSearch — PURE text extraction + excerpting over the global-agent's
 * durable transcript rows (`agent_thread_events`), backing the
 * `cyboflow_history` MCP tool (mcpQueryHandler's `mcp-history`).
 *
 * WHY THIS EXISTS. The assistant's LIVE SDK context is reset daily (the
 * day-boundary retention strategy in AgentThreadService), but every turn it has
 * ever exchanged with the user is kept forever in `agent_thread_events`. Those
 * rows are therefore the assistant's LONG-TERM MEMORY, and the only thing
 * standing between it and them is a `payload_json` blob per row. This module is
 * the decoder: row → `{ role, text }`, or `null` when the row carries no
 * human-readable turn text at all.
 *
 * FOUR PERSISTED SHAPES reach this decoder (see
 * `services/streamParser/derivers.ts` for the event_type mapping that produces
 * them, and `agentThreadEventsSink.ts` for the single writer):
 *
 *   'user'            ClaudeStreamEvent UserEvent — `message.content` is an
 *                     ARRAY. The human's OWN typed turns arrive here as
 *                     SYNTHETIC events with exactly one text block
 *                     (`buildUserTextEvent`, programmatic/syntheticEvents.ts).
 *                     Every OTHER 'user' row is SDK tool_result plumbing with
 *                     no text block whatsoever — those decode to null and the
 *                     caller must skip them, or the transcript reads as a wall
 *                     of tool noise.
 *   'assistant'       ClaudeStreamEvent AssistantEvent — `message.content`
 *                     mixes text / tool_use / thinking blocks; ONLY the text
 *                     blocks are the reply, joined with newlines.
 *   'agent_user' /    Provider-neutral AgentUserMessageEvent /
 *   'agent_assistant' AgentAssistantMessageEvent (shared/types/agentStream.ts):
 *                     `{ type:'agent_message', role, content }` with the blocks
 *                     at TOP LEVEL, not under `message`. Defensive support —
 *                     the assistant runs on Claude today, but the sink is
 *                     provider-neutral and would persist these unchanged the
 *                     day it does not.
 *
 * ROLE COMES FROM THE EVENT TYPE, never from the payload: the event_type column
 * is what the SQL filter selects on, so deriving role from anything else could
 * disagree with the row set the query returned.
 *
 * PURE + standalone: no electron, no better-sqlite3, no DB types. Everything
 * here is total — malformed JSON, a missing `content`, an unexpected block
 * shape and an unknown event_type all resolve to `null` rather than throwing,
 * because a single corrupt legacy row must never break a memory search.
 */

/** The two turn roles a transcript row can decode to. */
export type TranscriptRole = 'user' | 'assistant';

/** One decoded transcript turn: who spoke, and the joined text they spoke. */
export interface TranscriptTurn {
  role: TranscriptRole;
  text: string;
}

/**
 * Half-width of a search excerpt, in UTF-16 code units. The window spans
 * `[matchIndex - EXCERPT_RADIUS, matchIndex + EXCERPT_RADIUS)`, i.e. ~700 chars
 * total around the first match.
 */
export const EXCERPT_RADIUS = 350;

/**
 * Browse-mode (no query) per-turn text budget: the HEAD of the turn, so the
 * listing reads like the opening of each message rather than a random slice.
 * Deliberately the same order of magnitude as a search excerpt so a page of
 * either mode costs the caller roughly the same tokens.
 */
export const TURN_TEXT_MAX_CHARS = 700;

/** The ellipsis marker appended/prepended when text was clipped. */
const ELLIPSIS = '…';

/** event_type → role. Anything else is not a conversational turn at all. */
function roleForEventType(eventType: string): TranscriptRole | null {
  switch (eventType) {
    case 'user':
    case 'agent_user':
      return 'user';
    case 'assistant':
    case 'agent_assistant':
      return 'assistant';
    default:
      return null;
  }
}

/**
 * Pull the content field out of either persisted shape: Claude's nested
 * `message.content`, or the provider-neutral `agent_message`'s TOP-LEVEL
 * `content`. Claude's nesting is checked first — an event carrying both would
 * be a Claude event, and its `message` is the authoritative half.
 */
function readContent(payload: Record<string, unknown>): unknown {
  const message = payload['message'];
  if (typeof message === 'object' && message !== null && 'content' in message) {
    return (message as Record<string, unknown>)['content'];
  }
  return payload['content'];
}

/**
 * Join the text of a content field. A bare string IS the text (the Anthropic
 * wire format permits `content: "…"` in place of a block array). An array
 * contributes only its `{type:'text', text}` blocks, newline-joined — tool_use,
 * tool_result and thinking blocks are deliberately dropped, so an
 * all-plumbing event yields ''. Anything else yields ''.
 */
function joinTextBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] !== 'text') continue;
    const text = record['text'];
    if (typeof text === 'string' && text.length > 0) parts.push(text);
  }
  return parts.join('\n');
}

/**
 * Decode one `agent_thread_events` row into a conversational turn, or `null`
 * when the row carries none — an unknown event_type, unparseable JSON, a
 * non-object payload, a missing/foreign `content`, or (the common case) an
 * event whose blocks are pure tool plumbing with no text in them.
 *
 * Total by construction: this is called once per scanned row inside the
 * history handler's paging loop, where one throw would abort an otherwise
 * healthy search.
 */
export function extractTurnText(
  eventType: string,
  payloadJson: string,
): TranscriptTurn | null {
  const role = roleForEventType(eventType);
  if (role === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const text = joinTextBlocks(readContent(parsed as Record<string, unknown>));
  if (text.trim().length === 0) return null;
  return { role, text };
}

/** True when `code` is a UTF-16 low surrogate (the tail half of a pair). */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Window ~`2 * radius` characters of `text` around `matchIndex`, marking each
 * clipped end with an ellipsis.
 *
 * Both cut points are nudged onto WHOLE-CHARACTER boundaries so an astral
 * character (emoji, CJK extension, …) is never sliced through the middle of its
 * surrogate pair — a lone surrogate would survive `JSON.stringify` as a `\udXXX`
 * escape and render as a replacement glyph in the excerpt.
 */
export function excerptAround(
  text: string,
  matchIndex: number,
  radius: number = EXCERPT_RADIUS,
): string {
  const anchor = Math.max(0, Math.min(matchIndex, text.length));
  let start = Math.max(0, anchor - radius);
  let end = Math.min(text.length, anchor + radius);

  // `start` landing on a low surrogate means its high half sits just before —
  // step back to keep the pair whole.
  if (start > 0 && isLowSurrogate(text.charCodeAt(start))) start -= 1;
  // `end` is exclusive: a low surrogate AT `end` means we would orphan the high
  // half at `end - 1` — extend by one to keep the pair whole.
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end += 1;

  const body = text.slice(start, end);
  return `${start > 0 ? ELLIPSIS : ''}${body}${end < text.length ? ELLIPSIS : ''}`;
}

/**
 * Browse-mode clip: the first `maxChars` of a turn, ellipsis-marked when
 * anything was dropped. Same whole-character guard as {@link excerptAround}.
 */
export function truncateHead(text: string, maxChars: number = TURN_TEXT_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (end < text.length && isLowSurrogate(text.charCodeAt(end))) end += 1;
  return `${text.slice(0, end)}${ELLIPSIS}`;
}
