/**
 * Unit tests for laneRewindHandler — the monitor's PER-LANE rewind: pull ONE
 * live sprint fan-out lane back to an earlier inner step while the run, the
 * outer walk, and every sibling lane keep going.
 *
 * Covers: the live-programmatic-run gate, ref-or-id lane resolution, the lane
 * liveness gate (queued / integrated / failed refused with the status attached),
 * target validation against the run's FROZEN fan-out inner chain, the
 * backward-only guard (including the `awaiting-verify` park marker resolving to
 * the visual-verify step), the record-BEFORE-interrupt ordering invariant, the
 * live-spawn-key narrowing, and the fail-soft abort.
 *
 * Standalone: a minimal in-memory SQLite (workflow_runs / workflows / tasks /
 * sprint_batch_tasks) plus fake seams — no electron / services imports. DB style
 * mirrors partialSprintGateSummary.test.ts; dep style mirrors
 * rewindRunHandler.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { laneRewindHandler, type LaneRewindDeps } from '../laneRewindHandler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A sprint-shaped chain: implement → code-review → task-verify → visual-verify. */
const SPRINT_SPEC = JSON.stringify({
  id: 'wf-sprint',
  phases: [
    {
      id: 'p1',
      label: 'P1',
      color: '#111111',
      steps: [
        { id: 'seed', name: 'Seed', agent: 'seed' },
        {
          id: 'execute',
          name: 'Execute',
          agent: 'orchestrate',
          fanOut: {
            over: 'tasks',
            inner: [
              { id: 'implement', name: 'Implement', agent: 'implement' },
              { id: 'code-review', name: 'Code review', agent: 'code-review', loopback: 'implement' },
              { id: 'task-verify', name: 'Task verify', agent: 'task-verify', loopback: 'implement' },
              { id: 'visual-verify', name: 'Visual verify', agent: 'visual-verify' },
            ],
          },
        },
      ],
    },
  ],
});

/** A workflow with NO fan-out step at all (verify-setup shaped). */
const NO_FANOUT_SPEC = JSON.stringify({
  id: 'wf-flat',
  phases: [{ id: 'p1', label: 'P1', color: '#111111', steps: [{ id: 'prove', name: 'Prove', agent: 'prove' }] }],
});

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT, spec_json TEXT);
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_id TEXT,
      project_id INTEGER,
      status TEXT,
      execution_model TEXT,
      batch_id TEXT
    );
    CREATE TABLE tasks (id TEXT PRIMARY KEY, project_id INTEGER, ref TEXT, title TEXT);
    CREATE TABLE sprint_batch_tasks (
      batch_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      current_step_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

interface SeedOpts {
  status?: string;
  executionModel?: string;
  batchId?: string | null;
  specJson?: string;
  laneStatus?: string;
  laneStepId?: string | null;
  taskRef?: string | null;
}

/** Seed a live programmatic sprint run with ONE running lane on 'code-review'. */
function seed(db: Database.Database, opts: SeedOpts = {}): void {
  db.prepare('INSERT INTO workflows (id, name, spec_json) VALUES (?, ?, ?)').run(
    'wf-1',
    'sprint',
    opts.specJson ?? SPRINT_SPEC,
  );
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, execution_model, batch_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'run-1',
    'wf-1',
    1,
    opts.status ?? 'running',
    opts.executionModel ?? 'programmatic',
    opts.batchId === undefined ? 'batch-1' : opts.batchId,
  );
  db.prepare('INSERT INTO tasks (id, project_id, ref, title) VALUES (?, ?, ?, ?)').run(
    't1',
    1,
    opts.taskRef === undefined ? 'TASK-001' : opts.taskRef,
    'Do a thing',
  );
  db.prepare(
    'INSERT INTO sprint_batch_tasks (batch_id, task_id, status, current_step_id) VALUES (?, ?, ?, ?)',
  ).run('batch-1', 't1', opts.laneStatus ?? 'running', opts.laneStepId === undefined ? 'code-review' : opts.laneStepId);
}

