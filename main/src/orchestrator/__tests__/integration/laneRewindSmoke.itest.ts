/**
 * INTEGRATION smoke for the PER-LANE rewind chain — laneRewindHandler ->
 * RunExecutor.requestLaneRewind -> RunDirectives.laneRewinds -> the real
 * WorkflowController's `runFanOut`/`driveItem` inner loop — driven end to end
 * through a REAL RunExecutor + DefaultProgrammaticRunner over a migration-replay
 * temp DB, with a fakeSdk-backed CONTROLLABLE spawner standing in for the SDK
 * boundary. laneRewindHandler.test.ts already covers the handler's validation
 * branches against a hand-rolled mock DB with `vi.fn()` deps; what THAT unit
 * suite cannot show — and this file proves — is that the wiring the handler's
 * header docblock describes is not just plausible but ACTUALLY the wiring: that
 * `RunExecutor.requestLaneRewind` is the same object the live `WorkflowController`
 * reads by reference, that the controller's three lane-rewind consult points
 * really do fire mid-walk, and — the headline case — that killing a lane's
 * in-flight spawn while its rewind directive is already recorded rescues the
 * lane instead of failing it.
 *
 * PRODUCTION SEAM NOTE: the real abort seam is
 * `SubstrateDispatchFacade.abort(spawnKey)`, which is Electron-bound (resolves a
 * concrete CLI manager and kills its process) and cannot run standalone here.
 * This smoke stands in for it with the fake spawner's own stored `reject` — so
 * it proves the controller/executor/handler chain around the abort, not the
 * facade's process-kill mechanics themselves.
 *
 *   1. MID-TURN RESCUE (the headline) — a lane wedged inside its FIRST
 *      `implement` turn is un-stuck by a real handler call: the directive lands
 *      before the spawn is killed, so the resulting `failed` step result is
 *      absorbed as a rewind instead of failing the lane. The lane re-runs
 *      `implement` and reaches `integrated`; its sibling lane is never touched.
 *   2. ORDERING INVARIANT — proves the record-then-abort order the header
 *      documents is what the REAL executor wiring does, not just what the
 *      comment claims: the abort callback reads `peekRunDirectives` at the
 *      moment it fires and finds the target step already there.
 *   3. REFUSAL against a real DB — a lane whose persisted `sprint_batch_tasks`
 *      row is `integrated` is refused (`lane_not_live`) before anything is
 *      recorded — proven against the SAME schema surface production reads.
 *
 * Harness lineage: the migration-replay DB + real-RunExecutor scaffolding is
 * monitorDirectivesSmoke.itest.ts's; the fan-out workflow definition + FanOutDriver
 * shape is programmaticIntegration.test.ts's `fanOutDef()`/`makeFakeFanOutDriver()`
 * (generalized here into a driver that also writes the REAL sprint_batch_tasks
 * rows laneRewindHandler reads, since this suite needs the DB, not just an
 * in-memory lane map, to reflect the truth).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { DatabaseService } from '../../../database/database';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import { makeSpyLogger } from '../../__test_fixtures__/loggerLikeSpy';
import { DefaultProgrammaticRunner } from '../../programmatic/defaultProgrammaticRunner';
import { ReviewQueueHumanGate } from '../../programmatic/humanGate';
import { MonitorRegistry } from '../../programmatic/monitor';
import type { StepReporter } from '../../programmatic/programmaticRunHost';
import type { FanOutDriver } from '../../programmatic/types';
import { HumanStepManager } from '../../humanStepManager';
import { reviewItemChangeEvents, reviewItemProjectChannel } from '../../reviewItemRouter';
import { buildStepTransitionEvent } from '../../stepTransitionBridge';
import { StepResultStore } from '../../stepResultStore';
import { RunExecutor } from '../../runExecutor';
import type {
  ClaudeSpawnerLike,
  ClaudeSpawnerOptions,
  ProgrammaticRunner,
  WorkflowRegistryLike,
} from '../../runExecutor';
import { laneRewindHandler, type LaneRewindDeps } from '../../laneRewindHandler';
import type {
  WorkflowDefinition,
  WorkflowRow,
  WorkflowRunRow,
} from '../../../../../shared/types/workflows';
import {
  makeFakeQuery,
  sdkSystemInit,
  sdkAssistantText,
  sdkResultSuccess,
  type FakeQueryParams,
} from '../../../test/fakes/fakeSdk';

// ---------------------------------------------------------------------------
// Migration-replay temp DB (full current app schema — sprint_batch_tasks /
// tasks / boards / board_stages, exactly what laneRewindHandler reads).
// ---------------------------------------------------------------------------

interface TestDb {
  service: DatabaseService;
  db: ReturnType<DatabaseService['getDb']>;
  dir: string;
}

function buildMigrationDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-lanerewind-db-'));
  const service = new DatabaseService(path.join(dir, 'lanerewind.db'));
  service.initialize();
  const db = service.getDb();
  db.prepare('INSERT OR IGNORE INTO projects (id, name, path) VALUES (1, ?, ?)').run(
    'lanerewind',
    '/tmp/lanerewind',
  );
  return { service, db, dir };
}

function teardownDb(t: TestDb): void {
  t.db.close();
  fs.rmSync(t.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// A 1-outer-step fan-out workflow: 'execute-tasks' fans out over 'tasks' with a
// 3-step inner chain (implement -> code-review -> task-verify) — enough to hit
// both step-id-keyed branches the controller special-cases (SPRINT_CODE_REVIEW_STEP
// / SPRINT_TASK_VERIFY_STEP) while the fake spawner's void (no resultText)
// result keeps both branches on their "channel unavailable, advance" arm, so the
// chain settles purely on the fail-soft `runStep` status the wedge/abort drives.
// ---------------------------------------------------------------------------

const WORKFLOW_NAME = 'lane-rewind-smoke';
const FANOUT_INNER_IDS = ['implement', 'code-review', 'task-verify'] as const;

function fanOutDef(): WorkflowDefinition {
  return {
    id: WORKFLOW_NAME,
    phases: [
      {
        id: 'main',
        label: 'Main',
        color: '#3b6dd6',
        steps: [
          {
            id: 'execute-tasks',
            name: 'Execute tasks',
            agent: 'implement',
            mcps: [],
            retries: 0,
            fanOut: {
              over: 'tasks',
              inner: FANOUT_INNER_IDS.map((id) => ({
                id,
                name: id,
                agent: id,
                ...(id === 'implement' ? {} : { loopback: 'implement' as const }),
              })),
            },
          },
        ],
      },
    ],
  };
}

/**
 * Seed a workflow + a LIVE programmatic run stamped with `batch_id`, plus the
 * real `boards`/`board_stages`/`tasks`/`sprint_batch_tasks` rows laneRewindHandler
 * reads directly. Migrations run BEFORE the project row is inserted (see
 * buildMigrationDb), so migration 014/015's "seed a default board for every
 * EXISTING project" pass never reaches project 1 — a board + stage is seeded
 * here by hand to satisfy `tasks`'s NOT NULL FK columns.
 */
