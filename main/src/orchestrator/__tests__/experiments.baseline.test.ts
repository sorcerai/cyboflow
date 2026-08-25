/**
 * Baseline-arm A/B experiments (variant-vs-current-workflow) — the sentinel-arm
 * path added so a workflow with a SINGLE variant can be tested head-to-head
 * against the live workflow (BASELINE_VARIANT_SENTINEL).
 *
 * Driven through the exported `startExperiment` core (mirroring
 * experiments.router.test.ts) plus a router caller for switchToRotation, with a
 * fake launcher that records each arm's launchOptions and a registry that returns
 * NULL for the sentinel (as the real one does — there is no `__baseline__` row).
 *
 * Verifies:
 *   1. A sentinel arm skips the variant registry lookup and launches with
 *      `{ baseline: true, experiment }` (never a requestedVariantId); the paired
 *      real-variant arm still pins its variant.
 *   2. Both arms baseline is rejected (BAD_REQUEST — at least one must be a variant).
 *   3. switchToRotation rejects an experiment with a baseline arm
 *      (PRECONDITION_FAILED), while a two-real-variant experiment activates both.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TaskChangeRouter } from '../taskChangeRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  startExperiment,
  setExperimentsDeps,
  experimentsRouter,
  type ExperimentsDeps,
  type ExperimentArmQuickConfig,
} from '../trpc/routers/experiments';
import { insertExperiment, updateExperimentStatus } from '../experimentStore';
import { createContext } from '../trpc/context';
import {
  BASELINE_VARIANT_SENTINEL,
  QUICK_ARM_SENTINEL,
  type ExperimentArm,
  type WorkflowVariantRow,
} from '../../../../shared/types/experiments';

/** Recorded launch invocation: which arm + the launchOptions the launcher received. */
interface RecordedLaunch {
  arm: ExperimentArm | undefined;
  opts:
    | {
        requestedVariantId?: string;
        experiment?: { experimentId: string; arm: ExperimentArm };
        baseline?: boolean;
      }
    | undefined;
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP);`);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');
  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const f of [
    '006_cyboflow_schema.sql', '011_workflow_step_tracking.sql', '014_native_tasks.sql',
    '015_entity_model_rebuild.sql', '016_review_items.sql', '024_archive_in_place.sql', '028_idea_attachments.sql',
    '085_review_item_audience.sql',
  ]) db.exec(readFileSync(join(migDir, f), 'utf-8'));
  db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
  db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_arm TEXT;');
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_idea_id TEXT;');
  for (const t of ['ideas', 'epics', 'tasks']) {
    db.exec(`ALTER TABLE ${t} ADD COLUMN experiment_id TEXT;`);
    db.exec(`ALTER TABLE ${t} ADD COLUMN caused_by_run_id TEXT;`);
  }
  db.exec(`CREATE TABLE experiments (
    id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, workflow_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'side_by_side', base_branch TEXT NOT NULL, base_sha TEXT NOT NULL,
    variant_a_id TEXT NOT NULL, variant_b_id TEXT NOT NULL, run_a_id TEXT, run_b_id TEXT,
    session_a_id TEXT, session_b_id TEXT, seed_idea_id TEXT, seed_idea_clone_a_id TEXT, seed_idea_clone_b_id TEXT,
    status TEXT NOT NULL DEFAULT 'running', winner_run_id TEXT, winner_arm TEXT, merge_sha TEXT,
    decided_at TEXT, rerun_of_experiment_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);`);
  db.prepare(`INSERT INTO workflows (id, project_id, name, spec_json) VALUES ('wf', 1, 'planner', '{}')`).run();
  // Migration 059: category (feature|bug|chore) — an unconditional column in
  // insertEntity/readEntity now (mirrors priority), so every create needs it.
  db.exec(readFileSync(join(migDir, '059_entity_category.sql'), 'utf-8'));
  return db;
}

function variant(id: string): WorkflowVariantRow {
  return {
    id, workflow_id: 'wf', label: id, spec_json: '{}', agent_overrides_json: null,
    model: null, execution_model: null, agent_provider: null, agent_runtime: null,
    weight: 1, status: 'draft', archived_at: null, created_at: '', updated_at: '',
  };
}

/** Recorded createArmSession invocation (TASK-121 widening: quickConfig + sentinel runId). */
interface RecordedArmSession {
  nameHint: string;
  quickConfig: ExperimentArmQuickConfig | undefined;
  runId: string;
}

interface Harness {
  db: Database.Database;
  deps: ExperimentsDeps;
  launches: RecordedLaunch[];
  getVariantCalls: string[];
  activated: string[];
  armSessionCalls: RecordedArmSession[];
}

function makeHarness(): Harness {
  const raw = buildDb();
  const db = dbAdapter(raw);
  const tcr = TaskChangeRouter.initialize(db);
  const launches: RecordedLaunch[] = [];
  const getVariantCalls: string[] = [];
  const activated: string[] = [];
  const armSessionCalls: RecordedArmSession[] = [];

  const deps: ExperimentsDeps = {
    db,
    runLauncher: {
      launch: async (_wf, _pp, _sub, _tid, ideaId, _sid, _pm, _bb, _stids, _pid, _em, _fids, _model, _ev, _verify, opts) => {
        launches.push({ arm: opts?.experiment?.arm, opts });
        const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
        raw
          .prepare(
            `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, experiment_id, seed_idea_id)
             VALUES (?, 'wf', 1, 'running', 'default', ?, ?)`,
          )
          .run(runId, opts?.experiment?.experimentId ?? null, ideaId ?? null);
        return { runId, worktreePath: `/wt/${runId}`, branchName: `b/${runId}`, permissionMode: 'default' };
      },
    },
    worktreeManager: {
      getProjectMainBranch: async () => 'main',
      getHeadCommit: async () => 'basesha0',
    },
    // Mirrors the real createArmSession (TASK-121): it ALWAYS mints a run via
    // createQuickSessionCore, quick config or not — for a non-quick arm this run
    // is the (unused-by-startExperiment) infra host sentinel, untagged; for a
    // quick arm it's the `__quick__` sentinel that startExperiment stamps and
    // records as that arm's run. Each call gets its own fresh id + row.
    createArmSession: async ({ nameHint, quickConfig }) => {
      const runId = `armsess_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
      raw
        .prepare(
          `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, experiment_id, experiment_arm, seed_idea_id)
           VALUES (?, 'wf', 1, 'awaiting_review', 'default', NULL, NULL, NULL)`,
        )
        .run(runId);
      armSessionCalls.push({ nameHint, quickConfig, runId });
      return { sessionId: `sess_${randomUUID().slice(0, 8)}`, worktreePath: '/wt', runId };
    },
    taskChangeRouter: tcr,
    dismissSession: async () => {},
    cancelRun: async () => {},
    // The real registry has NO row for the baseline sentinel — mirror that so the
    // test genuinely exercises the "skip lookup for a baseline arm" branch.
    getVariant: (id) => {
      getVariantCalls.push(id);
      return id === BASELINE_VARIANT_SENTINEL ? null : variant(id);
    },
    getWorkflow: () => ({ id: 'wf', name: 'planner' }),
    getProjectPath: () => '/tmp/p1',
    setVariantStatus: (id) => {
      activated.push(id);
    },
    setVariantWeight: () => {},
    setBaselineRotation: () => {},
    adoptWorkflowSpec: () => {},
  };
  return { db: raw, deps, launches, getVariantCalls, activated, armSessionCalls };
}

