/**
 * Unit tests for main/src/services/trackerSync/stateMapping.ts — the tracker
 * state <-> cyboflow stage translation layer.
 *
 * Board-stage resolution runs against a REAL temp-file DB through the full
 * migration chain (same technique as migration093.test.ts / store.test.ts),
 * with the project's default board seeded by DatabaseService.seedDefaultBoard
 * — so the positions/labels under test are the ones the app actually ships,
 * not a hand-rolled fixture.
 *
 * Covers:
 *   - seedDefaultMapping over all six canonical state groups.
 *   - resolveEffectiveMapping's seed-then-overlay precedence, plus its
 *     fail-soft handling of a missing/corrupt/garbage-valued blob.
 *   - resolveStageIds: the happy path (by position), the label sanity-check
 *     fallback (a re-positioned stage), the positional fallback (a RENAMED
 *     stage), and the two throw paths (no board / no resolvable stage).
 *   - mappingTargetToStageId for all five targets ('dont' -> null).
 *   - stageIdToWriteBackGroup: In development/Done/Won't do write back;
 *     Idea + Ready for development write nothing.
 *   - pickWriteBackState: first-in-provider-order, null when the group is empty.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseService } from '../../../database/database';
import type { TrackerState } from '../../../../../shared/types/trackerSync';
import {
  seedDefaultMapping,
  resolveEffectiveMapping,
  resolveStageIds,
  mappingTargetToStageId,
  stageIdToWriteBackGroup,
  pickWriteBackState,
  TrackerStageResolutionError,
} from '../stateMapping';

let tmpDir: string;
let svc: DatabaseService;
let raw: Database.Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cyboflow-trackersync-mapping-'));
  svc = new DatabaseService(join(tmpDir, 'test.db'));
  svc.initialize();
  raw = svc.getDb();
  raw.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj 1', '/tmp/p1');
  svc.seedDefaultBoard(1);
});

afterEach(() => {
  raw.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** One state per canonical group, in a provider-ish board order. */
const STATES: TrackerState[] = [
  { id: 'st-triage', name: 'Triage', color: null, group: 'triage' },
  { id: 'st-backlog', name: 'Backlog', color: '#bec2c8', group: 'backlog' },
  { id: 'st-todo', name: 'Todo', color: null, group: 'unstarted' },
  { id: 'st-progress', name: 'In Progress', color: null, group: 'started' },
  { id: 'st-review', name: 'In Review', color: null, group: 'started' },
  { id: 'st-done', name: 'Done', color: null, group: 'completed' },
  { id: 'st-canceled', name: 'Canceled', color: null, group: 'cancelled' },
];

const STAGE = {
  idea: 'stage-board-1-default-1',
  ready: 'stage-board-1-default-6',
  inDevelopment: 'stage-board-1-default-7',
  done: 'stage-board-1-default-9',
  wontdo: 'stage-board-1-default-10',
};

describe('seedDefaultMapping', () => {
  it('seeds every canonical group to its documented default target', () => {
    expect(seedDefaultMapping(STATES)).toEqual({
      'st-triage': 'dont',
      'st-backlog': 'idea',
      'st-todo': 'ready',
      'st-progress': 'ready',
      'st-review': 'ready',
      'st-done': 'done',
      'st-canceled': 'wontdo',
    });
  });

  it('returns an empty mapping for an empty state list', () => {
    expect(seedDefaultMapping([])).toEqual({});
  });
});

