/**
 * Unit tests for the fan-out BATCH script renderer.
 *
 * Two things carry the most weight here:
 *  - Segmentation. Consecutive non-gated stages must coalesce into ONE batch
 *    (that is the whole efficiency argument), and a firm gate must always break
 *    the chain — `visual-verify` structurally, any stage the author flags.
 *  - Safety. The emitted file is JavaScript another runtime executes, and its
 *    name is joined into a filesystem path, so free-form workflow/step/agent ids
 *    must not be able to escape either. `parseScriptMeta` (the tracker's reader)
 *    is a fail-soft REGEX scanner and would accept syntactically invalid source,
 *    so real syntax validation goes through the JS parser instead.
 */
import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';
import {
  fanOutBatchLogicalName,
  fanOutBatchWorkflowName,
  isFirmGateInnerStep,
  renderFanOutBatchScript,
  renderFanOutBatchScripts,
  segmentFanOutInner,
  slugSegment,
} from '../fanOutStageScript';
import { parseScriptMeta } from '../../dynamicWorkflows/scriptMeta';
import { resolveWorkflowDefinition } from '../../../../../shared/types/workflows';
import type { FanOutInnerStep, WorkflowStep } from '../../../../../shared/types/workflows';

/** The canonical sprint chain: four batchable stages then the firm visual gate. */
const INNER: FanOutInnerStep[] = [
  { id: 'implement', agent: 'implement', name: 'Implement' },
  { id: 'write-tests', agent: 'write-tests', name: 'Write tests', loopback: 'implement' },
  { id: 'code-review', agent: 'code-review', name: 'Code review', loopback: 'implement' },
  { id: 'task-verify', agent: 'task-verify', name: 'Verify', loopback: 'implement' },
  { id: 'visual-verify', agent: 'visual-verify', name: 'Visual check', optional: true, firmGate: true },
];

const STEP: WorkflowStep = {
  id: 'execute',
  name: 'Execute',
  agent: 'orchestrator',
  mcps: [],
  retries: 0,
  fanOut: { over: 'tasks', inner: INNER, maxConcurrency: 5 },
};

/**
 * Syntax-check the emitted source the way the workflow runtime consumes it: the
 * `export const meta` declaration is lifted off, and the remaining body runs
 * inside an async function (which is what legalizes its top-level `await` and
 * top-level `return`). `vm.SourceTextModule` is deliberately not used: it needs
 * --experimental-vm-modules, and it would reject the top-level return anyway.
 */
function assertParses(source: string): void {
  const body = source.replace(/^export\s+const\s+meta\s*=/m, 'const meta =');
  const wrapped = `(async (args, agent, parallel, pipeline, log, phase, workflow, budget) => {\n${body}\n})`;
  expect(() => new vm.Script(wrapped, { filename: 'batch.js' })).not.toThrow();
}

describe('slugSegment', () => {
  it('reduces free-form input to a filename-safe segment', () => {
    expect(slugSegment('Sprint Flow')).toBe('sprint-flow');
    expect(slugSegment('write_tests')).toBe('write-tests');
    expect(slugSegment('  --Weird--  ')).toBe('weird');
  });

  it('neutralizes path traversal and separators', () => {
    expect(slugSegment('../../etc/passwd')).toBe('etc-passwd');
    expect(slugSegment('a/b')).toBe('a-b');
    expect(slugSegment('..')).toBe('');
    expect(slugSegment('/')).toBe('');
  });

  it('returns empty for input with no usable characters', () => {
    expect(slugSegment('***')).toBe('');
    expect(slugSegment('')).toBe('');
  });

  it('caps segment length', () => {
    expect(slugSegment('a'.repeat(200)).length).toBeLessThanOrEqual(40);
  });
});

describe('naming', () => {
  it('pairs the logical name with the invocable name (writer adds the prefix exactly once)', () => {
    expect(fanOutBatchLogicalName('sprint', 'execute', 'implement')).toBe('sprint-execute-implement');
    expect(fanOutBatchWorkflowName('sprint', 'execute', 'implement')).toBe('cyboflow-sprint-execute-implement');
    expect(`cyboflow-${fanOutBatchLogicalName('sprint', 'execute', 'implement') as string}`).toBe(
      fanOutBatchWorkflowName('sprint', 'execute', 'implement'),
    );
  });

  it('is null when any segment cannot be slugged', () => {
    expect(fanOutBatchLogicalName('***', 'execute', 'implement')).toBeNull();
    expect(fanOutBatchWorkflowName('sprint', '', 'implement')).toBeNull();
  });
});

describe('firm gates', () => {
  it('honours the explicit flag', () => {
    expect(isFirmGateInnerStep({ id: 'anything', agent: 'x', firmGate: true })).toBe(true);
    expect(isFirmGateInnerStep({ id: 'implement', agent: 'implement' })).toBe(false);
    expect(isFirmGateInnerStep({ id: 'implement', agent: 'implement', firmGate: false })).toBe(false);
  });

  it('treats visual-verify as gated even with the flag off (no subagent exists for it)', () => {
    expect(isFirmGateInnerStep({ id: 'visual-verify', agent: 'x', firmGate: false })).toBe(true);
    expect(isFirmGateInnerStep({ id: 'renamed', agent: 'visual-verify' })).toBe(true);
  });
});

