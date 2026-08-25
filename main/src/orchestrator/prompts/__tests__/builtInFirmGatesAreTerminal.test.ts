/**
 * Invariant: in the BUILT-IN fan-out chains, a firm gate is always TERMINAL.
 *
 * Why this is worth pinning rather than left to review:
 *
 * A firm gate ends a delegated batch (`segmentFanOutInner`), and the emitted
 * script resolves only once EVERY item has settled — `parallel(items.map(
 * runItem))` is awaited as a whole. So each batch boundary is a full cross-lane
 * barrier: the slowest item gates every sibling's progress past that point.
 *
 * Today that costs nothing, because the only firm gate in the built-in chains
 * (`visual-verify`) sits LAST. One batch, one barrier, at the very end — the
 * cheapest possible placement. But nothing in the schema or the renderer
 * enforces that; it is currently true by luck. A gate inserted MID-chain (a
 * human review after `code-review`, say) would silently fragment the chain into
 * multiple batches and reintroduce a barrier at each split, and the earlier the
 * gate sits the more parallelism it costs.
 *
 * The failure this guards against is therefore a PERFORMANCE cliff with no
 * functional symptom — every test would stay green while the dispatch path
 * quietly lost the property it exists for. This test converts "safe by
 * accident" into "safe by construction", and fails loudly with instructions if
 * someone deliberately wants a mid-chain gate.
 *
 * Scope: BUILT-IN definitions only. A user's custom flow may place gates
 * wherever it likes — `segmentFanOutInner` handles the general case correctly,
 * just more slowly.
 */
import { describe, it, expect } from 'vitest';
import { WORKFLOW_DEFINITIONS } from '../../../../../shared/types/workflows';
import type { FanOutInnerStep, WorkflowDefinition } from '../../../../../shared/types/workflows';
import { isFirmGateInnerStep, segmentFanOutInner } from '../fanOutStageScript';

/** Every fan-out inner chain reachable in a built-in definition, with a label. */
function fanOutChains(
  name: string,
  definition: WorkflowDefinition,
): Array<{ label: string; inner: readonly FanOutInnerStep[] }> {
  const chains: Array<{ label: string; inner: readonly FanOutInnerStep[] }> = [];
  for (const phase of definition.phases) {
    for (const step of phase.steps) {
      if (step.fanOut) chains.push({ label: `${name}/${phase.id}/${step.id}`, inner: step.fanOut.inner });
    }
  }
  return chains;
}

const ALL_CHAINS = Object.entries(WORKFLOW_DEFINITIONS).flatMap(([name, definition]) =>
  fanOutChains(name, definition),
);

describe('built-in fan-out chains', () => {
  it('declare at least one fan-out chain (guards against a vacuous suite)', () => {
    // Without this, a refactor that renamed `fanOut` would make every
    // assertion below pass over an empty set.
    expect(ALL_CHAINS.length).toBeGreaterThan(0);
  });

  it.each(ALL_CHAINS.map((c) => [c.label, c] as const))(
    '%s places every firm gate at the END of the chain',
    (label, chain) => {
      const gateIndexes = chain.inner
        .map((step, index) => (isFirmGateInnerStep(step) ? index : -1))
        .filter((index) => index !== -1);

      if (gateIndexes.length === 0) return;

      const lastIndex = chain.inner.length - 1;
      const midChain = gateIndexes.filter((index) => index !== lastIndex);

      expect(
        midChain,
        `${label}: firm gate(s) ${midChain
          .map((i) => `"${chain.inner[i].id}" (position ${i + 1}/${chain.inner.length})`)
          .join(', ')} sit mid-chain. A firm gate ends a delegated batch and each ` +
          'batch boundary is a full cross-lane barrier, so a mid-chain gate fragments ' +
          'the chain and costs parallelism under fanOutDispatch:"workflow". If this is ' +
          'intentional, update this test and fanOutDispatch.ts together — do not just ' +
          'delete the assertion.',
      ).toEqual([]);
    },
  );

  it.each(ALL_CHAINS.map((c) => [c.label, c] as const))(
    '%s therefore segments into exactly one delegable batch',
    (_label, chain) => {
      const batches = segmentFanOutInner(chain.inner).filter((s) => s.kind === 'batch');
      // Terminal-only gates can produce at most one batch. This is the property
      // the invariant above exists to protect, asserted through the real
      // segmenter rather than re-derived from the chain.
      expect(batches.length).toBeLessThanOrEqual(1);
    },
  );
});