function makeDeps(
  db: Database.Database,
  overrides: Partial<LaneRewindDeps> = {},
): LaneRewindDeps & {
  requestLaneRewind: ReturnType<typeof vi.fn>;
  abortLaneSpawn: ReturnType<typeof vi.fn>;
} {
  const requestLaneRewind = vi.fn<(runId: string, itemId: string, stepId: string) => void>();
  const abortLaneSpawn = vi.fn<(spawnKey: string) => Promise<void>>().mockResolvedValue(undefined);
  return {
    db: dbAdapter(db),
    requestLaneRewind,
    listLiveSpawnKeys: () => ['run-1:t1'],
    abortLaneSpawn,
    ...overrides,
  } as LaneRewindDeps & {
    requestLaneRewind: ReturnType<typeof vi.fn>;
    abortLaneSpawn: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('laneRewindHandler', () => {
  describe('happy path', () => {
    it('records the directive, kills the lane spawn, and reports the lane it moved', async () => {
      const db = buildDb();
      seed(db);
      const deps = makeDeps(db);

      const result = await laneRewindHandler('run-1', { taskRef: 'TASK-001', stepId: 'implement' }, deps);

      expect(result).toEqual({
        delivered: true,
        taskId: 't1',
        ref: 'TASK-001',
        stepId: 'implement',
        fromStepId: 'code-review',
        abortedSpawn: true,
      });
      expect(deps.requestLaneRewind).toHaveBeenCalledWith('run-1', 't1', 'implement');
      expect(deps.abortLaneSpawn).toHaveBeenCalledWith('run-1:t1');
    });

    it('resolves the lane by opaque task id as well as by display ref', async () => {
      const db = buildDb();
      seed(db);
      const deps = makeDeps(db);

      const result = await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps);

      expect(result).toMatchObject({ delivered: true, taskId: 't1' });
    });

    it('allows target === the lane current step ("restart this step")', async () => {
      const db = buildDb();
      seed(db, { laneStepId: 'code-review' });
      const deps = makeDeps(db);

      const result = await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'code-review' }, deps);

      expect(result).toMatchObject({ delivered: true, stepId: 'code-review' });
    });

    it("treats the 'awaiting-verify' park marker as the visual-verify step, so any inner target is backward", async () => {
      // The park marker is NOT an inner-chain id; resolving it to the step the
      // lane parks AT is what lets a merge-gate-parked lane be rewound at all.
      const db = buildDb();
      seed(db, { laneStepId: 'awaiting-verify' });
      const deps = makeDeps(db);

      const result = await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps);

      expect(result).toMatchObject({ delivered: true, fromStepId: 'awaiting-verify' });
    });

    it('allows any valid target when the lane pointer is null (no anchor to be prior to)', async () => {
      const db = buildDb();
      seed(db, { laneStepId: null });
      const deps = makeDeps(db);

      const result = await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'task-verify' }, deps);

      expect(result).toMatchObject({ delivered: true });
    });

    it('falls back to the task id as the reported ref when the task has none', async () => {
      const db = buildDb();
      seed(db, { taskRef: null });
      const deps = makeDeps(db);

      const result = await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps);

      expect(result).toMatchObject({ delivered: true, ref: 't1' });
    });
  });

  describe('ordering invariant', () => {
    it('records the directive BEFORE aborting the spawn', async () => {
      // A lane woken before its directive exists reads the wake as a genuine step
      // failure — which would fail the very lane the operator is rescuing.
      const db = buildDb();
      seed(db);
      const order: string[] = [];
      const deps = makeDeps(db, {
        requestLaneRewind: vi.fn(() => {
          order.push('record');
        }),
        abortLaneSpawn: vi.fn(async () => {
          order.push('abort');
        }),
      });

      await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps);

      expect(order).toEqual(['record', 'abort']);
    });

    it('still delivers when the spawn abort rejects (fail-soft — the directive stands)', async () => {
      const db = buildDb();
      seed(db);
      const warn = vi.fn();
      const deps = makeDeps(db, {
        abortLaneSpawn: vi.fn().mockRejectedValue(new Error('no such panel')),
        logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
      });

      const result = await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps);

      expect(result).toMatchObject({ delivered: true, abortedSpawn: false });
      expect(deps.requestLaneRewind).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    });

    it('skips the abort entirely when the lane has no live spawn key', async () => {
      // An idle lane between inner steps has no process to kill; the loop-head
      // consult picks the directive up on its own.
      const db = buildDb();
      seed(db);
      const deps = makeDeps(db, { listLiveSpawnKeys: () => ['run-1:t2'] });

      const result = await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps);

      expect(result).toMatchObject({ delivered: true, abortedSpawn: false });
      expect(deps.abortLaneSpawn).not.toHaveBeenCalled();
      expect(deps.requestLaneRewind).toHaveBeenCalledTimes(1);
    });
  });

  describe('refusals (nothing is recorded or interrupted)', () => {
    const expectInert = (deps: ReturnType<typeof makeDeps>): void => {
      expect(deps.requestLaneRewind).not.toHaveBeenCalled();
      expect(deps.abortLaneSpawn).not.toHaveBeenCalled();
    };

    it('refuses an unknown run', async () => {
      const db = buildDb();
      const deps = makeDeps(db);
      expect(await laneRewindHandler('nope', { taskRef: 't1', stepId: 'implement' }, deps)).toEqual({
        noOp: true,
        reason: 'not_found',
      });
      expectInert(deps);
    });

    it('refuses an orchestrated run', async () => {
      const db = buildDb();
      seed(db, { executionModel: 'orchestrated' });
      const deps = makeDeps(db);
      expect(await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps)).toEqual({
        noOp: true,
        reason: 'not_programmatic',
      });
      expectInert(deps);
    });

    it.each(['failed', 'paused', 'awaiting_review', 'completed'])(
      'refuses a run that is not live (status %s) — there is no lane loop to edit',
      async (status) => {
        const db = buildDb();
        seed(db, { status });
        const deps = makeDeps(db);
        expect(await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps)).toEqual({
          noOp: true,
          reason: 'run_not_running',
        });
        expectInert(deps);
      },
    );

    it('refuses a run with no sprint batch', async () => {
      const db = buildDb();
      seed(db, { batchId: null });
      const deps = makeDeps(db);
      expect(await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps)).toEqual({
        noOp: true,
        reason: 'no_fan_out',
      });
      expectInert(deps);
    });

    it('refuses a workflow whose definition declares no fan-out chain', async () => {
      const db = buildDb();
      seed(db, { specJson: NO_FANOUT_SPEC });
      const deps = makeDeps(db);
      expect(await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'prove' }, deps)).toEqual({
        noOp: true,
        reason: 'no_fan_out',
      });
      expectInert(deps);
    });

    it('refuses an unknown task ref', async () => {
      const db = buildDb();
      seed(db);
      const deps = makeDeps(db);
      expect(await laneRewindHandler('run-1', { taskRef: 'TASK-999', stepId: 'implement' }, deps)).toEqual({
        noOp: true,
        reason: 'unknown_task',
      });
      expectInert(deps);
    });

    it('refuses a task that has no lane in this run’s batch', async () => {
      const db = buildDb();
      seed(db);
      db.prepare('INSERT INTO tasks (id, project_id, ref, title) VALUES (?, ?, ?, ?)').run(
        't9', 1, 'TASK-009', 'Unbatched',
      );
      const deps = makeDeps(db);
      expect(await laneRewindHandler('run-1', { taskRef: 'TASK-009', stepId: 'implement' }, deps)).toEqual({
        noOp: true,
        reason: 'lane_not_found',
      });
      expectInert(deps);
    });

    it.each(['queued', 'integrated', 'failed', 'blocked'])(
      'refuses a lane that is not running (status %s) and reports its status',
      async (laneStatus) => {
        const db = buildDb();
        seed(db, { laneStatus });
        const deps = makeDeps(db);
        expect(await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'implement' }, deps)).toEqual({
          noOp: true,
          reason: 'lane_not_live',
          laneStatus,
        });
        expectInert(deps);
      },
    );

    it('refuses a target that is not one of the fan-out inner steps', async () => {
      // Notably an OUTER step id: the outer walk is the whole-run rewind's business.
      const db = buildDb();
      seed(db);
      const deps = makeDeps(db);
      expect(await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'execute' }, deps)).toEqual({
        noOp: true,
        reason: 'unknown_step',
      });
      expectInert(deps);
    });

    it('refuses a FORWARD target — rewind only goes backward', async () => {
      const db = buildDb();
      seed(db, { laneStepId: 'implement' });
      const deps = makeDeps(db);
      expect(await laneRewindHandler('run-1', { taskRef: 't1', stepId: 'task-verify' }, deps)).toEqual({
        noOp: true,
        reason: 'target_not_prior',
      });
      expectInert(deps);
    });
  });
});
