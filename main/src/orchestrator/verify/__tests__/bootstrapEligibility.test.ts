/**
 * Unit tests for the shared runbook-bootstrap decision
 * (docs/proposals/lane-runbook-bootstrap.md §4, §12 step 1).
 *
 * These are the highest-consequence pure functions in the feature. Two things
 * are being pinned:
 *
 *  1. `taskDerivesEnvironment` is THE definition the §3.2 gate and the preflight
 *     both use. If they ever computed it differently the feature misfires in
 *     both directions — bootstrapping requests the gate would have passed, or
 *     leaving skipped the ones it would not. So the table below is written
 *     against the shapes the gate actually sees, empty `build` included.
 *  2. Deriving a runbook is an UPSERT over a singleton (project, modality)
 *     record. Three different situations answer `'unproven-draft'` and only two
 *     of them are safe to write over; the third is a live proof another branch
 *     depends on. Every discriminant is asserted individually rather than "not
 *     proven ⇒ go", because "not proven ⇒ go" is precisely the bug.
 */
import { describe, it, expect } from 'vitest';
import {
  bootstrapRemedyText,
  decideRunbookBootstrap,
  declineForRunbookStatus,
  taskDerivesEnvironment,
  type BootstrapDeclineReason,
} from '../bootstrapEligibility';
import type { VerifyRunbookStatusDetail, VerifyRunbookStatusReason } from '../runbookStore';

function status(reason: VerifyRunbookStatusReason): VerifyRunbookStatusDetail {
  // The status half is what the gate acts on; the reason is what the bootstrap
  // acts on. Derived here so a test names only the thing it is about.
  const map: Record<VerifyRunbookStatusReason, VerifyRunbookStatusDetail['status']> = {
    proven: 'proven',
    'no-record': 'absent',
    'file-only': 'unproven-draft',
    draft: 'unproven-draft',
    'proven-file-absent-here': 'unproven-draft',
    drifted: 'unproven-draft',
    indeterminate: 'absent',
  };
  return { status: map[reason], reason };
}

describe('taskDerivesEnvironment', () => {
  it.each([
    ['a serve step', { serve: { cmd: 'pnpm dev --port ${PORT}' } }, true],
    ['a non-empty build', { build: ['pnpm build'] }, true],
    ['both', { build: ['pnpm build'], serve: { cmd: 'x' } }, true],
    ['neither (a degenerate target-only task)', {}, false],
    // The asymmetry that matters: an EMPTY build array derives nothing and must
    // not gate, while `serve` counts by presence alone.
    ['an EMPTY build array', { build: [] }, false],
  ])('%s → %s', (_label, task, expected) => {
    expect(taskDerivesEnvironment(task)).toBe(expected);
  });
});

describe('declineForRunbookStatus', () => {
  it.each<[VerifyRunbookStatusReason, BootstrapDeclineReason | null]>([
    ['no-record', null],
    ['file-only', null],
    ['draft', null],
    ['proven', 'already-proven'],
    ['proven-file-absent-here', 'proof-belongs-elsewhere'],
    ['drifted', 'stale-proof'],
    ['indeterminate', 'unobservable'],
  ])('%s → %s', (reason, expected) => {
    expect(declineForRunbookStatus(status(reason))).toBe(expected);
  });

  it('NEVER allows deriving over a proof that belongs to another branch', () => {
    // The single most consequential row above, restated on its own because the
    // failure mode is silent and shared: registerDraft would UPSERT the
    // singleton record, and every branch that HAS the runbook would stop
    // verifying. This case answers 'unproven-draft' exactly like a safe draft
    // does, so nothing but the reason distinguishes them.
    const detail = status('proven-file-absent-here');
    expect(detail.status).toBe('unproven-draft');
    expect(declineForRunbookStatus(detail)).toBe('proof-belongs-elsewhere');
  });
});

describe('decideRunbookBootstrap', () => {
  const on = { enabled: true, derivesEnvironment: true };

  it('proceeds on a project that has nothing, deriving a new runbook', () => {
    expect(decideRunbookBootstrap({ ...on, status: status('no-record') })).toEqual({
      proceed: true,
      adopt: false,
    });
  });

  it('proceeds in ADOPT mode when this tree already carries a runbook nobody proved', () => {
    // A teammate committed it; this host merely never proved it. Overwriting it
    // with a machine-authored rival would throw away human intent for no gain.
    expect(decideRunbookBootstrap({ ...on, status: status('file-only') })).toEqual({
      proceed: true,
      adopt: true,
    });
  });

  it('proceeds on an existing draft record — there is no proof to endanger', () => {
    expect(decideRunbookBootstrap({ ...on, status: status('draft') })).toEqual({
      proceed: true,
      adopt: false,
    });
  });

  it.each<[VerifyRunbookStatusReason, BootstrapDeclineReason]>([
    ['proven', 'already-proven'],
    ['proven-file-absent-here', 'proof-belongs-elsewhere'],
    ['drifted', 'stale-proof'],
    ['indeterminate', 'unobservable'],
  ])('declines on %s with reason %s', (reason, expected) => {
    expect(decideRunbookBootstrap({ ...on, status: status(reason) })).toEqual({
      proceed: false,
      reason: expected,
    });
  });

  it('the toggle wins over everything, and is reported as the toggle', () => {
    // Not 'no-record': a project with the feature off is not a project that
    // needs setting up, and describing it that way would put a runbook CTA in
    // front of someone who deliberately turned this off.
    expect(
      decideRunbookBootstrap({ enabled: false, derivesEnvironment: true, status: status('no-record') }),
    ).toEqual({ proceed: false, reason: 'disabled' });
  });

  it('a degenerate task declines as no-environment, not as a runbook problem', () => {
    expect(
      decideRunbookBootstrap({ enabled: true, derivesEnvironment: false, status: status('no-record') }),
    ).toEqual({ proceed: false, reason: 'no-environment' });
  });
});

describe('bootstrapRemedyText', () => {
  it('tells a pre-merge branch to MERGE, and explicitly not to re-run setup', () => {
    // The remedy is the opposite of the default CTA, and following the default
    // one here is what destroys the shared proven record.
    const text = bootstrapRemedyText('proof-belongs-elsewhere') ?? '';
    expect(text).toContain('Merge');
    expect(text).toContain('Do NOT re-run verification setup');
  });

  it('tells a drifted project to re-prove rather than to re-derive', () => {
    expect(bootstrapRemedyText('stale-proof') ?? '').toContain('re-proven');
  });

  it.each<BootstrapDeclineReason>(['disabled', 'no-environment', 'already-proven'])(
    'has nothing to say about %s',
    (reason) => {
      // These are not problems. Attaching prose to them would put advice on a
      // finding for a lane that did exactly what it should have.
      expect(bootstrapRemedyText(reason)).toBeNull();
    },
  );
});
