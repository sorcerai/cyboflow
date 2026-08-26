/**
 * Unit tests for pairwiseJudgeQuery — the A/B pairwise judge's SINGLE
 * `@anthropic-ai/claude-agent-sdk` boundary. Mirrors
 * eval/__tests__/evalJudgeQuery.test.ts: the SDK `query` is mocked so the
 * structured-query wrapper is exercised with a canned async generator (no real
 * claude subprocess). These tests pin the typed-timeout / plain-Error split the
 * worker's retry-once contract depends on (see pairwiseJudgeWorker.test.ts).
 *
 * This file is a SIBLING of the source (not under __tests__/), so the relative
 * mock/import paths are one level shallower than evalJudgeQuery.test.ts's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  makeFakeQuery,
  makeRejectingQuery,
  makeBlockUntilAbortQuery,
  makeRejectOnAbortQuery,
  sdkAssistantText,
  sdkResultError,
  sdkResultSuccess,
  type FakeQueryFn,
  type FakeQueryParams,
} from '../../test/fakes/fakeSdk';
import { EvalJudgeMaxTurnsError, EvalJudgeTimeoutError, isDeterministicJudgeFailure } from './judgeErrors';

/**
 * A FakeQueryFn that ignores the deadline's AbortController entirely and simply
 * takes `delayMs` of real wall-clock time before completing with NO messages.
 *
 * Mechanics only — it reaches the SAME post-drain `if (didTimeOut())` guard that
 * `makeBlockUntilAbortQuery` does; it differs in WHAT ends the stream (its own
 * timer, not the observed abort), not in which production branch runs. The
 * `didTimeOut()` branch inside the CATCH is a third path, covered by
 * `makeRejectOnAbortQuery` below.
 */
function makeSlowNaturalCompletionQuery(delayMs: number): FakeQueryFn {
  return function slowNaturalCompletionQuery(): AsyncGenerator<SDKMessage, void> {
    return (async function* run() {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      // Unreachable — satisfies the async-generator `require-yield` lint rule.
      if (false as boolean) yield undefined as never;
    })();
  };
}

// The SDK `query` is mocked so the pairwiseJudgeQuery boundary is unit-testable
// without a real claude binary.
const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}));
vi.mock('../../services/panels/claude/claudeExecutablePath', () => ({
  resolveClaudeExecutablePath: () => '/fake/claude',
}));

import { makePairwiseJudgeQuery, PAIRWISE_JUDGE_TIMEOUT_MS } from './pairwiseJudgeQuery';

let lastOptions: unknown;

/** Point the mocked `query()` at a shared fakeSdk `FakeQueryFn`, capturing options. */
function install(fn: FakeQueryFn): void {
  queryMock.mockImplementation((params: FakeQueryParams) => {
    lastOptions = params.options;
    return fn(params);
  });
}

beforeEach(() => {
  queryMock.mockReset();
  lastOptions = undefined;
});