describe('segmentFanOutInner', () => {
  it('coalesces the four implementation stages into ONE batch, gate last', () => {
    const segments = segmentFanOutInner(INNER);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ kind: 'batch' });
    expect((segments[0] as { steps: FanOutInnerStep[] }).steps.map((s) => s.id)).toEqual([
      'implement',
      'write-tests',
      'code-review',
      'task-verify',
    ]);
    expect(segments[1]).toMatchObject({ kind: 'gate' });
  });

  it('splits around a gate in the middle', () => {
    const segments = segmentFanOutInner([
      { id: 'a', agent: 'a' },
      { id: 'gate', agent: 'g', firmGate: true },
      { id: 'b', agent: 'b' },
      { id: 'c', agent: 'c' },
    ]);
    expect(segments.map((s) => s.kind)).toEqual(['batch', 'gate', 'batch']);
    expect((segments[2] as { steps: FanOutInnerStep[] }).steps.map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('handles an all-gated chain and an all-batchable chain', () => {
    expect(segmentFanOutInner([{ id: 'g', agent: 'g', firmGate: true }]).map((s) => s.kind)).toEqual(['gate']);
    expect(segmentFanOutInner([{ id: 'a', agent: 'a' }, { id: 'b', agent: 'b' }]).map((s) => s.kind)).toEqual([
      'batch',
    ]);
    expect(segmentFanOutInner([])).toEqual([]);
  });
});

describe('renderFanOutBatchScript', () => {
  const batch = (segmentFanOutInner(INNER)[0] as { steps: FanOutInnerStep[] }).steps;
  const source = renderFanOutBatchScript('sprint', STEP, batch) as string;

  it('emits parseable JavaScript', () => {
    expect(source).not.toBeNull();
    assertParses(source);
  });

  it('emits a meta literal the tracker can read back, one phase per stage', () => {
    const meta = parseScriptMeta(source);
    expect(meta.name).toBe('cyboflow-sprint-execute-implement');
    expect(meta.phases.map((p) => p.title)).toEqual(['Implement', 'Write tests', 'Code review', 'Verify']);
  });

  it('binds every stage to its own cyboflow- agent definition', () => {
    for (const agent of ['implement', 'write-tests', 'code-review', 'task-verify']) {
      expect(source).toContain(`agentType: "cyboflow-${agent}"`);
    }
  });

  it('runs items concurrently with a sequential chain inside each (no cross-item barrier)', () => {
    expect(source).toContain('parallel(items.map((item) => () => runItem(item)))');
    expect(source).toContain('while (i < STAGES.length)');
  });

  it('retries within the batch via loopback, bounded', () => {
    expect(source).toContain('const MAX_ATTEMPTS = 3');
    expect(source).toContain('i = stage.loopbackTo');
    // write-tests/code-review/task-verify all loop back to implement (index 0).
    expect(source).toContain('loopbackTo: 0');
  });

  it('skips an optional stage on failure instead of failing the item', () => {
    const withOptional = renderFanOutBatchScript('sprint', STEP, [
      { id: 'implement', agent: 'implement' },
      { id: 'lint', agent: 'lint', optional: true },
    ]) as string;
    expect(withOptional).toContain('optional: true');
    expect(withOptional).toContain('optional stage skipped after failure');
  });

  it('never emits worktree isolation (lanes share one worktree)', () => {
    expect(source).not.toContain('isolation');
  });

  it('never emits constructs that throw inside a script body', () => {
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/Math\.random\(\)/);
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });

  it('carries a domain-outcome schema rather than keying on promise rejection', () => {
    expect(source).toContain("'blocked'");
    expect(source).toContain("required: ['outcome', 'summary']");
    expect(source).toContain("outcome: 'failed', summary: 'agent produced no result'");
  });

  it('returns an empty result set for an empty wave', () => {
    expect(source).toContain('results: [] }');
  });

  it('is null for an empty batch', () => {
    expect(renderFanOutBatchScript('sprint', STEP, [])).toBeNull();
  });
});

describe('injection safety', () => {
  const hostile = ['quote"break', "apos'break", 'back`tick', 'dollar${expr}', 'new\nline', 'back\\slash'];

  for (const raw of hostile) {
    it(`survives a hostile agent id: ${JSON.stringify(raw)}`, () => {
      const source = renderFanOutBatchScript('sprint', STEP, [{ id: 'implement', agent: raw, name: raw }]);
      expect(source).not.toBeNull();
      assertParses(source as string);
    });
  }

  it('survives a hostile outer step id', () => {
    const step: WorkflowStep = { ...STEP, id: 'exec"ute\n' };
    const source = renderFanOutBatchScript('sprint', step, [{ id: 'implement', agent: 'implement' }]);
    expect(source).not.toBeNull();
    assertParses(source as string);
  });
});

describe('renderFanOutBatchScripts over the real sprint definition', () => {
  const def = resolveWorkflowDefinition('sprint', '{}');
  const steps = def === null ? [] : def.phases.flatMap((p) => p.steps);
  const scripts = renderFanOutBatchScripts('sprint', steps);

  it('renders ONE batch script for the whole implementation sub-chain', () => {
    expect(scripts).toHaveLength(1);
    expect(scripts[0].name.endsWith('-implement')).toBe(true);
  });

  it('the batch spans every stage up to the visual gate, and excludes it', () => {
    const meta = parseScriptMeta(scripts[0].content);
    expect(meta.phases.map((p) => p.title)).toEqual(['Implement', 'Write tests', 'Code review', 'Verify']);
    expect(scripts[0].content).not.toContain('cyboflow-visual-verify');
  });

  it('every rendered script parses and round-trips its meta', () => {
    for (const script of scripts) {
      assertParses(script.content);
      expect(parseScriptMeta(script.content).name).toBe(`cyboflow-${script.name}`);
    }
  });
});
