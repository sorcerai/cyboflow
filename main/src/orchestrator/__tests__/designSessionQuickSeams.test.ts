/**
 * Design Mode v0 — __quick__ two-way seam parity for design sessions
 * (docs/ideas/design-mode.md AC: "the __quick__ two-way seams behave
 * correctly for design sessions (rotation skipped, revival policy
 * unchanged)").
 *
 * Design sessions ride the SAME `__quick__` sentinel workflow as plain quick
 * sessions (no new workflow name — design-mode.md "Session plumbing":
 * `createQuickSessionCore`, `sessions.is_quick=1`). Every seam this suite
 * touches keys off `workflows.name === '__quick__'` (or, for
 * reviveQuickRunToRunning, the JOIN to that same row) — NONE of them ever
 * read `sessions.design_idea_id` — so inheritance from the plain-quick-session
 * behaviour is automatic. These tests PIN that: a session with
 * `design_idea_id` set, riding a `__quick__` sentinel run, gets IDENTICAL
 * treatment to a plain quick session at all three seams:
 *
 *   (a) VariantResolver.resolveForLaunch  — rotation is skipped (source='none').
 *   (b) experimentStore.computeRotationArmSet — the __quick__ workflow never
 *       contributes arms to a rotation experiment.
 *   (c) reviveQuickRunToRunning (services/cyboflow/transitions.ts) — revives
 *       the sentinel run to 'running' from any terminal status, same as a
 *       plain quick session.
 *
 * Real functions are imported and exercised — no reimplementation. Schema is
 * a minimal in-memory composite of the fixtures transitions.test.ts /
 * variantResolver.test.ts / experimentStore.rotation.test.ts already use
 * (workflows / workflow_variants / experiments / workflow_runs), plus a
 * `sessions` table carrying `design_idea_id` so the scenario is realistic —
 * even though (deliberately) nothing under test ever queries it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { VariantResolver } from '../variantResolver';
import { computeRotationArmSet } from '../experimentStore';
import { reviveQuickRunToRunning } from '../../services/cyboflow/transitions';

const QUICK_WF_ID = 'wf-quick-design-001';
const QUICK_RUN_ID = 'run-quick-design-001';
const DESIGN_SESSION_ID = 'sess-design-001';
const DESIGN_IDEA_ID = 'idea-design-001';

const SCHEMA = `
  CREATE TABLE workflows (
    id TEXT PRIMARY KEY, project_id INTEGER, name TEXT NOT NULL,
    spec_json TEXT NOT NULL DEFAULT '{}',
    baseline_in_rotation INTEGER NOT NULL DEFAULT 0,
    baseline_rotation_weight INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE workflow_variants (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, label TEXT NOT NULL,
    spec_json TEXT NOT NULL DEFAULT '{}', agent_overrides_json TEXT, model TEXT, execution_model TEXT,
    agent_provider TEXT, agent_runtime TEXT,
    weight INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft',
    archived_at TEXT,  -- migration 116
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE experiments (
    id TEXT PRIMARY KEY, project_id INTEGER, workflow_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'side_by_side' CHECK (kind IN ('side_by_side','rotation')),
    status TEXT NOT NULL DEFAULT 'running'
      CHECK (status IN ('running','grading','decided','abandoned','superseded')),
    rerun_of_experiment_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, project_id INTEGER NOT NULL,
    worktree_path TEXT, status TEXT NOT NULL, policy_json TEXT NOT NULL DEFAULT '{}',
    error_message TEXT, ended_at TEXT, started_at TEXT,
    -- outcome (migration 014-era column on the real chain): reviveQuickRunToRunning
    -- conditionally clears machine-stamped terminal outcomes on revival.
    outcome TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  -- Additive column per migration 082 (design-mode.md "Idea link — integrity
  -- contract"): nullable, no FK (sessions is a legacy table; integrity is
  -- chokepoint-enforced, not database-enforced).
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, project_id INTEGER, run_id TEXT, is_quick INTEGER NOT NULL DEFAULT 1,
    design_idea_id TEXT
  );
`;

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  db.prepare(
    "INSERT INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, '__quick__', '{}')",
  ).run(QUICK_WF_ID);
  return db;
}

/** Seed the sentinel run + its linked design session (design_idea_id set). */
function seedDesignQuickRun(db: Database.Database, status: string, opts: { error?: string; ended?: string } = {}): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json, error_message, ended_at)
     VALUES (?, ?, 1, '/tmp/wt', ?, '{}', ?, ?)`,
  ).run(QUICK_RUN_ID, QUICK_WF_ID, status, opts.error ?? null, opts.ended ?? null);
  db.prepare(
    `INSERT INTO sessions (id, project_id, run_id, is_quick, design_idea_id)
     VALUES (?, 1, ?, 1, ?)`,
  ).run(DESIGN_SESSION_ID, QUICK_RUN_ID, DESIGN_IDEA_ID);
}

describe('Design Mode v0 — __quick__ seam parity (design-mode.md)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  // (a) VariantResolver.resolveForLaunch — rotation skipped for the sentinel
  //     workflow, regardless of whether a design session rides it.
  it('VariantResolver.resolveForLaunch returns the no-variant result for the __quick__ sentinel workflow hosting a design session', () => {
    seedDesignQuickRun(db, 'running');

    const resolver = new VariantResolver(dbAdapter(db), () => 0);
    const assignment = resolver.resolveForLaunch(QUICK_WF_ID);

    expect(assignment).toEqual({ variant: null, source: 'none', rotationExperimentId: null });
  });

  // (b) experimentStore.computeRotationArmSet — the __quick__ workflow never
  //     contributes arms, so a design session can never be attributed to a
  //     rotation experiment.
  it('computeRotationArmSet excludes the __quick__ workflow hosting a design session (returns [])', () => {
    seedDesignQuickRun(db, 'running');

    expect(computeRotationArmSet(dbAdapter(db), QUICK_WF_ID)).toEqual([]);
  });

  // (c) reviveQuickRunToRunning — revival policy is unchanged: the design
  //     session's sentinel run revives from any terminal status exactly like
  //     a plain quick session's does (transitions.test.ts pins the
  //     plain-quick-session cases this mirrors).
  it("reviveQuickRunToRunning revives the design session's force-failed sentinel run to 'running' and clears the failure stamp", () => {
    seedDesignQuickRun(db, 'failed', { error: 'app_restart', ended: '2026-06-29 00:00:00' });

    const result = reviveQuickRunToRunning(db, QUICK_RUN_ID);

    expect(result).toEqual({ revived: true, fromStatus: 'failed' });
    const run = db
      .prepare('SELECT status, error_message, ended_at FROM workflow_runs WHERE id = ?')
      .get(QUICK_RUN_ID) as { status: string; error_message: string | null; ended_at: string | null };
    expect(run.status).toBe('running');
    expect(run.error_message).toBeNull();
    expect(run.ended_at).toBeNull();
  });

  it("reviveQuickRunToRunning is a no-op when the design session's sentinel run is already 'running' (parity with a plain quick session)", () => {
    seedDesignQuickRun(db, 'running');

    const result = reviveQuickRunToRunning(db, QUICK_RUN_ID);

    expect(result).toEqual({ revived: false, fromStatus: 'running' });
  });
});
