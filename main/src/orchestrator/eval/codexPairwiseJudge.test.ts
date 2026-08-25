/**
 * Unit tests for CodexPairwiseJudge (no SDK, no Codex app-server): pins prompt
 * build + schema-identity + no-cwd behavior, defensive-parser reuse, the
 * positionAFirst orientation, late model resolution via getResolvedModel(), and
 * the two distinct unavailability paths (identity pass-through vs.
 * AgentProviderDisabledError → CodexJurorUnavailableError('provider-disabled')).
 */
import { describe, expect, it, vi } from 'vitest';
import type { PairwiseStructuredQueryFn } from './pairwiseJudgeQuery';
import { PAIRWISE_OUTPUT_SCHEMA } from './pairwiseJudge';
import { CodexPairwiseJudge } from './codexPairwiseJudge';
import { CodexJurorUnavailableError } from './codexJudge';
import { AgentProviderDisabledError } from '../../services/agentProviderGuard';
import { CODEX_EVAL_JUDGE_TIMEOUT_MS } from '../../services/panels/codex/codexEvalJudgeQuery';

describe('CodexPairwiseJudge', () => {
  it('builds the pairwise prompt, passes the schema by identity, the configured model, and never a cwd', async () => {
    const structuredQuery = vi.fn<PairwiseStructuredQueryFn>(async () => ({
      preference: '1',
      confidence: 0.6,
      rationale: 'Solution 1 is cleaner',
    }));
    const judge = new CodexPairwiseJudge({ structuredQuery, model: 'gpt-5.4' });

    await judge.grade({ diffA: 'diffA', diffB: 'diffB', positionAFirst: true });

    expect(structuredQuery).toHaveBeenCalledTimes(1);
    const args = structuredQuery.mock.calls[0][0];
    expect(args.prompt).toContain('===== SOLUTION 1 =====');
    expect(args.schema).toBe(PAIRWISE_OUTPUT_SCHEMA);
    expect(args.model).toBe('gpt-5.4');
    expect('cwd' in args).toBe(false);
  });

  it('parses a canned {preference, confidence, rationale} into a PairwiseRawResult', async () => {
    const structuredQuery = vi.fn<PairwiseStructuredQueryFn>(async () => ({
      preference: '1',
      confidence: 0.75,
      rationale: 'well argued',
    }));
    const judge = new CodexPairwiseJudge({ structuredQuery });

    await expect(judge.grade({ diffA: 'a', diffB: 'b', positionAFirst: true })).resolves.toEqual({
      preference: '1',
      confidence: 0.75,
      rationale: 'well argued',
    });
  });

  it('rejects a garbage structured result (proves parser reuse via parsePairwiseSample)', async () => {
    const structuredQuery = vi.fn<PairwiseStructuredQueryFn>(async () => ({ garbage: true }));
    const judge = new CodexPairwiseJudge({ structuredQuery });

    await expect(judge.grade({ diffA: 'a', diffB: 'b', positionAFirst: true })).rejects.toThrow();
  });

  it('positionAFirst:false orients Solution 1 to arm B\'s diff', async () => {
    const structuredQuery = vi.fn<PairwiseStructuredQueryFn>(async () => ({
      preference: '1',
      confidence: 0.5,
      rationale: 'r',
    }));
    const judge = new CodexPairwiseJudge({ structuredQuery });

    await judge.grade({ diffA: 'AAA-DIFF', diffB: 'BBB-DIFF', positionAFirst: false });

    const prompt = structuredQuery.mock.calls[0][0].prompt;
    const s1 = prompt.indexOf('SOLUTION 1');
    const s2 = prompt.indexOf('SOLUTION 2');
    expect(prompt.indexOf('BBB-DIFF')).toBeGreaterThan(s1);
    expect(prompt.indexOf('BBB-DIFF')).toBeLessThan(s2);
    expect(prompt.indexOf('AAA-DIFF')).toBeGreaterThan(s2);
  });

  it('resolves the model lazily via getResolvedModel(), only after the first grade()', async () => {
    const structuredQuery: PairwiseStructuredQueryFn & { getResolvedModel: () => string } =
      Object.assign(
        vi.fn<PairwiseStructuredQueryFn>(async () => ({
          preference: '1',
          confidence: 0.5,
          rationale: 'r',
        })),
        { getResolvedModel: vi.fn(() => 'gpt-5.4-2026-08-01') },
      );
    const judge = new CodexPairwiseJudge({ structuredQuery });

    expect(judge.resolvedModel).toBeUndefined();

    await judge.grade({ diffA: 'a', diffB: 'b', positionAFirst: true });

    expect(judge.resolvedModel).toBe('gpt-5.4-2026-08-01');
  });

  it('propagates a CodexJurorUnavailableError by identity', async () => {
    const unavailable = new CodexJurorUnavailableError('logged out', 'logged-out');
    const structuredQuery: PairwiseStructuredQueryFn = async () => {
      throw unavailable;
    };
    const judge = new CodexPairwiseJudge({ structuredQuery });

    await expect(judge.grade({ diffA: 'a', diffB: 'b', positionAFirst: true })).rejects.toBe(unavailable);
  });

  it("rethrows AgentProviderDisabledError('codex', ...) as a CodexJurorUnavailableError with code 'provider-disabled'", async () => {
    const structuredQuery: PairwiseStructuredQueryFn = async () => {
      throw new AgentProviderDisabledError('codex', 'the codex pairwise judge');
    };
    const judge = new CodexPairwiseJudge({ structuredQuery });

    const rejection = judge.grade({ diffA: 'a', diffB: 'b', positionAFirst: true });
    await expect(rejection).rejects.toBeInstanceOf(CodexJurorUnavailableError);
    await expect(rejection).rejects.toMatchObject({
      name: 'CodexJurorUnavailableError',
      code: 'provider-disabled',
    });
  });

  it('inherits the 10-minute Codex eval-judge deadline (no shorter timeout is imposed here)', () => {
    expect(CODEX_EVAL_JUDGE_TIMEOUT_MS).toBe(600_000);
  });
});