function armLaunch(h: Harness, arm: ExperimentArm): RecordedLaunch | undefined {
  return h.launches.find((l) => l.arm === arm);
}

/** Raw workflow_runs row read (for asserting the quick-arm stamp landed). */
function runRow(
  h: Harness,
  id: string,
): { id: string; experiment_id: string | null; experiment_arm: string | null } | undefined {
  return h.db
    .prepare('SELECT id, experiment_id, experiment_arm FROM workflow_runs WHERE id = ?')
    .get(id) as { id: string; experiment_id: string | null; experiment_arm: string | null } | undefined;
}

/** Raw experiments row read (for asserting run_a_id/run_b_id got recorded). */
function expRow(h: Harness, id: string): { run_a_id: string | null; run_b_id: string | null } | undefined {
  return h.db.prepare('SELECT run_a_id, run_b_id FROM experiments WHERE id = ?').get(id) as
    | { run_a_id: string | null; run_b_id: string | null }
    | undefined;
}

describe('baseline-arm experiments', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
  });

  it('a baseline arm skips the variant lookup and launches with baseline:true; the variant arm pins its variant', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: BASELINE_VARIANT_SENTINEL,
      variantBId: 'vB',
    });

    // Both arms launched; the experiment row exists.
    expect(res.armA.runId).toBeTruthy();
    expect(res.armB.runId).toBeTruthy();

    // The sentinel arm was NEVER looked up in the registry (that lookup was skipped).
    expect(h.getVariantCalls).not.toContain(BASELINE_VARIANT_SENTINEL);
    // The real-variant arm WAS looked up.
    expect(h.getVariantCalls).toContain('vB');

    // Arm A (baseline) launched as baseline — baseline:true, no requestedVariantId.
    const a = armLaunch(h, 'A');
    expect(a?.opts?.baseline).toBe(true);
    expect(a?.opts?.requestedVariantId).toBeUndefined();
    expect(a?.opts?.experiment).toEqual({ experimentId: res.experimentId, arm: 'A' });

    // Arm B (variant) launched pinned — requestedVariantId, no baseline flag.
    const b = armLaunch(h, 'B');
    expect(b?.opts?.requestedVariantId).toBe('vB');
    expect(b?.opts?.baseline).toBeUndefined();
    expect(b?.opts?.experiment).toEqual({ experimentId: res.experimentId, arm: 'B' });
  });

  it('works with the baseline as arm B too (variant A vs baseline B)', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: 'vA',
      variantBId: BASELINE_VARIANT_SENTINEL,
    });
    expect(h.getVariantCalls).toContain('vA');
    expect(h.getVariantCalls).not.toContain(BASELINE_VARIANT_SENTINEL);
    expect(armLaunch(h, 'A')?.opts?.requestedVariantId).toBe('vA');
    expect(armLaunch(h, 'B')?.opts?.baseline).toBe(true);
    expect(armLaunch(h, 'B')?.opts?.requestedVariantId).toBeUndefined();
    expect(res.experimentId).toBeTruthy();
  });

  it('rejects when BOTH arms are the baseline sentinel', async () => {
    const h = makeHarness();
    await expect(
      startExperiment(h.deps, {
        projectId: 1,
        workflowId: 'wf',
        variantAId: BASELINE_VARIANT_SENTINEL,
        variantBId: BASELINE_VARIANT_SENTINEL,
      }),
    ).rejects.toThrow(/at least one arm must be a variant|both cannot be the baseline/i);
    // Nothing launched.
    expect(h.launches).toHaveLength(0);
  });

  it('switchToRotation opts the baseline into rotation and activates the variant (baseline arm)', async () => {
    const h = makeHarness();
    const baselineRotations: Array<{ workflowId: string; patch: { inRotation?: boolean; weight?: number } }> = [];
    setExperimentsDeps({
      ...h.deps,
      setBaselineRotation: (workflowId, patch) => baselineRotations.push({ workflowId, patch }),
    });
    const exp = insertExperiment(h.deps.db, {
      projectId: 1,
      workflowId: 'wf',
      baseBranch: 'main',
      baseSha: 'basesha0',
      variantAId: BASELINE_VARIANT_SENTINEL,
      variantBId: 'vB',
    });
    // Settle it (switchToRotation requires a settled experiment first).
    updateExperimentStatus(h.deps.db, exp.id, 'abandoned');

    const caller = experimentsRouter.createCaller(createContext({ db: h.deps.db }));
    const out = await caller.switchToRotation({ experimentId: exp.id });
    expect(out.status).toBe('abandoned');
    // The baseline arm opted the live baseline into rotation (migration 054)...
    expect(baselineRotations).toEqual([{ workflowId: 'wf', patch: { inRotation: true } }]);
    // ...and only the real-variant arm was activated (no setVariantStatus('__baseline__')).
    expect(h.activated).toEqual(['vB']);
  });

  it('switchToRotation still activates BOTH variants for a two-real-variant experiment', async () => {
    const h = makeHarness();
    setExperimentsDeps(h.deps);
    const exp = insertExperiment(h.deps.db, {
      projectId: 1,
      workflowId: 'wf',
      baseBranch: 'main',
      baseSha: 'basesha0',
      variantAId: 'vA',
      variantBId: 'vB',
    });
    updateExperimentStatus(h.deps.db, exp.id, 'decided');

    const caller = experimentsRouter.createCaller(createContext({ db: h.deps.db }));
    const out = await caller.switchToRotation({ experimentId: exp.id });
    expect(out.status).toBe('decided');
    expect(h.activated).toEqual(expect.arrayContaining(['vA', 'vB']));
  });
});