describe('makePairwiseJudgeQuery', () => {
  it('a timed-out query rejects with the TYPED EvalJudgeTimeoutError', async () => {
    install(makeBlockUntilAbortQuery());
    const fn = makePairwiseJudgeQuery(undefined, 5);
    await expect(fn({ prompt: 'p', schema: {} })).rejects.toBeInstanceOf(EvalJudgeTimeoutError);
  });

  it('a query that drains to completion NORMALLY (no rejection) after the deadline already fired still rejects with the TYPED EvalJudgeTimeoutError (post-drain in-loop check)', async () => {
    install(makeSlowNaturalCompletionQuery(30));
    const fn = makePairwiseJudgeQuery(undefined, 5);

    const rejection = fn({ prompt: 'p', schema: {} });
    await expect(rejection).rejects.toBeInstanceOf(EvalJudgeTimeoutError);
    await expect(rejection).rejects.toThrow(/timed out after 5ms/);
  });

  it('a stream that REJECTS in response to the deadline abort (the real SDK shape) rejects with the TYPED EvalJudgeTimeoutError (catch-block branch)', async () => {
    // The production timeout path: abortController.abort() kills the subprocess and
    // the `for await` throws an AbortError, so the post-drain guard is never reached
    // and the typing is decided by `didTimeOut()` inside the CATCH. That branch is
    // what makes isDeterministicJudgeFailure() see a timeout (no slot retry) rather
    // than a retryable generic Error.
    install(makeRejectOnAbortQuery());
    const fn = makePairwiseJudgeQuery(undefined, 5);

    const rejection = fn({ prompt: 'p', schema: {} });
    await expect(rejection).rejects.toBeInstanceOf(EvalJudgeTimeoutError);
    // The raw AbortError text is deliberately REPLACED by the deadline message —
    // `didTimeOut()` wins over the SDK's own wording in that branch.
    await expect(rejection).rejects.toThrow(/timed out after 5ms/);
  });

  it('an EvalJudgeTimeoutError thrown by the generator itself is rethrown BY IDENTITY (same object), not wrapped anew', async () => {
    const original = new EvalJudgeTimeoutError('boom from generator');
    install(makeRejectingQuery(original));
    const fn = makePairwiseJudgeQuery();

    await expect(fn({ prompt: 'p', schema: {} })).rejects.toBe(original);
  });

  it('a non-timeout SDK failure rejects with a plain Error, NOT the typed timeout class (retry-once contract)', async () => {
    install(makeRejectingQuery(new Error('sdk boom')));
    const fn = makePairwiseJudgeQuery();

    const rejection = fn({ prompt: 'p', schema: {} });
    await expect(rejection).rejects.toThrow('sdk boom');
    await expect(rejection).rejects.toBeInstanceOf(Error);
    await expect(rejection).rejects.not.toBeInstanceOf(EvalJudgeTimeoutError);
  });

  it('turn exhaustion without structured output rejects with the TYPED EvalJudgeMaxTurnsError (deterministic — no wasted retry)', async () => {
    // Parity with evalJudgeQuery. Draining an `error_max_turns` result to `null`
    // made it masquerade downstream as "sample is not an object" — a parse-shaped
    // failure the worker classifies as RETRYABLE — so a slot that had already
    // spent its whole turn budget drew a guaranteed-wasted identical retry.
    install(makeFakeQuery([sdkAssistantText('still deliberating'), sdkResultError({ subtype: 'error_max_turns' })]));
    const fn = makePairwiseJudgeQuery();

    const rejection = fn({ prompt: 'p', schema: {} });
    await expect(rejection).rejects.toBeInstanceOf(EvalJudgeMaxTurnsError);
    await expect(rejection).rejects.toThrow(/turn budget/);
  });

  it('is deterministic per judgeErrors for BOTH exhaustion classes but not for a generic failure', async () => {
    // The property the worker's per-slot retry policy actually branches on.
    install(makeFakeQuery([sdkResultError({ subtype: 'error_max_turns' })]));
    const maxTurns = await makePairwiseJudgeQuery()({ prompt: 'p', schema: {} }).catch((e: unknown) => e);
    install(makeBlockUntilAbortQuery());
    const timedOut = await makePairwiseJudgeQuery(undefined, 5)({ prompt: 'p', schema: {} }).catch((e: unknown) => e);
    install(makeRejectingQuery(new Error('sdk boom')));
    const generic = await makePairwiseJudgeQuery()({ prompt: 'p', schema: {} }).catch((e: unknown) => e);

    expect(isDeterministicJudgeFailure(maxTurns)).toBe(true);
    expect(isDeterministicJudgeFailure(timedOut)).toBe(true);
    expect(isDeterministicJudgeFailure(generic)).toBe(false);
  });

  it('a max-turns result that STILL emitted structured output is returned, not thrown', async () => {
    // Only an EMPTY drain is exhaustion; a verdict that arrived before the budget
    // ran out is a perfectly good sample.
    install(
      makeFakeQuery([
        sdkResultSuccess({ structuredOutput: { preference: 'B', confidence: 0.7 } }),
        sdkResultError({ subtype: 'error_max_turns' }),
      ]),
    );

    await expect(makePairwiseJudgeQuery()({ prompt: 'p', schema: {} })).resolves.toEqual({
      preference: 'B',
      confidence: 0.7,
    });
  });

  it('returns the structured_output of the successful result', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: { preference: 'A', confidence: 0.8 } })]));
    const fn = makePairwiseJudgeQuery();

    const out = await fn({ prompt: 'p', schema: { type: 'object' } });

    expect(out).toEqual({ preference: 'A', confidence: 0.8 });
  });

  it('passes PAIRWISE_ALLOWED_TOOLS, json_schema outputFormat, and NO cwd key', async () => {
    install(makeFakeQuery([sdkResultSuccess({ structuredOutput: {} })]));
    const fn = makePairwiseJudgeQuery();

    await fn({ prompt: 'p', schema: { type: 'object', required: ['preference'] } });

    const opts = lastOptions as Record<string, unknown>;
    expect(opts.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
    expect(opts.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', required: ['preference'] },
    });
    expect('cwd' in opts).toBe(false);
  });

  it('exports the default per-sample deadline as 180_000ms', () => {
    expect(PAIRWISE_JUDGE_TIMEOUT_MS).toBe(180_000);
  });
});