function seedFanOutRun(
  db: TestDb['db'],
  runId: string,
  batchId: string,
  itemIds: readonly string[],
): { workflowId: string; specJson: string } {
  const specJson = JSON.stringify(fanOutDef());
  const workflowId = `wf-${randomUUID()}`;
  db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, ?)`).run(
    workflowId,
    WORKFLOW_NAME,
    specJson,
  );
  db.prepare(
    `INSERT INTO workflow_runs
       (id, workflow_id, project_id, status, worktree_path, permission_mode_snapshot, execution_model, batch_id)
     VALUES (?, ?, 1, 'running', '/tmp/lane-rewind-wt', 'auto', 'programmatic', ?)`,
  ).run(runId, workflowId, batchId);

  const boardId = `board-${runId}`;
  const stageId = `stage-${runId}`;
  db.prepare(
    `INSERT INTO boards (id, project_id, name, kind, is_default) VALUES (?, 1, ?, 'default', 1)`,
  ).run(boardId, `Board ${runId}`);
  db.prepare(
    `INSERT INTO board_stages (id, board_id, label, color_oklch, position, write_policy)
     VALUES (?, ?, 'Todo', 'oklch(0.6 0.1 250)', 0, 'asserted')`,
  ).run(stageId, boardId);

  itemIds.forEach((itemId, idx) => {
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id) VALUES (?, 1, ?, ?, ?, ?)`,
    ).run(itemId, `TASK-${idx + 1}`, `Lane task ${itemId}`, boardId, stageId);
    db.prepare(`INSERT INTO sprint_batch_tasks (batch_id, task_id, status) VALUES (?, ?, 'queued')`).run(
      batchId,
      itemId,
    );
  });

  return { workflowId, specJson };
}