/**
 * Quick-arm launch (TASK-120) — an arm pinned to QUICK_ARM_SENTINEL skips both
 * the variant registry lookup AND deps.runLauncher.launch entirely: its run is
 * the `__quick__` sentinel createArmSession already minted (TASK-121), and
 * startExperiment stamps that pre-existing run's experiment_id/experiment_arm
 * (stampQuickArmRunExperimentTag) instead of launching a new one.
 */
describe('quick-arm launch (TASK-120)', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
  });

  it('quick vs variant: skips the registry lookup + launcher for the quick arm, stamps its sentinel run, launches the variant arm normally', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'vB',
    });

    // The quick arm was never looked up in the variant registry; the real variant was.
    expect(h.getVariantCalls).not.toContain(QUICK_ARM_SENTINEL);
    expect(h.getVariantCalls).toContain('vB');

    // Arm A (quick) never went through the launcher; arm B (variant) did, pinned.
    expect(armLaunch(h, 'A')).toBeUndefined();
    const b = armLaunch(h, 'B');
    expect(b?.opts?.requestedVariantId).toBe('vB');
    expect(b?.opts?.baseline).toBeUndefined();

    // The quick arm's sentinel run (createArmSession's first call) got stamped
    // with the experiment id + arm 'A', and its id is what startExperiment returns.
    expect(h.armSessionCalls).toHaveLength(2);
    const sentinelRunId = h.armSessionCalls[0]!.runId;
    expect(res.armA.runId).toBe(sentinelRunId);
    const stamped = runRow(h, sentinelRunId);
    expect(stamped?.experiment_id).toBe(res.experimentId);
    expect(stamped?.experiment_arm).toBe('A');

    // The experiment row's run_a_id points at that same sentinel run.
    expect(expRow(h, res.experimentId)?.run_a_id).toBe(sentinelRunId);

    // Arm B's run came from the launcher, not from createArmSession's (unused) sentinel.
    expect(res.armB.runId).not.toBe(h.armSessionCalls[1]!.runId);
    expect(res.armB.runId).toBeTruthy();
  });

  it('quick vs baseline: both skip-paths coexist (neither arm hits the registry or gets rejected by the identical-arms guard)', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: BASELINE_VARIANT_SENTINEL,
    });

    expect(h.getVariantCalls).not.toContain(QUICK_ARM_SENTINEL);
    expect(h.getVariantCalls).not.toContain(BASELINE_VARIANT_SENTINEL);

    // Arm A (quick) skipped the launcher; arm B (baseline) launched with baseline:true.
    expect(armLaunch(h, 'A')).toBeUndefined();
    expect(armLaunch(h, 'B')?.opts?.baseline).toBe(true);

    const sentinelRunId = h.armSessionCalls[0]!.runId;
    expect(res.armA.runId).toBe(sentinelRunId);
    expect(runRow(h, sentinelRunId)?.experiment_arm).toBe('A');
    expect(res.armB.runId).toBeTruthy();
  });

  it('quick vs quick: the identical-arms guard is relaxed — two independent sentinel runs are minted and tagged A/B', async () => {
    const h = makeHarness();
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: QUICK_ARM_SENTINEL,
    });

    // Neither arm hit the launcher.
    expect(h.launches).toHaveLength(0);
    // Two independent createArmSession calls, each minting its own sentinel run.
    expect(h.armSessionCalls).toHaveLength(2);
    const [runIdA, runIdB] = h.armSessionCalls.map((c) => c.runId);
    expect(runIdA).not.toBe(runIdB);

    expect(res.armA.runId).toBe(runIdA);
    expect(res.armB.runId).toBe(runIdB);
    expect(runRow(h, runIdA!)?.experiment_arm).toBe('A');
    expect(runRow(h, runIdA!)?.experiment_id).toBe(res.experimentId);
    expect(runRow(h, runIdB!)?.experiment_arm).toBe('B');
    expect(runRow(h, runIdB!)?.experiment_id).toBe(res.experimentId);

    const exp = expRow(h, res.experimentId);
    expect(exp?.run_a_id).toBe(runIdA);
    expect(exp?.run_b_id).toBe(runIdB);
    expect(exp?.run_a_id).not.toBe(exp?.run_b_id);
  });

  it('two identical REAL variant ids are still rejected (the relaxed guard only exempts quick-vs-quick)', async () => {
    const h = makeHarness();
    await expect(
      startExperiment(h.deps, {
        projectId: 1,
        workflowId: 'wf',
        variantAId: 'vA',
        variantBId: 'vA',
      }),
    ).rejects.toThrow(/at least one arm must be a variant|both cannot be the baseline/i);
    expect(h.launches).toHaveLength(0);
  });

  it('threads quickConfigA/quickConfigB through createArmSession only for the quick arm; the non-quick arm gets quickConfig: undefined', async () => {
    const h = makeHarness();
    const quickConfigA: ExperimentArmQuickConfig = {
      substrate: 'interactive',
      agentProvider: 'codex',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
    };
    await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'vB',
      quickConfigA,
      // quickConfigB deliberately omitted — vB is not a quick arm, so it should
      // never be threaded through even if the caller had supplied it (it didn't).
    });

    expect(h.armSessionCalls).toHaveLength(2);
    expect(h.armSessionCalls[0]!.quickConfig).toEqual(quickConfigA);
    expect(h.armSessionCalls[1]!.quickConfig).toBeUndefined();
  });
});

