/**
 * Unit tests for sessionSummaryQuery — the session-summarizer's SINGLE
 * `@anthropic-ai/claude-agent-sdk` boundary. Mirrors
 * eval/__tests__/evalJudgeQuery.test.ts / programmatic/__tests__/monitorQuery.test.ts:
 * the SDK `query` is mocked so the wrapper is exercised against a canned async
 * generator (no real claude subprocess). `deps.sdkQueryLoader` is wired to the
 * REAL `utils/lazyAgentSdk.loadSdkQuery` (unmocked) so the mocked dynamic import
 * of `@anthropic-ai/claude-agent-sdk` is exercised exactly as production uses it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  makeFakeQuery,
  makeRejectingQuery,
  makeBlockUntilAbortQuery,
  sdkAssistantText,
  sdkResultSuccess,
  sdkResultError,
  type FakeQueryFn,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));

import { loadSdkQuery } from '../../../utils/lazyAgentSdk';
import {
  makeSessionSummarizer,
  SESSION_SUMMARY_QUERY_TIMEOUT_MS,
  type SessionSummarizerDeps,
} from '../sessionSummaryQuery';
import type { SummaryInputMessage } from '../segmentIntoSittings';

let lastOptions: unknown;
let lastPrompt: string | undefined;

/** Point the mocked `query()` at a shared fakeSdk `FakeQueryFn`, capturing options + prompt. */
function install(fn: FakeQueryFn): void {
  queryMock.mockImplementation((params: FakeQueryParams) => {
    lastOptions = params.options;
    lastPrompt = typeof params.prompt === 'string' ? params.prompt : undefined;
    return fn(params);
  });
}

function yieldsMessages(messages: readonly SDKMessage[]): void {
  install(makeFakeQuery(messages));
}

beforeEach(() => {
  queryMock.mockReset();
  lastOptions = undefined;
  lastPrompt = undefined;
});

function msg(id: number, role: 'user' | 'assistant', content: string): SummaryInputMessage {
  return { id, role, content, timestamp: '2026-01-01T00:00:00.000Z' };
}

function baseDeps(overrides: Partial<SessionSummarizerDeps> = {}): SessionSummarizerDeps {
  return {
    sdkQueryLoader: loadSdkQuery,
    modelId: 'claude-haiku-4-5',
    claudeExecutablePath: '/fake/claude',
    ...overrides,
  };
}