/** The in-memory run/workflow rows the RunExecutor's registry stub returns. */
function registryFor(
  runId: string,
  workflowId: string,
  specJson: string,
  batchId: string,
): WorkflowRegistryLike {
  const run: WorkflowRunRow = {
    id: runId,
    workflow_id: workflowId,
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: '/tmp/lane-rewind-wt',
    branch_name: null,
    execution_model: 'programmatic',
    batch_id: batchId,
    created_at: 'now',
    updated_at: 'now',
  };
  const workflow: WorkflowRow = {
    id: workflowId,
    project_id: 1,
    name: WORKFLOW_NAME,
    workflow_path: null,
    permission_mode: 'default',
    spec_json: specJson,
    created_at: 'now',
    archived_at: null,
  };
  return { getRunById: () => run, getById: () => workflow };
}

// ---------------------------------------------------------------------------
// Controllable fakeSdk-backed spawner: drains a clean fakeSdk scenario for every
// call EXCEPT the one call (if any) matching an armed one-shot predicate, which
// instead returns a promise that never settles on its own — its `reject` is
// stashed by spawnKey so a test can kill it later, exactly like
// SubstrateDispatchFacade.abort would (see the file header's production-seam
// note for why the facade itself isn't exercised here).
// ---------------------------------------------------------------------------

function makeControllableSpawner(): ClaudeSpawnerLike & {
  calls: ClaudeSpawnerOptions[];
  pending: Map<string, (err: Error) => void>;
  armWedge: (predicate: (o: ClaudeSpawnerOptions) => boolean) => void;
} {
  const calls: ClaudeSpawnerOptions[] = [];
  const pending = new Map<string, (err: Error) => void>();
  const emptyOptions: Options = {};
  let wedgePredicate: ((o: ClaudeSpawnerOptions) => boolean) | null = null;
  return {
    calls,
    pending,
    armWedge(predicate) {
      wedgePredicate = predicate;
    },
    async spawnCliProcess(o: ClaudeSpawnerOptions): Promise<void> {
      calls.push(o);
      if (wedgePredicate?.(o) === true) {
        // One-shot: consumed on match so a REWOUND re-drive of the same
        // spawnKey (e.g. lane t1's second `implement` call) drains normally.
        wedgePredicate = null;
        const key = o.spawnKey ?? o.panelId;
        return new Promise<void>((_resolve, reject) => {
          pending.set(key, reject);
        });
      }
      const events = [
        sdkSystemInit({ cwd: o.worktreePath }),
        sdkAssistantText(`agent turn for ${o.prompt.slice(0, 24)}`),
        sdkResultSuccess(),
      ];
      const params: FakeQueryParams = { prompt: o.prompt, options: emptyOptions };
      const q = makeFakeQuery(events)(params);
      for await (const _ev of q) {
        void _ev;
      }
    },
    abort: async () => {},
  };
}

// ---------------------------------------------------------------------------
// A FanOutDriver that ALSO writes the real `sprint_batch_tasks` row per drive —
// unlike programmaticIntegration.test.ts's purely in-memory FakeFanOutDriver,
// this suite needs the DB laneRewindHandler reads to reflect the lane's true
// live state (status / current_step_id), since the handler is exercised through
// its real DB-reading branches, not stubbed. `statusHistory` additionally
// records every status transition in order, in memory, so a test can assert a
// lane was NEVER driven to 'failed' — not just that its FINAL status isn't.
// ---------------------------------------------------------------------------