describe('resolveEffectiveMapping', () => {
  it('overlays the stored mapping on top of the seeded defaults', () => {
    const mapping = resolveEffectiveMapping(
      STATES,
      JSON.stringify({ 'st-triage': 'idea', 'st-todo': 'dont' }),
    );
    // Overridden…
    expect(mapping['st-triage']).toBe('idea');
    expect(mapping['st-todo']).toBe('dont');
    // …everything else still seeded, including a state added since the wizard ran.
    expect(mapping['st-backlog']).toBe('idea');
    expect(mapping['st-review']).toBe('ready');
    expect(mapping['st-canceled']).toBe('wontdo');
  });

  it('keeps a stored mapping entry for a state the provider no longer returns', () => {
    const mapping = resolveEffectiveMapping(STATES, JSON.stringify({ 'st-retired': 'done' }));
    expect(mapping['st-retired']).toBe('done');
  });

  it('falls back to the seeded defaults for a null, unparseable, or non-object blob', () => {
    const seeded = seedDefaultMapping(STATES);
    expect(resolveEffectiveMapping(STATES, null)).toEqual(seeded);
    expect(resolveEffectiveMapping(STATES, '')).toEqual(seeded);
    expect(resolveEffectiveMapping(STATES, 'not json')).toEqual(seeded);
    expect(resolveEffectiveMapping(STATES, '["idea"]')).toEqual(seeded);
  });

  it('ignores overlay entries whose value is not a known mapping target', () => {
    const mapping = resolveEffectiveMapping(
      STATES,
      JSON.stringify({ 'st-backlog': 'in-development', 'st-done': 42, 'st-todo': 'done' }),
    );
    expect(mapping['st-backlog']).toBe('idea');
    expect(mapping['st-done']).toBe('done');
    expect(mapping['st-todo']).toBe('done');
  });
});

describe('resolveStageIds', () => {
  it('resolves the five canonical stages off the seeded default board', () => {
    expect(resolveStageIds(raw, 1)).toEqual(STAGE);
  });

  it('falls back to a LABEL match when the canonical position moved', () => {
    // Someone re-ordered the board: 'Done' no longer sits at position 9.
    raw.prepare('UPDATE board_stages SET position = 99 WHERE id = ?').run(STAGE.done);
    expect(resolveStageIds(raw, 1).done).toBe(STAGE.done);
  });

  it('does NOT let a different stage at the canonical position hijack the target', () => {
    // Position 9 now carries the "Won't do" label — a pure positional resolve
    // would map Done onto the Won't-do stage. The label sanity check wins.
    raw.prepare('UPDATE board_stages SET position = 91 WHERE id = ?').run(STAGE.done);
    raw.prepare('UPDATE board_stages SET position = 9 WHERE id = ?').run(STAGE.wontdo);
    const stageIds = resolveStageIds(raw, 1);
    expect(stageIds.done).toBe(STAGE.done);
    expect(stageIds.wontdo).toBe(STAGE.wontdo);
  });

  it('falls back to POSITION when the stage was renamed and no label matches', () => {
    raw.prepare('UPDATE board_stages SET label = ? WHERE id = ?').run('Shipped', STAGE.done);
    expect(resolveStageIds(raw, 1).done).toBe(STAGE.done);
  });

  it('tolerates a curly apostrophe / different casing in the Won’t-do label', () => {
    raw.prepare('UPDATE board_stages SET label = ?, position = 92 WHERE id = ?').run(
      'Won’t Do',
      STAGE.wontdo,
    );
    expect(resolveStageIds(raw, 1).wontdo).toBe(STAGE.wontdo);
  });

  it('throws TrackerStageResolutionError when the project has no board', () => {
    raw.prepare('INSERT INTO projects (id, name, path) VALUES (2, ?, ?)').run('Proj 2', '/tmp/p2');
    expect(() => resolveStageIds(raw, 2)).toThrow(TrackerStageResolutionError);
  });

  it('throws TrackerStageResolutionError when a canonical stage is missing entirely', () => {
    raw.prepare('DELETE FROM board_stages WHERE id = ?').run(STAGE.wontdo);
    expect(() => resolveStageIds(raw, 1)).toThrow(/position 10/);
  });
});

