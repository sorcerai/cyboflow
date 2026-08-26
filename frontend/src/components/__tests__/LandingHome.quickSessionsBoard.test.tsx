/**
 * LandingHome — the quick-session board is mounted in EVERY non-empty home
 * state, not only `reviews`.
 *
 * Regression for the "board vanishes on open" bug: opening an idle quick session
 * from the queue marks it viewed, which drops it out of the attention count. If
 * that was the last waiting item, `waitingCount` hits 0 and the home flips from
 * `reviews` to `caught-up` / `some-idle` / `all-active`. The board used to live
 * ONLY inside TypeGroupedQueue (rendered only in `reviews`), so it disappeared
 * across that transition. These tests pin that the board is present in the other
 * non-empty states too. QuickSessionsTable is stubbed to a sentinel — this is a
 * wiring test for LandingHome's layout branches, not the board's internals.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';
import type { ActiveRunRow } from '../../stores/activeRunsStore';

let mockProjectsCount = 1;
let mockRuns: ActiveRunRow[] = [];
let mockQuickRows: QuickSessionRow[] = [];

vi.mock('../../stores/landingStore', () => ({
  useProjectsCount: () => mockProjectsCount,
  useLandingProjects: () => [{ id: 1, name: 'proj', path: '/p' }],
  useAggregatedReviewItems: () => [],
  useAggregatedRuns: () => mockRuns,
}));
vi.mock('../../stores/reviewQueueStore', () => ({
  useReviewQueueStore: (selector: (s: { queue: unknown[] }) => unknown) => selector({ queue: [] }),
  useReviewQueueView: () => ({ blocking: [], normal: [] }),
}));
vi.mock('../../stores/dynamicWorkflowStore', () => ({
  useDynamicWorkflowStore: { getState: () => ({ init: vi.fn() }) },
  useActiveDynamicWorkflows: () => [],
}));

// Real needsAttention selector so the attention math (idle+unviewed) is exercised
// exactly as production; only the data source + polling side effects are stubbed.
vi.mock('../../stores/quickSessionsStore', () => ({
  useQuickSessionRows: () => mockQuickRows,
  needsAttention: (row: QuickSessionRow) =>
    row.state === 'blocked' || (row.state === 'idle' && row.unviewed),
  useQuickSessionsStore: { getState: () => ({ init: () => () => undefined }) },
}));

// Leaf stubs — LandingHome only owns state derivation + layout; the board is the
// one leaf under test, rendered as an identifiable sentinel.
vi.mock('../landing/EmptyState', () => ({ EmptyState: () => <div data-testid="empty" /> }));
vi.mock('../landing/SubHeader', () => ({ SubHeader: () => <div data-testid="subheader" /> }));
vi.mock('../landing/TypeGroupedQueue', () => ({ TypeGroupedQueue: () => <div data-testid="type-grouped-queue" /> }));
vi.mock('../landing/ActiveAgents', () => ({ ActiveAgents: () => <div data-testid="active-agents" /> }));
vi.mock('../landing/IdleStartList', () => ({ IdleStartList: () => <div data-testid="idle-start-list" /> }));
vi.mock('../landing/CaughtUpHero', () => ({ CaughtUpHero: () => <div data-testid="caught-up-hero" /> }));
vi.mock('../landing/EndCta', () => ({ EndCta: () => <div data-testid="end-cta" /> }));
vi.mock('../landing/QuickSessionsTable', () => ({
  QuickSessionsTable: () => <div data-testid="quick-sessions-board" />,
}));

import LandingHome from '../landing/LandingHome';

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'smooth-falcon',
    projectId: 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? '2026-07-06T00:00:00.000Z',
    unviewed: overrides.unviewed ?? false,
  };
}

// LandingHome only reads `status` + `project_id` off each run; a minimal shape
// cast through `unknown` keeps the fixture from restating the full ActiveRunRow.
function run(status: ActiveRunRow['status']): ActiveRunRow {
  return { run_id: 'r1', project_id: 1, status } as unknown as ActiveRunRow;
}

beforeEach(() => {
  mockProjectsCount = 1;
  mockRuns = [];
  mockQuickRows = [];
});

describe('LandingHome — quick-session board mounting', () => {
  it('mounts the board in the caught-up state (idle+viewed session, nothing waiting)', () => {
    // An idle, already-viewed session: needsAttention false → waitingCount 0 →
    // no active/idle runs → caught-up. This is exactly the post-open transition.
    mockQuickRows = [quickRow({ state: 'idle', unviewed: false })];
    render(<LandingHome />);
    expect(screen.getByTestId('caught-up-hero')).toBeInTheDocument();
    expect(screen.getByTestId('quick-sessions-board')).toBeInTheDocument();
  });

  it('keeps the centered caught-up hero (no board slot) when zero quick sessions exist', () => {
    mockQuickRows = [];
    render(<LandingHome />);
    expect(screen.getByTestId('caught-up-hero')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-sessions-board')).not.toBeInTheDocument();
  });

  it('mounts the board in the all-active state (a run in flight, no idle projects)', () => {
    mockRuns = [run('running')];
    mockQuickRows = [quickRow({ state: 'idle', unviewed: false })];
    render(<LandingHome />);
    // No IdleStartList in all-active; board is present alongside ActiveAgents.
    expect(screen.queryByTestId('idle-start-list')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-sessions-board')).toBeInTheDocument();
  });

  it('mounts the board in the reviews state (an attention-needing session)', () => {
    // An idle+unviewed session → attention → reviews state. The board lives
    // inside TypeGroupedQueue here (stubbed), and LandingHome must not ALSO
    // render the standalone board (no duplicate).
    mockQuickRows = [quickRow({ state: 'idle', unviewed: true })];
    render(<LandingHome />);
    expect(screen.getByTestId('type-grouped-queue')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-sessions-board')).not.toBeInTheDocument();
  });
});