function makeDbBackedFanOutDriver(
  db: TestDb['db'],
  batchId: string,
  itemIds: readonly string[],
): FanOutDriver & { statusHistory: Map<string, string[]> } {
  const statusHistory = new Map<string, string[]>();
  return {
    statusHistory,
    resolveItems(_runId: string, over: string): string[] {
      return over === 'tasks' ? [...itemIds] : [];
    },
    driveLane(args): void {
      if (args.status !== undefined) {
        const hist = statusHistory.get(args.itemId) ?? [];
        hist.push(args.status);
        statusHistory.set(args.itemId, hist);
      }
      const sets: string[] = [];
      const params: (string | null)[] = [];
      if (args.status !== undefined) {
        sets.push('status = ?');
        params.push(args.status);
      }
      if (args.currentStepId !== undefined) {
        sets.push('current_step_id = ?');
        params.push(args.currentStepId);
      }
      if (sets.length === 0) return;
      params.push(batchId, args.itemId);
      db.prepare(`UPDATE sprint_batch_tasks SET ${sets.join(', ')} WHERE batch_id = ? AND task_id = ?`).run(
        ...params,
      );
    },
  };
}

/** Build a real DefaultProgrammaticRunner + a real RunExecutor over the given DB. */
function bootExecutor(
  t: TestDb,
  registry: WorkflowRegistryLike,
  spawner: ClaudeSpawnerLike,
  driver: FanOutDriver,
): { executor: RunExecutor } {
  const adapter = dbAdapter(t.db);
  const logger = makeSpyLogger();
  const store = new StepResultStore(t.db);
  const mgr = HumanStepManager.initialize(adapter);
  const reporter: StepReporter = {
    report: (rid, sid, status) => void buildStepTransitionEvent(rid, sid, status, adapter, logger),
  };
  const gate = new ReviewQueueHumanGate(mgr, reviewItemChangeEvents, reviewItemProjectChannel);
  const runner: ProgrammaticRunner = new DefaultProgrammaticRunner({
    spawner,
    reporter,
    gate,
    stepResultRecorder: (runId, report) =>
      store.record({
        runId,
        stepId: report.stepId,
        phaseId: report.phaseId,
        outcome: report.outcome,
        attempts: report.attempts,
        ...(report.error !== undefined ? { error: report.error } : {}),
      }),
    fanOutDriverFactory: () => driver,
    logger,
  });
  const executor = new RunExecutor(
    spawner, // orchestrated spawner slot (unused on the programmatic path)
    registry,
    logger,
    undefined, // promptReader
    undefined, // lifecycleTransitions
    undefined, // publisher
    undefined, // db
    undefined, // source
    undefined, // stepEmitter
    undefined, // taskStageDeriver
    undefined, // ideaBodyReader
    undefined, // sprintLaneTaskIds
    runner, // programmaticRunner (slot 13)
  );
  return { executor };
}

/**
 * Bounded poll — NOT a fixed sleep. Used to let the real walk actually reach the
 * wedged spawn before firing the rewind; the 120s vitest testTimeout is the
 * ultimate backstop, this throws well before that with a clear message.
 */