/**
 * Quick-arm config persistence + rerun replay (migration 098) — startExperiment
 * records each quick arm's config in experiment_quick_configs so
 * experiments.rerun (which forwards only the variant ids) can replay the SAME
 * matchup instead of silently launching a default Claude-SDK quick arm. Reads
 * and writes are both fail-soft: a pre-098 DB / missing row / garbage payload
 * degrades to launch-defaults, never a throw.
 */
describe('quick-arm config persistence + rerun replay (migration 098)', () => {
  afterEach(() => {
    TaskChangeRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
  });

  /** Migration 098's table shape, applied on top of buildDb()'s pre-098 schema. */
  function addQuickConfigsTable(h: Harness): void {
    // Execute the REAL migration file (not a duplicated CREATE TABLE) so a
    // typo / missing index / non-idempotent change in 098 fails these tests.
    const migPath = join(__dirname, '..', '..', 'database', 'migrations', '098_experiment_quick_configs.sql');
    h.db.exec(readFileSync(migPath, 'utf-8'));
    // Idempotence guard: the migration must be safe to re-apply (CREATE ... IF
    // NOT EXISTS), matching the filename-keyed ledger's crash-replay behavior.
    h.db.exec(readFileSync(migPath, 'utf-8'));
  }

  function quickConfigRows(h: Harness, experimentId: string): Array<{ arm: string; config_json: string }> {
    return h.db
      .prepare('SELECT arm, config_json FROM experiment_quick_configs WHERE experiment_id = ? ORDER BY arm')
      .all(experimentId) as Array<{ arm: string; config_json: string }>;
  }

  it("startExperiment persists each quick arm's config (and only the quick arms')", async () => {
    const h = makeHarness();
    addQuickConfigsTable(h);
    const quickConfigA: ExperimentArmQuickConfig = {
      substrate: 'interactive',
      agentProvider: 'claude',
      agentRuntime: 'claude-interactive',
      model: 'opus',
      permissionMode: 'acceptEdits',
    };
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'vB',
      quickConfigA,
    });

    const rows = quickConfigRows(h, res.experimentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.arm).toBe('A');
    expect(JSON.parse(rows[0]!.config_json)).toEqual(quickConfigA);
  });

  it('startExperiment on a pre-098 DB (no table) still succeeds — the persist is fail-soft', async () => {
    const h = makeHarness(); // buildDb() has no experiment_quick_configs table
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'vB',
      quickConfigA: { model: 'opus' },
    });
    expect(res.experimentId).toBeTruthy();
    expect(h.armSessionCalls[0]!.quickConfig).toEqual({ model: 'opus' });
  });

  it('rerun replays the persisted quick config into the new experiment and re-persists it (chains further reruns)', async () => {
    const h = makeHarness();
    addQuickConfigsTable(h);
    setExperimentsDeps(h.deps);
    const quickConfigA: ExperimentArmQuickConfig = {
      substrate: 'sdk',
      agentProvider: 'codex',
      agentRuntime: 'codex-sdk',
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
    };
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'vB',
      quickConfigA,
    });
    updateExperimentStatus(h.deps.db, res.experimentId, 'decided');

    const caller = experimentsRouter.createCaller(createContext({ db: h.deps.db }));
    const out = await caller.rerun({ experimentId: res.experimentId });

    // Two arm sessions for the source + two for the rerun; the rerun's quick arm
    // (call index 2) received the ORIGINAL config, the variant arm none.
    expect(h.armSessionCalls).toHaveLength(4);
    expect(h.armSessionCalls[2]!.quickConfig).toEqual(quickConfigA);
    expect(h.armSessionCalls[3]!.quickConfig).toBeUndefined();

    // Re-persisted under the NEW experiment so a rerun-of-a-rerun still replays.
    const rows = quickConfigRows(h, out.experimentId);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.config_json)).toEqual(quickConfigA);
  });

  it('rerun of a source with NO persisted config (legacy pre-098 experiment) launches the quick arm with defaults', async () => {
    const h = makeHarness();
    addQuickConfigsTable(h);
    setExperimentsDeps(h.deps);
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'vB',
      // no quickConfigA — mirrors a pre-098 experiment with nothing persisted
    });
    updateExperimentStatus(h.deps.db, res.experimentId, 'abandoned');

    const caller = experimentsRouter.createCaller(createContext({ db: h.deps.db }));
    await caller.rerun({ experimentId: res.experimentId });

    expect(h.armSessionCalls).toHaveLength(4);
    expect(h.armSessionCalls[2]!.quickConfig).toBeUndefined();
  });

  it('rerun degrades a persisted config that fails the wire cross-field rule (provider without runtime) to defaults', async () => {
    const h = makeHarness();
    addQuickConfigsTable(h);
    setExperimentsDeps(h.deps);
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'vB',
      quickConfigA: { model: 'opus', agentRuntime: 'claude-sdk' },
    });
    updateExperimentStatus(h.deps.db, res.experimentId, 'decided');
    // A row written before the cross-field refine existed (or by hand): the
    // core would drop the provider while the stamp derivation would claim
    // codex-sdk — replay must reject it rather than recreate the inconsistency.
    h.db
      .prepare('UPDATE experiment_quick_configs SET config_json = ? WHERE experiment_id = ?')
      .run(JSON.stringify({ substrate: 'interactive', agentProvider: 'codex' }), res.experimentId);

    const caller = experimentsRouter.createCaller(createContext({ db: h.deps.db }));
    await caller.rerun({ experimentId: res.experimentId });

    expect(h.armSessionCalls).toHaveLength(4);
    expect(h.armSessionCalls[2]!.quickConfig).toBeUndefined();
  });

  it('rerun ignores an unparseable persisted config (defaults, no throw)', async () => {
    const h = makeHarness();
    addQuickConfigsTable(h);
    setExperimentsDeps(h.deps);
    const res = await startExperiment(h.deps, {
      projectId: 1,
      workflowId: 'wf',
      variantAId: QUICK_ARM_SENTINEL,
      variantBId: 'vB',
      quickConfigA: { model: 'opus' },
    });
    updateExperimentStatus(h.deps.db, res.experimentId, 'decided');
    h.db
      .prepare('UPDATE experiment_quick_configs SET config_json = ? WHERE experiment_id = ?')
      .run('{not json', res.experimentId);

    const caller = experimentsRouter.createCaller(createContext({ db: h.deps.db }));
    await caller.rerun({ experimentId: res.experimentId });

    expect(h.armSessionCalls).toHaveLength(4);
    expect(h.armSessionCalls[2]!.quickConfig).toBeUndefined();
  });
});