describe('mappingTargetToStageId', () => {
  it('maps the four writable targets and returns null for don’t-import', () => {
    const stageIds = resolveStageIds(raw, 1);
    expect(mappingTargetToStageId('idea', stageIds)).toBe(STAGE.idea);
    expect(mappingTargetToStageId('ready', stageIds)).toBe(STAGE.ready);
    expect(mappingTargetToStageId('done', stageIds)).toBe(STAGE.done);
    expect(mappingTargetToStageId('wontdo', stageIds)).toBe(STAGE.wontdo);
    expect(mappingTargetToStageId('dont', stageIds)).toBeNull();
  });

  it('never targets the orchestrator-derived In-development stage', () => {
    const stageIds = resolveStageIds(raw, 1);
    // 'indev' is in this list deliberately: it NAMES that stage but must still
    // never resolve to it inbound, because a tracker actor writing a derived
    // stage is rejected as 'forbidden_stage'.
    const targeted = (['dont', 'idea', 'ready', 'done', 'wontdo', 'indev'] as const).map((t) =>
      mappingTargetToStageId(t, stageIds),
    );
    expect(targeted).not.toContain(STAGE.inDevelopment);
  });

  it('resolves the outbound-only target to no inbound stage at all', () => {
    const stageIds = resolveStageIds(raw, 1);
    expect(mappingTargetToStageId('indev', stageIds)).toBeNull();
  });
});

describe('stageIdToWriteBackGroup', () => {
  it('writes back for In development / Done / Won’t do', () => {
    const stageIds = resolveStageIds(raw, 1);
    expect(stageIdToWriteBackGroup(STAGE.inDevelopment, stageIds)).toBe('started');
    expect(stageIdToWriteBackGroup(STAGE.done, stageIds)).toBe('completed');
    expect(stageIdToWriteBackGroup(STAGE.wontdo, stageIds)).toBe('cancelled');
  });

  it('writes NOTHING for Idea, Ready for development, or an unknown stage', () => {
    const stageIds = resolveStageIds(raw, 1);
    expect(stageIdToWriteBackGroup(STAGE.idea, stageIds)).toBeNull();
    expect(stageIdToWriteBackGroup(STAGE.ready, stageIds)).toBeNull();
    expect(stageIdToWriteBackGroup('stage-somewhere-else', stageIds)).toBeNull();
  });
});

describe('pickWriteBackState', () => {
  it('picks the FIRST state in the group by the provider’s returned order', () => {
    expect(pickWriteBackState(STATES, 'started')?.id).toBe('st-progress');
    expect(pickWriteBackState(STATES, 'completed')?.id).toBe('st-done');
    expect(pickWriteBackState(STATES, 'cancelled')?.id).toBe('st-canceled');
  });

  it('returns null when the workspace has no state in that group', () => {
    const noStarted = STATES.filter((s) => s.group !== 'started');
    expect(pickWriteBackState(noStarted, 'started')).toBeNull();
    expect(pickWriteBackState([], 'completed')).toBeNull();
  });

  it("an 'indev' pin overrides the group guess for the started write-back", () => {
    // 'In Review' is the SECOND started state, so first-in-order would never
    // choose it. Pinning is the user overriding that choice.
    const mapping = { 'st-review': 'indev' } as const;
    expect(pickWriteBackState(STATES, 'started', mapping)?.id).toBe('st-review');
  });

  it("an 'indev' pin wins even when the pinned state's own group disagrees", () => {
    // The whole point on a provider whose groups are INFERRED from names: the
    // pin must beat a misclassification, not lose to it.
    const mapping = { 'st-todo': 'indev' } as const;
    expect(pickWriteBackState(STATES, 'started', mapping)?.id).toBe('st-todo');
  });

  it("rescues a workspace where NOTHING infers as 'started'", () => {
    const noStarted = STATES.filter((s) => s.group !== 'started');
    expect(pickWriteBackState(noStarted, 'started')).toBeNull();
    expect(pickWriteBackState(noStarted, 'started', { 'st-todo': 'indev' })?.id).toBe('st-todo');
  });

  it('leaves the other groups alone — the pin is started-only', () => {
    const mapping = { 'st-todo': 'indev' } as const;
    expect(pickWriteBackState(STATES, 'completed', mapping)?.id).toBe('st-done');
    expect(pickWriteBackState(STATES, 'cancelled', mapping)?.id).toBe('st-canceled');
  });

  it('falls back to first-in-order when nothing is pinned', () => {
    expect(pickWriteBackState(STATES, 'started', { 'st-todo': 'ready' })?.id).toBe('st-progress');
  });
});