async function waitUntil(predicate: () => boolean, timeoutMs = 10_000, intervalMs = 10): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function laneStatus(db: TestDb['db'], batchId: string, taskId: string): { status: string; current_step_id: string | null } {
  return db
    .prepare('SELECT status, current_step_id FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
    .get(batchId, taskId) as { status: string; current_step_id: string | null };
}

afterEach(() => {
  HumanStepManager._resetForTesting();
  reviewItemChangeEvents.removeAllListeners();
  MonitorRegistry._resetForTesting();
});

describe('SMOKE: per-lane rewind through the real handler + executor + controller chain', () => {
  it('Case 1 — MID-TURN RESCUE: killing a wedged lane spawn AFTER the directive is recorded rescues the lane', async () => {
    const t = buildMigrationDb();
    try {
      const runId = `run-${randomUUID()}`;
      const batchId = `batch-${randomUUID()}`;
      const itemIds = ['t1', 't2'] as const;
      const { workflowId, specJson } = seedFanOutRun(t.db, runId, batchId, itemIds);
      const spawner = makeControllableSpawner();
      const driver = makeDbBackedFanOutDriver(t.db, batchId, itemIds);
      const { executor } = bootExecutor(
        t,
        registryFor(runId, workflowId, specJson, batchId),
        spawner,
        driver,
      );

      const t1SpawnKey = `${runId}:t1`;
      // Wedge ONLY the first `implement` turn of lane t1's spawnKey — its
      // SECOND implement call (after the rescue) must drain normally.
      spawner.armWedge((o) => o.spawnKey === t1SpawnKey && o.prompt.includes('`implement`'));

      const runPromise = executor.execute(runId);

      // Let the real walk actually reach the wedged spawn before rewinding.
      await waitUntil(() => spawner.pending.has(t1SpawnKey));
      // Sanity: the lane's live DB row really is mid-turn on 'implement' at this
      // point (driveItem writes the lane row BEFORE spawning).
      expect(laneStatus(t.db, batchId, 't1')).toEqual({ status: 'running', current_step_id: 'implement' });

      const deps: LaneRewindDeps = {
        db: dbAdapter(t.db),
        requestLaneRewind: (r, i, s) => executor.requestLaneRewind(r, i, s),
        listLiveSpawnKeys: () => [...spawner.pending.keys()],
        abortLaneSpawn: async (spawnKey) => {
          const reject = spawner.pending.get(spawnKey);
          if (!reject) throw new Error(`no pending spawn for key ${spawnKey}`);
          spawner.pending.delete(spawnKey);
          reject(new Error('killed by lane rewind'));
        },
        logger: makeSpyLogger(),
      };

      const result = await laneRewindHandler(runId, { taskRef: 't1', stepId: 'implement' }, deps);
      expect(result).toEqual({
        delivered: true,
        taskId: 't1',
        ref: 'TASK-1',
        stepId: 'implement',
        fromStepId: 'implement',
        abortedSpawn: true,
      });

      // The run reaches a normal terminal — execute() RESOLVES, it does not throw
      // (a real lane failure or an unhandled abort would make it reject).
      await expect(runPromise).resolves.toBeUndefined();

      // Lane t1 re-ran `implement`: the spawner received a SECOND `implement`
      // prompt under the SAME spawnKey (the wedged call + the rescued re-drive).
      const t1ImplementCalls = spawner.calls.filter(
        (c) => c.spawnKey === t1SpawnKey && c.prompt.includes('`implement`'),
      );
      expect(t1ImplementCalls).toHaveLength(2);
      // ...and exactly one call each for code-review / task-verify (the rescue
      // did not re-run anything past 'implement').
      expect(spawner.calls.filter((c) => c.spawnKey === t1SpawnKey && c.prompt.includes('`code-review`'))).toHaveLength(1);
      expect(spawner.calls.filter((c) => c.spawnKey === t1SpawnKey && c.prompt.includes('`task-verify`'))).toHaveLength(1);

      // Lane t1's final status is 'integrated', and it was NEVER driven to
      // 'failed' at any point in its history (the operator-induced spawn failure
      // never reached the fail path).
      expect(laneStatus(t.db, batchId, 't1').status).toBe('integrated');
      expect(driver.statusHistory.get('t1')).not.toContain('failed');

      // Sibling lane t2 walked its chain exactly once — untouched by t1's rescue.
      const t2SpawnKey = `${runId}:t2`;
      expect(spawner.calls.filter((c) => c.spawnKey === t2SpawnKey && c.prompt.includes('`implement`'))).toHaveLength(1);
      expect(spawner.calls.filter((c) => c.spawnKey === t2SpawnKey && c.prompt.includes('`code-review`'))).toHaveLength(1);
      expect(spawner.calls.filter((c) => c.spawnKey === t2SpawnKey && c.prompt.includes('`task-verify`'))).toHaveLength(1);
      expect(laneStatus(t.db, batchId, 't2').status).toBe('integrated');
      expect(driver.statusHistory.get('t2')).not.toContain('failed');

      // The directive was consumed exactly once — the map is empty afterwards.
      expect(executor.peekRunDirectives(runId)?.laneRewinds.size ?? 0).toBe(0);
    } finally {
      teardownDb(t);
    }
  });

  it('Case 2 — ORDERING INVARIANT: the rewind directive is already recorded when abortLaneSpawn fires', async () => {
    const t = buildMigrationDb();
    try {
      const runId = `run-${randomUUID()}`;
      const batchId = `batch-${randomUUID()}`;
      const itemIds = ['t1'] as const;
      const { workflowId, specJson } = seedFanOutRun(t.db, runId, batchId, itemIds);
      const spawner = makeControllableSpawner();
      const driver = makeDbBackedFanOutDriver(t.db, batchId, itemIds);
      const { executor } = bootExecutor(
        t,
        registryFor(runId, workflowId, specJson, batchId),
        spawner,
        driver,
      );

      const t1SpawnKey = `${runId}:t1`;
      spawner.armWedge((o) => o.spawnKey === t1SpawnKey && o.prompt.includes('`implement`'));

      const runPromise = executor.execute(runId);
      await waitUntil(() => spawner.pending.has(t1SpawnKey));

      // Captured INSIDE abortLaneSpawn, at the moment the real executor invokes
      // it — this is the load-bearing read: if `requestLaneRewind` were ever
      // called AFTER the abort instead of before, this would observe `undefined`
      // and the lane's wake-up would misread as a genuine failure (see the
      // handler's header docblock).
      let directiveAtAbortTime: string | undefined;
      const deps: LaneRewindDeps = {
        db: dbAdapter(t.db),
        requestLaneRewind: (r, i, s) => executor.requestLaneRewind(r, i, s),
        listLiveSpawnKeys: () => [...spawner.pending.keys()],
        abortLaneSpawn: async (spawnKey) => {
          directiveAtAbortTime = executor.peekRunDirectives(runId)?.laneRewinds.get('t1');
          const reject = spawner.pending.get(spawnKey);
          reject?.(new Error('killed by lane rewind'));
          spawner.pending.delete(spawnKey);
        },
      };

      const result = await laneRewindHandler(runId, { taskRef: 't1', stepId: 'implement' }, deps);
      expect(result).toMatchObject({ delivered: true, abortedSpawn: true });
      expect(directiveAtAbortTime).toBe('implement');

      await expect(runPromise).resolves.toBeUndefined();
      expect(laneStatus(t.db, batchId, 't1').status).toBe('integrated');
    } finally {
      teardownDb(t);
    }
  });

  it('Case 3 — REFUSAL against a real DB: an integrated lane is refused without recording anything', async () => {
    const t = buildMigrationDb();
    try {
      const runId = `run-${randomUUID()}`;
      const batchId = `batch-${randomUUID()}`;
      const { workflowId, specJson } = seedFanOutRun(t.db, runId, batchId, ['t1']);
      // Overwrite the lane the seed helper created as 'queued' — this case wants
      // a SETTLED lane (the wave loop never un-settles a lane; that is the
      // whole-run rewind's job, not this one).
      t.db
        .prepare(`UPDATE sprint_batch_tasks SET status = 'integrated', current_step_id = 'task-verify' WHERE batch_id = ? AND task_id = 't1'`)
        .run(batchId);

      // No live walk is driven for this case — the handler's DB reads alone are
      // enough to prove the refusal, and a bare RunExecutor (never execute()'d)
      // is enough to prove nothing was recorded on its directive map.
      const registry = registryFor(runId, workflowId, specJson, batchId);
      const spawner = makeControllableSpawner();
      const logger = makeSpyLogger();
      const executor = new RunExecutor(spawner, registry, logger);

      let requestLaneRewindCalls = 0;
      let abortLaneSpawnCalls = 0;
      const deps: LaneRewindDeps = {
        db: dbAdapter(t.db),
        requestLaneRewind: (r, i, s) => {
          requestLaneRewindCalls += 1;
          executor.requestLaneRewind(r, i, s);
        },
        listLiveSpawnKeys: () => [],
        abortLaneSpawn: async () => {
          abortLaneSpawnCalls += 1;
        },
        logger,
      };

      const result = await laneRewindHandler(runId, { taskRef: 't1', stepId: 'implement' }, deps);
      expect(result).toEqual({ noOp: true, reason: 'lane_not_live', laneStatus: 'integrated' });

      // Nothing was recorded — the liveness check ran BEFORE the record step, so
      // requestLaneRewind (and therefore abortLaneSpawn) was never invoked, and
      // the run's directives map has no entry at all for this run.
      expect(requestLaneRewindCalls).toBe(0);
      expect(abortLaneSpawnCalls).toBe(0);
      expect(executor.peekRunDirectives(runId)).toBeUndefined();

      // Confirmed against the real row: still 'integrated', untouched.
      expect(laneStatus(t.db, batchId, 't1').status).toBe('integrated');
    } finally {
      teardownDb(t);
    }
  });
});
