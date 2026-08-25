/**
 * Unit tests for the bootstrap's human-facing surfaces
 * (docs/proposals/lane-runbook-bootstrap.md §8.1, §12 step 10).
 *
 * These read like content assertions, and they are — deliberately. §15A trades
 * the structural safety guarantee on the rung-1 config edit for a REVIEW-BACKED
 * one, and that trade only pays if the review actually happens. The proposal
 * says so outright: "a rung-1 bootstrap that produced no visible review surface
 * would be the failure mode this whole section exists to prevent." So the
 * sentences below are the guarantee, and a test that lets them silently
 * disappear would let the concession become unearned.
 *
 * The other half is honesty about failure. v1 claimed a failed bootstrap was
 * "byte-identical to today"; it is not — a branch can be left carrying an
 * unproven runbook and a config change that bought nothing. The unproven
 * artifact has to say that plainly rather than reporting an attempt.
 */
import { describe, it, expect } from 'vitest';
import { renderBootstrapArtifact, renderRung1Finding } from '../bootstrapArtifact';

const BASE = {
  modality: 'web',
  laneTaskRef: 'TASK-7',
  runbookJson: '{\n  "version": 1\n}',
  notes: null,
  commitSha: 'abcdef1234567890',
  runbookHash: 'hash-1',
  runbookVersion: 3,
  rung1: null,
  failureDetail: null,
  rounds: 1,
};

const RUNG1 = {
  path: 'package.json',
  description: 'added a `verify:serve` script to package.json running `vite preview`',
  commitSha: 'fedcba0987654321',
};

describe('renderBootstrapArtifact — proven', () => {
  it('says what was proven, and pins the revision it was proven for', () => {
    const md = renderBootstrapArtifact({ ...BASE, proven: true });
    expect(md).toContain('PROVEN');
    expect(md).toContain('hash-1');
    expect(md).toContain('abcdef1234');
    expect(md).toContain('TASK-7');
  });

  it('states that nothing in the runbook was invented', () => {
    // The declared-script rule is the reason a reader can trust the commands at
    // all; it belongs where they are reading them.
    const md = renderBootstrapArtifact({ ...BASE, proven: true });
    expect(md).toContain('package.json');
    expect(md).toContain('Nothing here was invented');
  });

  it('includes the drafting agent\'s notes when it wrote any', () => {
    const md = renderBootstrapArtifact({ ...BASE, proven: true, notes: 'serve cmd is package.json:12' });
    expect(md).toContain('serve cmd is package.json:12');
  });
});

describe('renderBootstrapArtifact — not proven', () => {
  it('says plainly what is left on the branch, rather than reporting an attempt', () => {
    // v1's "failure is byte-identical to today" was false, and the artifact is
    // where that would be hidden a second time.
    const md = renderBootstrapArtifact({
      ...BASE,
      proven: false,
      failureDetail: 'the serve command exited immediately',
      rounds: 2,
    });
    expect(md).toContain('NOT PROVEN');
    expect(md).toContain('unproven draft');
    expect(md).toContain('the serve command exited immediately');
    expect(md).toContain('Verify Setup');
  });

  it('tells the reader that a config change which bought nothing is safe to revert', () => {
    const md = renderBootstrapArtifact({
      ...BASE,
      proven: false,
      failureDetail: 'launch failed',
      rung1: RUNG1,
    });
    expect(md).toContain('bought nothing');
    expect(md).toContain('Reverting it is');
  });
});

describe('renderBootstrapArtifact — the rung-1 review surface', () => {
  it('puts the config change BEFORE the runbook body', () => {
    // It is the part of this that changes the project rather than describing it.
    // Burying it under a JSON blob is precisely how a review surface becomes
    // decorative.
    const md = renderBootstrapArtifact({ ...BASE, proven: true, rung1: RUNG1 });
    expect(md.indexOf('configuration file was changed')).toBeLessThan(md.indexOf('The runbook, as committed'));
  });

  it('names the file, the change, and its own revertible commit', () => {
    const md = renderBootstrapArtifact({ ...BASE, proven: true, rung1: RUNG1 });
    expect(md).toContain('package.json');
    expect(md).toContain('verify:serve');
    expect(md).toContain('fedcba0987');
    expect(md).toContain('revert it');
  });

  it('does not overclaim the narrowing — it asks for eyes rather than promising safety', () => {
    // §15A is explicit that this case is review-backed rather than structural.
    // An artifact that said "this was validated, no action needed" would be the
    // overclaim the whole section exists to avoid.
    const md = renderBootstrapArtifact({ ...BASE, proven: true, rung1: RUNG1 });
    expect(md).toContain('asks for your');
  });

  it('says nothing about a config change when there was none', () => {
    const md = renderBootstrapArtifact({ ...BASE, proven: true });
    expect(md).not.toContain('configuration file was changed');
  });
});

describe('renderRung1Finding', () => {
  it('is worded as something to REVIEW, not as an FYI', () => {
    // §8.1's requirement verbatim. A finding titled "note: a file was changed"
    // gets dismissed; one titled "review this" gets read.
    const finding = renderRung1Finding({ laneTaskRef: 'TASK-7', modality: 'web', proven: true, rung1: RUNG1 });
    expect(finding.title).toContain('Review');
    expect(finding.title).toContain('package.json');
  });

  it('names the file in the body too, with its revertible commit', () => {
    const finding = renderRung1Finding({ laneTaskRef: 'TASK-7', modality: 'web', proven: true, rung1: RUNG1 });
    expect(finding.body).toContain('package.json');
    expect(finding.body).toContain('fedcba0987');
    expect(finding.body).toContain('TASK-7');
  });

  it('tells a reviewer the change WORKED when the runbook was proven', () => {
    const finding = renderRung1Finding({ laneTaskRef: 'TASK-7', modality: 'web', proven: true, rung1: RUNG1 });
    expect(finding.body).toContain('The change worked');
  });

  it('tells a reviewer the change bought NOTHING when it was not', () => {
    // The two cases call for opposite actions — keep it, or revert it — so a
    // single neutral sentence would be useless in both.
    const finding = renderRung1Finding({ laneTaskRef: 'TASK-7', modality: 'web', proven: false, rung1: RUNG1 });
    expect(finding.body).toContain('did **not** achieve');
    expect(finding.body).toContain('reverting it is probably right');
  });

  it('states the reason a machine edit needs review at all', () => {
    const finding = renderRung1Finding({ laneTaskRef: 'TASK-7', modality: 'web', proven: true, rung1: RUNG1 });
    expect(finding.body).toContain('what gets built and what gets served');
  });
});