describe('makeSessionSummarizer', () => {
  it('parses a happy-path JSON response', async () => {
    yieldsMessages([
      sdkAssistantText('{"summary": "Working on X.", "history_sentences": ["Implemented X."]}'),
      sdkResultSuccess({ totalCostUsd: 0.002 }),
    ]);
    const summarize = makeSessionSummarizer(baseDeps());

    const result = await summarize({
      previousSummary: '',
      segments: [[msg(1, 'user', 'do X'), msg(2, 'assistant', 'done')]],
    });

    expect(result.summary).toBe('Working on X.');
    expect(result.historySentences).toEqual(['Implemented X.']);
    expect(result.costUsd).toBe(0.002);
  });

  it('strips a ```json fence around the response', async () => {
    yieldsMessages([
      sdkAssistantText('```json\n{"summary": "S.", "history_sentences": ["H."]}\n```'),
      sdkResultSuccess(),
    ]);
    const summarize = makeSessionSummarizer(baseDeps());

    const result = await summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] });

    expect(result.summary).toBe('S.');
    expect(result.historySentences).toEqual(['H.']);
  });

  it('strips a bare (unlabeled) code fence around the response', async () => {
    yieldsMessages([sdkAssistantText('```\n{"summary": "S.", "history_sentences": ["H."]}\n```'), sdkResultSuccess()]);
    const summarize = makeSessionSummarizer(baseDeps());

    const result = await summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] });

    expect(result.summary).toBe('S.');
  });

  it('throws on non-JSON assistant text', async () => {
    yieldsMessages([sdkAssistantText('sure, here is a summary of the session'), sdkResultSuccess()]);
    const summarize = makeSessionSummarizer(baseDeps());

    await expect(summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] })).rejects.toThrow();
  });

  it('throws when "summary" is missing or empty', async () => {
    yieldsMessages([sdkAssistantText('{"summary": "", "history_sentences": ["H."]}'), sdkResultSuccess()]);
    const summarize = makeSessionSummarizer(baseDeps());

    await expect(
      summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] }),
    ).rejects.toThrow(/summary/);
  });

  it('throws when "history_sentences" is missing, empty, or over the 3-item cap', async () => {
    yieldsMessages([sdkAssistantText('{"summary": "S.", "history_sentences": []}'), sdkResultSuccess()]);
    const summarize = makeSessionSummarizer(baseDeps());

    await expect(
      summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] }),
    ).rejects.toThrow(/history_sentences/);
  });

  /**
   * A query that yields `messages` and THEN rejects — the shape the real SDK
   * produces when a run ends in an error result after the model already spoke
   * (it replaces the exit error with the error-result text and throws out of
   * the iterator, so the terminal `result` message is never delivered).
   */
  function yieldsThenRejects(messages: readonly SDKMessage[], error: Error): void {
    install(function* stubbornQuery() {
      for (const m of messages) yield m;
      throw error;
    } as unknown as FakeQueryFn);
  }

  it('salvages a complete summary when the iterator throws after the model answered', async () => {
    // The observed production case: maxTurns:1 overruns, the SDK throws, and the
    // fully-formed JSON the model already emitted used to be discarded.
    yieldsThenRejects(
      [sdkAssistantText('{"summary": "S.", "history_sentences": ["H."]}')],
      new Error('Claude Code returned an error result: Reached maximum number of turns (1)'),
    );
    const summarize = makeSessionSummarizer(baseDeps());

    await expect(
      summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] }),
    ).resolves.toMatchObject({ summary: 'S.', historySentences: ['H.'] });
  });

  it('salvages a complete summary from a non-success terminal result', async () => {
    yieldsMessages([
      sdkAssistantText('{"summary": "S.", "history_sentences": ["H."]}'),
      sdkResultError({ subtype: 'error_max_turns' }),
    ]);
    const summarize = makeSessionSummarizer(baseDeps());

    await expect(
      summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] }),
    ).resolves.toMatchObject({ summary: 'S.', historySentences: ['H.'] });
  });

  it('rethrows the original failure when the salvaged text is incomplete', async () => {
    // Truncated JSON must NOT be papered over; the run-ending error is the
    // honest verdict and the scheduler's retry is the right response.
    yieldsThenRejects(
      [sdkAssistantText('{"summary": "S.", "history_sen')],
      new Error('Reached maximum number of turns (1)'),
    );
    const summarize = makeSessionSummarizer(baseDeps());

    await expect(
      summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] }),
    ).rejects.toThrow(/maximum number of turns/);
  });

  it('throws when the SDK iterator itself throws', async () => {
    install(makeRejectingQuery(new Error('sdk boom')));
    const summarize = makeSessionSummarizer(baseDeps());

    await expect(
      summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] }),
    ).rejects.toThrow('sdk boom');
  });

  it('throws when the SDK result is a non-success terminal (e.g. error_max_turns)', async () => {
    yieldsMessages([sdkAssistantText('still thinking'), sdkResultError({ subtype: 'error_max_turns' })]);
    const summarize = makeSessionSummarizer(baseDeps());

    await expect(
      summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] }),
    ).rejects.toThrow(/non-success/);
  });

  it('aborts and throws on the deadline', async () => {
    install(makeBlockUntilAbortQuery());
    const summarize = makeSessionSummarizer(baseDeps(), undefined, 5);

    await expect(
      summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] }),
    ).rejects.toThrow(/timed out after 5ms/);
  });

  it('extracts total_cost_usd from the result message', async () => {
    yieldsMessages([
      sdkAssistantText('{"summary": "S.", "history_sentences": ["H."]}'),
      sdkResultSuccess({ totalCostUsd: 0.0031 }),
    ]);
    const summarize = makeSessionSummarizer(baseDeps());

    const result = await summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] });

    expect(result.costUsd).toBe(0.0031);
  });

  it('defaults costUsd to 0 when the result carries no cost', async () => {
    yieldsMessages([sdkAssistantText('{"summary": "S.", "history_sentences": ["H."]}'), sdkResultSuccess()]);
    const summarize = makeSessionSummarizer(baseDeps());

    const result = await summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] });

    expect(result.costUsd).toBe(0);
  });

  it('passes the resolved modelId VERBATIM plus maxTurns 1, no tools, no cwd, and the executable path', async () => {
    yieldsMessages([sdkAssistantText('{"summary": "S.", "history_sentences": ["H."]}'), sdkResultSuccess()]);
    const summarize = makeSessionSummarizer(
      baseDeps({ modelId: 'claude-haiku-4-5', claudeExecutablePath: '/exe/claude' }),
    );

    await summarize({ previousSummary: '', segments: [[msg(1, 'assistant', 'hi')]] });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.model).toBe('claude-haiku-4-5');
    expect(opts.maxTurns).toBe(1);
    expect(opts.allowedTools).toEqual([]);
    expect(opts.pathToClaudeCodeExecutable).toBe('/exe/claude');
    expect('cwd' in opts).toBe(false);
    expect(opts.abortController).toBeInstanceOf(AbortController);
  });

  it('merges segments beyond the 3-sitting cap into the first sitting and notes the merge in the prompt', async () => {
    yieldsMessages([
      sdkAssistantText('{"summary": "S.", "history_sentences": ["merged", "b", "c"]}'),
      sdkResultSuccess(),
    ]);
    const summarize = makeSessionSummarizer(baseDeps());
    const segments = [
      [msg(1, 'assistant', 'sitting one')],
      [msg(2, 'assistant', 'sitting two')],
      [msg(3, 'assistant', 'sitting three')],
      [msg(4, 'assistant', 'sitting four')],
      [msg(5, 'assistant', 'sitting five')],
    ];

    const result = await summarize({ previousSummary: '', segments });

    expect(result.historySentences).toHaveLength(3);
    expect(lastPrompt).toBeDefined();
    const prompt = lastPrompt as string;
    expect((prompt.match(/--- SITTING \d+ ---/g) ?? []).length).toBe(3);
    expect(prompt).toContain('merges 3 earlier sittings');
  });

  it('does not merge or note anything when segments are already at or under the cap', async () => {
    yieldsMessages([
      sdkAssistantText('{"summary": "S.", "history_sentences": ["a", "b"]}'),
      sdkResultSuccess(),
    ]);
    const summarize = makeSessionSummarizer(baseDeps());
    const segments = [[msg(1, 'assistant', 'sitting one')], [msg(2, 'assistant', 'sitting two')]];

    await summarize({ previousSummary: '', segments });

    const prompt = lastPrompt as string;
    expect((prompt.match(/--- SITTING \d+ ---/g) ?? []).length).toBe(2);
    expect(prompt).not.toContain('merges');
  });

  it('includes the previous rolling summary verbatim in the prompt', async () => {
    yieldsMessages([sdkAssistantText('{"summary": "S.", "history_sentences": ["H."]}'), sdkResultSuccess()]);
    const summarize = makeSessionSummarizer(baseDeps());

    await summarize({
      previousSummary: 'Session was refactoring the auth module.',
      segments: [[msg(1, 'assistant', 'hi')]],
    });

    expect(lastPrompt).toContain('Session was refactoring the auth module.');
  });

  it('throws when called with no segments at all', async () => {
    const summarize = makeSessionSummarizer(baseDeps());
    await expect(summarize({ previousSummary: '', segments: [] })).rejects.toThrow(/segments/);
  });

  it('exports the 60s default deadline', () => {
    expect(SESSION_SUMMARY_QUERY_TIMEOUT_MS).toBe(60_000);
  });
});
