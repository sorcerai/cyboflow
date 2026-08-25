import { describe, expect, it } from 'vitest';

import type { Session } from '../../types/session';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import { anyIdeaChildSessionActive, groupIdeaSessions } from '../ideaSessionGrouping';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'running',
    createdAt: '2026-08-21T00:00:00.000Z',
    output: [],
    jsonMessages: [],
    projectId: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// groupIdeaSessions
// ---------------------------------------------------------------------------

describe('groupIdeaSessions', () => {
  it('home + children: claimed into one group and removed from the flat list', () => {
    const home = mkSession('home-1', { homeIdeaId: 'idea-1' });
    const child1 = mkSession('child-1', { originIdeaId: 'idea-1', displayOrder: 1 });
    const child2 = mkSession('child-2', { originIdeaId: 'idea-1', displayOrder: 0 });
    const other = mkSession('plain-1');

    const { groups, ungroupedSessions } = groupIdeaSessions([home, child1, child2, other]);

    expect(groups).toHaveLength(1);
    expect(groups[0].ideaId).toBe('idea-1');
    expect(groups[0].homeSession.id).toBe('home-1');
    // Children ordered deterministically by displayOrder (child2=0 before child1=1).
    expect(groups[0].children.map((s) => s.id)).toEqual(['child-2', 'child-1']);
    expect(ungroupedSessions.map((s) => s.id)).toEqual(['plain-1']);
  });

  it('child without a home stays flat (no group for that idea)', () => {
    const child = mkSession('child-1', { originIdeaId: 'idea-1' });
    const other = mkSession('plain-1');

    const { groups, ungroupedSessions } = groupIdeaSessions([child, other]);

    expect(groups).toHaveLength(0);
    expect(ungroupedSessions.map((s) => s.id).sort()).toEqual(['child-1', 'plain-1']);
  });

  it('home without children still forms a group (renders as a normal row with idea treatment)', () => {
    const home = mkSession('home-1', { homeIdeaId: 'idea-1' });

    const { groups, ungroupedSessions } = groupIdeaSessions([home]);

    expect(groups).toHaveLength(1);
    expect(groups[0].homeSession.id).toBe('home-1');
    expect(groups[0].children).toEqual([]);
    expect(ungroupedSessions).toHaveLength(0);
  });

  it('a home session whose own launch originated it is not duplicated in its own children', () => {
    // A session can carry BOTH homeIdeaId and a matching originIdeaId (the
    // idea's own launch minted its home). It must appear once, as the home,
    // never also inside `children`.
    const home = mkSession('home-1', { homeIdeaId: 'idea-1', originIdeaId: 'idea-1' });
    const child = mkSession('child-1', { originIdeaId: 'idea-1' });

    const { groups } = groupIdeaSessions([home, child]);

    expect(groups).toHaveLength(1);
    expect(groups[0].children.map((s) => s.id)).toEqual(['child-1']);
  });

  it('home archived/absent: children detach to the flat list', () => {
    // The home-archive rule is exercised purely by the home's absence from the
    // input list — grouping requires a LIVE home. The children pass through
    // ungrouped exactly as any other originIdeaId-only session would.
    const child1 = mkSession('child-1', { originIdeaId: 'idea-1' });
    const child2 = mkSession('child-2', { originIdeaId: 'idea-1' });

    const { groups, ungroupedSessions } = groupIdeaSessions([child1, child2]);

    expect(groups).toHaveLength(0);
    expect(ungroupedSessions.map((s) => s.id).sort()).toEqual(['child-1', 'child-2']);
  });

  it('composition: a session already claimed by experiment grouping never reaches idea grouping', () => {
    // Contract test for the composition rule (DraggableProjectTreeView runs
    // groupIdeaSessions on groupRailExperiments's `ungroupedSessions` output):
    // an idea-launched experiment ARM session is claimed by the experiment
    // group first and so is simply absent from the list passed in here. If it
    // originated from an idea, it must NOT also show up as an idea-group child.
    const home = mkSession('home-1', { homeIdeaId: 'idea-1' });
    // arm-a would carry originIdeaId: 'idea-1' too, but it's already claimed by
    // groupRailExperiments and so is excluded from the post-experiment flat list
    // this function receives — simulate that by simply not including it.
    const postExperimentFlatList = [home];

    const { groups } = groupIdeaSessions(postExperimentFlatList);

    expect(groups).toHaveLength(1);
    expect(groups[0].children).toEqual([]);
  });

  it('multiple ideas: independent groups, deterministic order by home displayOrder', () => {
    const homeB = mkSession('home-b', { homeIdeaId: 'idea-b', displayOrder: 5 });
    const homeA = mkSession('home-a', { homeIdeaId: 'idea-a', displayOrder: 1 });
    const childA = mkSession('child-a', { originIdeaId: 'idea-a' });

    const { groups } = groupIdeaSessions([homeB, homeA, childA]);

    expect(groups.map((g) => g.ideaId)).toEqual(['idea-a', 'idea-b']);
    expect(groups[0].children.map((s) => s.id)).toEqual(['child-a']);
    expect(groups[1].children).toEqual([]);
  });

  it('deterministic ordering falls back to id when displayOrder is absent/tied', () => {
    const homeZ = mkSession('home-z', { homeIdeaId: 'idea-z' });
    const homeA = mkSession('home-a', { homeIdeaId: 'idea-a' });

    const { groups } = groupIdeaSessions([homeZ, homeA]);

    expect(groups.map((g) => g.homeSession.id)).toEqual(['home-a', 'home-z']);
  });

  it('no idea-linked sessions: every session passes through, no groups', () => {
    const sessions = [mkSession('plain-1'), mkSession('plain-2')];
    const { groups, ungroupedSessions } = groupIdeaSessions(sessions);

    expect(groups).toHaveLength(0);
    expect(ungroupedSessions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// anyIdeaChildSessionActive / isIdeaChildSessionActive
// ---------------------------------------------------------------------------

describe('anyIdeaChildSessionActive', () => {
  const mkRun = (sessionId: string, status: string): ActiveRunRow =>
    ({ id: `run-${sessionId}`, session_id: sessionId, status } as ActiveRunRow);

  it('false when the idea has no children (home alone)', () => {
    const home = mkSession('home-1', { homeIdeaId: 'idea-1', status: 'running' });
    expect(anyIdeaChildSessionActive([home], undefined, 'idea-1', 'home-1')).toBe(false);
  });

  it('true when a child session row is running', () => {
    const home = mkSession('home-1', { homeIdeaId: 'idea-1', status: 'stopped' });
    const child = mkSession('child-1', { originIdeaId: 'idea-1', status: 'running' });
    expect(anyIdeaChildSessionActive([home, child], undefined, 'idea-1', 'home-1')).toBe(true);
  });

  it("true when a child's run is non-terminal even though its session row lags", () => {
    const home = mkSession('home-1', { homeIdeaId: 'idea-1', status: 'stopped' });
    const child = mkSession('child-1', { originIdeaId: 'idea-1', status: 'stopped' });
    const runs = [mkRun('child-1', 'awaiting_review')];
    expect(anyIdeaChildSessionActive([home, child], runs, 'idea-1', 'home-1')).toBe(true);
  });

  it('false when every child is settled (stopped rows, terminal runs only)', () => {
    const home = mkSession('home-1', { homeIdeaId: 'idea-1', status: 'stopped' });
    const child = mkSession('child-1', { originIdeaId: 'idea-1', status: 'stopped' });
    const runs = [mkRun('child-1', 'completed'), mkRun('other', 'running')];
    expect(anyIdeaChildSessionActive([home, child], runs, 'idea-1', 'home-1')).toBe(false);
  });

  it("ignores the home session itself and other ideas' sessions", () => {
    // The home is running (its own clarify chat) and a FOREIGN idea's child is
    // running — neither counts as one of THIS idea's active children.
    const home = mkSession('home-1', { homeIdeaId: 'idea-1', originIdeaId: 'idea-1', status: 'running' });
    const foreign = mkSession('child-x', { originIdeaId: 'idea-2', status: 'running' });
    expect(anyIdeaChildSessionActive([home, foreign], undefined, 'idea-1', 'home-1')).toBe(false);
  });
});
