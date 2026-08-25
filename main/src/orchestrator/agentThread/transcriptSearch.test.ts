/**
 * Unit tests for transcriptSearch — the pure decoder behind `cyboflow_history`.
 *
 * The load-bearing cases are the two that are easy to get wrong and expensive
 * when wrong: a tool_result-only 'user' row (SDK plumbing — MUST decode to null,
 * or the assistant's memory fills with tool noise instead of the human's words)
 * and an assistant row that mixes text with tool_use blocks (ONLY the text is
 * the reply). Fixtures are built from the REAL producers where one exists
 * (`buildUserTextEvent` / `buildAssistantTextEvent`) so a shape change there
 * fails here rather than silently degrading the search.
 */
import { describe, it, expect } from 'vitest';
import {
  extractTurnText,
  excerptAround,
  truncateHead,
  EXCERPT_RADIUS,
  TURN_TEXT_MAX_CHARS,
} from './transcriptSearch';
import { buildUserTextEvent, buildAssistantTextEvent } from '../programmatic/syntheticEvents';

describe('extractTurnText', () => {
  it("decodes the human's synthetic user turn (buildUserTextEvent) as role 'user'", () => {
    const payload = JSON.stringify(buildUserTextEvent('what did we decide about the release?'));
    expect(extractTurnText('user', payload)).toEqual({
      role: 'user',
      text: 'what did we decide about the release?',
    });
  });

  it('decodes an assistant turn built by the real synthetic producer', () => {
    const payload = JSON.stringify(buildAssistantTextEvent('we shipped 0.2.5 on Friday'));
    expect(extractTurnText('assistant', payload)).toEqual({
      role: 'assistant',
      text: 'we shipped 0.2.5 on Friday',
    });
  });

  it('keeps ONLY the text blocks of a mixed text + tool_use assistant event, newline-joined', () => {
    const payload = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking the backlog.' },
          { type: 'tool_use', id: 'tu_1', name: 'cyboflow_backlog', input: {} },
          { type: 'thinking', thinking: 'internal monologue' },
          { type: 'text', text: 'Two ideas are still open.' },
        ],
      },
    });
    expect(extractTurnText('assistant', payload)).toEqual({
      role: 'assistant',
      text: 'Checking the backlog.\nTwo ideas are still open.',
    });
  });

  it('returns null for a tool_result-only user event (SDK plumbing, no extractable text)', () => {
    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'rows: 12' }],
      },
    });
    expect(extractTurnText('user', payload)).toBeNull();
  });

  it('returns null for an assistant event whose content is pure tool_use', () => {
    const payload = JSON.stringify({
      type: 'assistant',
      message: {
        id: 'msg_2',
        model: 'claude',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_2', name: 'cyboflow_queue', input: {} }],
      },
    });
    expect(extractTurnText('assistant', payload)).toBeNull();
  });

  it('accepts a bare STRING content in place of a block array', () => {
    const payload = JSON.stringify({ type: 'user', message: { role: 'user', content: 'plain string turn' } });
    expect(extractTurnText('user', payload)).toEqual({ role: 'user', text: 'plain string turn' });
  });

  it("decodes the provider-neutral agent_message shapes (TOP-LEVEL content, not message.content)", () => {
    const userPayload = JSON.stringify({
      type: 'agent_message',
      role: 'user',
      content: [{ type: 'text', text: 'ask from a non-Claude provider' }],
    });
    expect(extractTurnText('agent_user', userPayload)).toEqual({
      role: 'user',
      text: 'ask from a non-Claude provider',
    });

    const assistantPayload = JSON.stringify({
      type: 'agent_message',
      role: 'assistant',
      id: 'am_1',
      model: 'gpt',
      content: [
        { type: 'text', text: 'first' },
        { type: 'tool_call', id: 'tc_1', name: 'x' },
        { type: 'text', text: 'second' },
      ],
    });
    expect(extractTurnText('agent_assistant', assistantPayload)).toEqual({
      role: 'assistant',
      text: 'first\nsecond',
    });
  });

  it('derives the role from the EVENT TYPE, not from the payload role field', () => {
    // A payload whose own role disagrees with its persisted event_type: the
    // event_type wins, because that is what the SQL filter selected on.
    const payload = JSON.stringify({
      type: 'agent_message',
      role: 'assistant',
      content: [{ type: 'text', text: 'mismatched' }],
    });
    expect(extractTurnText('agent_user', payload)).toEqual({ role: 'user', text: 'mismatched' });
  });

  it('returns null for malformed JSON', () => {
    expect(extractTurnText('user', '{not json')).toBeNull();
    expect(extractTurnText('assistant', '')).toBeNull();
  });

  it('returns null for a non-object payload, a missing content, and an out-of-scope event_type', () => {
    expect(extractTurnText('user', '"just a string"')).toBeNull();
    expect(extractTurnText('user', '[1,2,3]')).toBeNull();
    expect(extractTurnText('assistant', JSON.stringify({ type: 'assistant', message: { role: 'assistant' } }))).toBeNull();
    expect(extractTurnText('system', JSON.stringify(buildUserTextEvent('hello')))).toBeNull();
    expect(extractTurnText('result', JSON.stringify(buildUserTextEvent('hello')))).toBeNull();
  });

  it('returns null for a whitespace-only turn', () => {
    expect(extractTurnText('user', JSON.stringify(buildUserTextEvent('   \n  ')))).toBeNull();
  });
});

describe('excerptAround', () => {
  it('returns the whole text unmarked when it fits inside the window', () => {
    expect(excerptAround('short text', 6)).toBe('short text');
  });

  it('windows ~2x the radius around the match and marks both clipped ends', () => {
    const text = `${'a'.repeat(1000)}NEEDLE${'b'.repeat(1000)}`;
    const excerpt = excerptAround(text, 1000);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).toContain('NEEDLE');
    // 2 * radius of body, plus the two ellipsis markers.
    expect(excerpt.length).toBe(2 * EXCERPT_RADIUS + 2);
  });

  it('marks only the trailing end when the match sits at the head', () => {
    const text = `NEEDLE${'b'.repeat(1000)}`;
    const excerpt = excerptAround(text, 0);
    expect(excerpt.startsWith('NEEDLE')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('marks only the leading end when the match sits at the tail', () => {
    const text = `${'a'.repeat(1000)}NEEDLE`;
    const excerpt = excerptAround(text, 1000);
    expect(excerpt.startsWith('…')).toBe(true);
    expect(excerpt.endsWith('NEEDLE')).toBe(true);
  });

  it('honours an explicit radius', () => {
    const text = `${'a'.repeat(100)}X${'b'.repeat(100)}`;
    expect(excerptAround(text, 100, 10)).toBe(`…${'a'.repeat(10)}X${'b'.repeat(9)}…`);
  });

  it('never splits an astral character across the window boundary', () => {
    // Each 🙂 is a surrogate PAIR (2 UTF-16 units); a naive slice at an odd
    // offset would emit a lone surrogate.
    const text = `${'🙂'.repeat(400)}NEEDLE${'🙃'.repeat(400)}`;
    const excerpt = excerptAround(text, text.indexOf('NEEDLE'));
    expect(excerpt).toContain('NEEDLE');
    for (const code of Array.from(excerpt).map((c) => c.codePointAt(0) ?? 0)) {
      expect(code >= 0xd800 && code <= 0xdfff).toBe(false);
    }
  });

  it('clamps an out-of-range match index instead of throwing', () => {
    expect(excerptAround('abc', -50)).toBe('abc');
    expect(excerptAround('abc', 9999)).toBe('abc');
  });
});

describe('truncateHead', () => {
  it('returns short text unchanged', () => {
    expect(truncateHead('hello')).toBe('hello');
  });

  it('keeps the HEAD of a long turn and marks the clip', () => {
    const text = 'x'.repeat(TURN_TEXT_MAX_CHARS + 50);
    const clipped = truncateHead(text);
    expect(clipped).toBe(`${'x'.repeat(TURN_TEXT_MAX_CHARS)}…`);
  });

  it('never splits an astral character at the clip point', () => {
    // An odd budget lands mid-pair; the guard extends by one unit.
    const clipped = truncateHead('🙂'.repeat(10), 5);
    expect(clipped).toBe('🙂🙂🙂…');
  });
});
