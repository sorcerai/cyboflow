/**
 * enqueueTaskVerification — the main-process, MCP-free enqueue seam the
 * programmatic controller uses for the agentless visual-verify step
 * (verification-agent redesign §5.3/§5.4). Mirrors the MCP handler's dual-format
 * enqueue: reads the run's immutable verify stamps + project id, resolves the
 * chain, captures the snapshot sha, FORCES the lane ref onto both persisted
 * columns, keys idempotency on runId:ref:attempt, and returns enqueued/skipped.
 *
 * The DB is a minimal in-memory pair of tables (workflow_runs + the migration-078
 * verification_requests) — the only rows this seam reads/writes; the scheduler's
 * backends/judge are empty/fake (nothing is drained during the test).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VerificationScheduler } from '../verificationScheduler';
import { enqueueTaskVerification, FORBIDDEN_DEP_COMMAND_ERROR } from '../enqueueFromTask';
import { VerifyRunbookStore } from '../runbookStore';
import { checkRunbookPin } from '../verificationAgentRunner';
import { parseVerificationTaskV1 } from '../../../../../shared/types/visualVerification';
import { dbAdapter } from '../../__test_fixtures__/dbAdapter';
import type { VerificationTaskV1, ResolvedVisualVerifyConfig, VlmJudge } from '../../../../../shared/types/visualVerification';
import type { VerifyRunbookV1 } from '../../../../../shared/types/verifyRunbook';

const fakeJudge: VlmJudge = {
  judge: async () => ({
    status: 'pass',
    confidence: 1,
    issues: [],
    feedback: '',
    judgedFileNames: [],
    baselineUsed: false,
    model: 'fake',
  }),
};

const baseConfig: ResolvedVisualVerifyConfig = {
  enabled: true,
  defaultType: 'static-render-snapshot',
  vlmConfidenceThreshold: 0.7,
  maxPerRunJudgeCalls: 4,
  devServerPorts: [5173],
  simulatorDevices: [],
  queuedAgeCeilingMs: 15 * 60 * 1000,
  agentSlots: 2,
  autoBootstrapRunbook: false,
};

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id             TEXT PRIMARY KEY,
      project_id     INTEGER,
      status         TEXT NOT NULL DEFAULT 'running',
      verify_enabled INTEGER,
      verify_type    TEXT,
      verify_chain   TEXT
    );
    CREATE TABLE verification_requests (
      id               TEXT PRIMARY KEY,
      run_id           TEXT NOT NULL,
      project_id       INTEGER NOT NULL,
      status           TEXT NOT NULL DEFAULT 'queued',
      verify_type      TEXT NOT NULL,
      deliverable_json TEXT NOT NULL,
      chain_json       TEXT,
      current_backend  TEXT,
      attempt          INTEGER NOT NULL DEFAULT 0,
      verdict_json     TEXT,
      error_message    TEXT,
      enqueued_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      leased_at        DATETIME,
      ended_at         DATETIME,
      task_json        TEXT,
      report_json      TEXT,
      delivery_state   TEXT,
      snapshot_sha     TEXT,
      enqueue_key      TEXT,
      -- migration 095 (docs/proposals/verification-setup-flow.md §3/§3.6): the
      -- modality stamp this seam delegates to scheduler.enqueue, and the
      -- setup-proof flag it threads through.
      modality         TEXT,
      setup_proof      INTEGER NOT NULL DEFAULT 0,
      -- migration 096 (§5.2 seam 3): the content-addressed runbook PIN.
      runbook_hash          TEXT,
      runbook_local_version INTEGER,
      -- migration 107 (docs/proposals/lane-runbook-bootstrap.md §5): the
      -- lane-driven bootstrap proof kind.
      bootstrap_proof       INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE verify_runbook_local (
      project_id            INTEGER NOT NULL,
      modality              TEXT NOT NULL,
      portable_hash         TEXT NOT NULL,
      portable_json         TEXT NOT NULL,
      version               INTEGER NOT NULL DEFAULT 1,
      status                TEXT NOT NULL CHECK (status IN ('proven','unproven-draft')),
      bindings_json         TEXT,
      proof_json            TEXT,
      input_hash            TEXT,
      host_fingerprint_json TEXT,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (project_id, modality)
    );
  `);
  return db;
}

/**
 * A minimal portable runbook declaring the `web` modality with a build + serve
 * form deliberately DIFFERENT from what the composer guesses below, so the merge
 * is observable in the persisted `task_json`.
 */
const RUNBOOK: VerifyRunbookV1 = {
  version: 1,
  modalities: {
    web: {
      build: ['pnpm run build:web'],
      serve: { cmd: 'pnpm run preview -- --port ${PORT}', readyWhen: { urlPath: '/', timeoutMs: 30_000 } },
      attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
    },
  },
};

/**
 * A store over the in-memory DB with FAKE IO — the three injected probes are the
 * store's only filesystem contact, so faking them keeps this suite about the
 * enqueue seam rather than about disk. `readPortableFile` always answers the
 * runbook above, which is what makes `status()` able to reach `'proven'`.
 */
function buildRunbookStore(db: Database.Database): VerifyRunbookStore {
  return new VerifyRunbookStore(dbAdapter(db), {
    readPortableFile: async () => JSON.stringify(RUNBOOK),
    computeInputHash: async () => 'input-hash-1',
    hostFingerprint: async () => 'host-fingerprint-1',
  });
}

function seedRun(
  db: Database.Database,
  opts: { runId: string; enabled?: boolean; type?: string | null; chain?: string; projectId?: number },
): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, project_id, status, verify_enabled, verify_type, verify_chain)
     VALUES (?, ?, 'running', ?, ?, ?)`,
  ).run(
    opts.runId,
    opts.projectId ?? 1,
    opts.enabled === false ? 0 : 1,
    opts.type === undefined ? 'static-render-snapshot' : opts.type,
    opts.chain ?? JSON.stringify(['capturePage', 'playwright']),
  );
}

function initScheduler(
  db: Database.Database,
  runbookStore?: VerifyRunbookStore,
  over: Partial<Parameters<typeof VerificationScheduler.initialize>[0]> = {},
): void {
  VerificationScheduler.initialize({
    db: dbAdapter(db),
    backends: {},
    judge: fakeJudge,
    artifactsDirResolver: () => '/tmp/a',
    config: baseConfig,
    ...(runbookStore ? { runbookStore } : {}),
    ...over,
  });
}

const task: VerificationTaskV1 = {
  version: 1,
  summary: 'Check the login form renders',
  behaviors: [{ id: 'b1', description: 'renders', expected: 'form visible' }],
};

/** A real throwaway git repo so captureSnapshotSha resolves a real HEAD sha. */
let gitRepo: string;
beforeAll(() => {
  gitRepo = mkdtempSync(join(tmpdir(), 'enqueue-from-task-git-'));
  const run = (...args: string[]): void => void execFileSync('git', args, { cwd: gitRepo });
  run('init', '-q');
  run('config', 'user.email', 't@t.dev');
  run('config', 'user.name', 'T');
  writeFileSync(join(gitRepo, 'f.txt'), 'hi');
  run('add', '.');
  run('commit', '-q', '-m', 'init');
});
afterAll(() => rmSync(gitRepo, { recursive: true, force: true }));

let db: Database.Database;
beforeEach(() => {
  VerificationScheduler._resetForTesting();
  db = buildDb();
});
afterEach(() => {
  VerificationScheduler._resetForTesting();
  db.close();
});

function readRow(id: string): {
  deliverable_json: string;
  task_json: string | null;
  snapshot_sha: string | null;
  enqueue_key: string | null;
  verify_type: string;
  chain_json: string | null;
} {
  return db
    .prepare(
      'SELECT deliverable_json, task_json, snapshot_sha, enqueue_key, verify_type, chain_json FROM verification_requests WHERE id = ?',
    )
    .get(id) as ReturnType<typeof readRow>;
}

describe('enqueueTaskVerification — the snapshot sha is captured AFTER the bootstrap', () => {
  // The bootstrap writes up to TWO commits onto the lane's branch: the rung-1
  // config edit and the runbook. Capturing the sha before them pinned the request
  // to a tree where the runbook's own enabling edit does not exist — live-observed
  // as a `failed`/`ambiguous` terminal for a deliverable that was fine, because
  // the exported `portEnv` was read by a config that had not been edited yet.
  it('pins the sha the bootstrap left behind, not the one it started from', async () => {
    seedRun(db, { runId: 'run-snap', enabled: true });
    initScheduler(db);

    const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo }).toString().trim();
    const spy = vi
      .spyOn(VerificationScheduler.getInstance(), 'maybeBootstrapRunbook')
      .mockImplementation(async () => {
        // Stands in for §8.1's config-edit commit + the runbook commit.
        writeFileSync(join(gitRepo, 'app.config.mjs'), 'export default { port: Number(process.env.PORT ?? 4320) };\n');
        execFileSync('git', ['add', '.'], { cwd: gitRepo });
        execFileSync('git', ['commit', '-q', '-m', 'chore: port-from-env'], { cwd: gitRepo });
        return { kind: 'not-attempted' } as Awaited<ReturnType<VerificationScheduler['maybeBootstrapRunbook']>>;
      });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-snap',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('enqueued');
    const after = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRepo }).toString().trim();
    expect(after).not.toBe(before);
    expect(result.outcome === 'enqueued' && readRow(result.requestId).snapshot_sha).toBe(after);
    spy.mockRestore();
  });
});

describe('enqueueTaskVerification', () => {
  it('a disabled run → skipped(verification-disabled), enqueues nothing', async () => {
    seedRun(db, { runId: 'run-1', enabled: false });
    initScheduler(db);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-1',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result).toEqual({ outcome: 'skipped', reason: 'verification-disabled' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  it('a missing run → skipped(verification-disabled)', async () => {
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'nope',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'verification-disabled' });
  });

  it('an enabled run → enqueued: dual-writes deliverable_json + task_json, forces the lane ref, keys on runId:ref:attempt, captures the sha', async () => {
    seedRun(db, { runId: 'run-1', chain: JSON.stringify(['capturePage', 'peekaboo']) });
    initScheduler(db);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-1',
      // task carries a DIFFERENT taskRef — the lane ref must win on BOTH columns.
      task: { ...task, taskRef: 'WRONG-REF' },
      laneTaskRef: 'TASK-007',
      attempt: 2,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    const requestId = result.outcome === 'enqueued' ? result.requestId : '';
    const row = readRow(requestId);

    // Dual-write: legacy deliverable_json (derived) + verbatim task_json, BOTH
    // carrying the forced lane ref.
    expect(JSON.parse(row.deliverable_json)).toEqual({ intent: task.summary, taskRef: 'TASK-007' });
    expect(JSON.parse(row.task_json as string).taskRef).toBe('TASK-007');
    // Idempotency key = runId:laneTaskRef:attempt.
    expect(row.enqueue_key).toBe('run-1:TASK-007:2');
    // A real git worktree → a real 40-hex snapshot sha.
    expect(row.snapshot_sha).toMatch(/^[0-9a-f]{40}$/);
    // Chain = FALLBACK_CHAINS[type] ∩ stamped chain, in FALLBACK order.
    expect(JSON.parse(row.chain_json as string)).toEqual(['capturePage', 'peekaboo']);
    expect(row.verify_type).toBe('static-render-snapshot');
  });

  it('threads setupProof through to setup_proof, and lets scheduler.enqueue own the modality stamp (§3.6)', async () => {
    seedRun(db, { runId: 'run-proof' });
    initScheduler(db);

    const proof = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-proof',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
      setupProof: true,
    });
    const lane = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-proof',
      task,
      laneTaskRef: 'TASK-002',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(proof.outcome).toBe('enqueued');
    expect(lane.outcome).toBe('enqueued');
    const flags = (id: string): { setup_proof: number; modality: string | null } =>
      db
        .prepare('SELECT setup_proof, modality FROM verification_requests WHERE id = ?')
        .get(id) as { setup_proof: number; modality: string | null };

    expect(flags(proof.outcome === 'enqueued' ? proof.requestId : '').setup_proof).toBe(1);
    expect(flags(lane.outcome === 'enqueued' ? lane.requestId : '').setup_proof).toBe(0);
    // The task has no attach:'cdp' serve, so both resolve to the web modality —
    // derived ONCE, inside scheduler.enqueue, not duplicated in this seam.
    expect(flags(lane.outcome === 'enqueued' ? lane.requestId : '').modality).toBe('web');
  });

  it('a sha-capture failure (non-git worktree) → null snapshot_sha but STILL enqueues', async () => {
    seedRun(db, { runId: 'run-1' });
    initScheduler(db);
    const notARepo = mkdtempSync(join(tmpdir(), 'enqueue-not-git-'));
    try {
      const result = await enqueueTaskVerification({
        db: dbAdapter(db),
        runId: 'run-1',
        task,
        laneTaskRef: 'TASK-001',
        attempt: 1,
        worktreePath: notARepo,
      });
      expect(result.outcome).toBe('enqueued');
      const requestId = result.outcome === 'enqueued' ? result.requestId : '';
      expect(readRow(requestId).snapshot_sha).toBeNull();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it('the SAME runId:ref:attempt key is idempotent (a crash re-walk reuses the existing request)', async () => {
    seedRun(db, { runId: 'run-1' });
    initScheduler(db);
    const args = {
      db: dbAdapter(db),
      runId: 'run-1',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    };
    const a = await enqueueTaskVerification(args);
    const b = await enqueueTaskVerification(args);
    expect(a.outcome).toBe('enqueued');
    expect(b).toEqual(a); // same requestId
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 1 });
  });

  it('an uninitialized scheduler → skipped(scheduler-unavailable), never throws', async () => {
    seedRun(db, { runId: 'run-1' });
    // Deliberately NOT initialized.
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-1',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'scheduler-unavailable' });
  });

  it('an unstamped verify_type → skipped(verification-disabled)', async () => {
    seedRun(db, { runId: 'run-1', type: null });
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-1',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result).toEqual({ outcome: 'skipped', reason: 'verification-disabled' });
  });
});

// ---------------------------------------------------------------------------
// §7.2 — the ENQUEUE half of the dependency guard
// ---------------------------------------------------------------------------

describe('enqueueTaskVerification — §7.2 forbidden dependency commands', () => {
  it('a build step that installs is REJECTED — no row is written', async () => {
    seedRun(db, { runId: 'run-guard' });
    initScheduler(db);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-guard',
      task: { ...task, build: ['pnpm install --frozen-lockfile', 'pnpm run build'] },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('skipped');
    const reason = result.outcome === 'skipped' ? result.reason : '';
    expect(reason).toContain(FORBIDDEN_DEP_COMMAND_ERROR);
    // The offending command is named VERBATIM so the loopback can fix it.
    expect(reason).toContain('pnpm install --frozen-lockfile');
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  it('a serve command that installs before serving is REJECTED', async () => {
    seedRun(db, { runId: 'run-guard-2' });
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-guard-2',
      task: { ...task, serve: { cmd: 'pnpm install && pnpm dev --port ${PORT}' } },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('skipped');
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  it('a clean build/serve is untouched', async () => {
    seedRun(db, { runId: 'run-clean' });
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-clean',
      task: { ...task, build: ['pnpm run build'], serve: { cmd: 'pnpm dev --port ${PORT}' } },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('enqueued');
  });
});

// ---------------------------------------------------------------------------
// §5.2 seam 3 — pinned compose-time injection
// ---------------------------------------------------------------------------

describe('enqueueTaskVerification — §5.2 seam 3 pinned runbook injection', () => {
  /** The composer's own (wrong) guess at how to stand the project up. */
  const guessedTask: VerificationTaskV1 = {
    ...task,
    build: ['pnpm run build'],
    serve: { cmd: 'pnpm dev --port ${PORT}' },
    viewports: [{ width: 1280, height: 800, label: 'desktop' }],
  };

  function readPersisted(id: string): {
    task_json: string | null;
    runbook_hash: string | null;
    runbook_local_version: number | null;
    deliverable_json: string;
  } {
    return db
      .prepare(
        'SELECT task_json, runbook_hash, runbook_local_version, deliverable_json FROM verification_requests WHERE id = ?',
      )
      .get(id) as ReturnType<typeof readPersisted>;
  }

  it('a PROVEN runbook replaces build/serve/attestation, keeps summary/behaviors/viewports/ref, and stamps the pin', async () => {
    seedRun(db, { runId: 'run-inject' });
    const store = buildRunbookStore(db);
    const registered = await store.registerDraft(1, gitRepo, 'web');
    expect('hash' in registered).toBe(true);
    const { hash, version } = registered as { hash: string; version: number };
    expect(store.markProven(1, 'web', hash, version, '{}')).toEqual({ ok: true });
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-inject',
      task: guessedTask,
      laneTaskRef: 'TASK-042',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('enqueued');
    const row = readPersisted(result.outcome === 'enqueued' ? result.requestId : '');

    const persisted = JSON.parse(row.task_json as string) as VerificationTaskV1;
    // REPLACED by the runbook — the composer's guess is exactly the part §1 says
    // has never once been right.
    expect(persisted.build).toEqual(['pnpm run build:web']);
    expect(persisted.serve?.cmd).toBe('pnpm run preview -- --port ${PORT}');
    expect(persisted.attestation).toEqual({ kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' });
    // KEPT from the composed task — what is being checked this time.
    expect(persisted.summary).toBe(task.summary);
    expect(persisted.behaviors).toEqual(task.behaviors);
    expect(persisted.viewports).toEqual([{ width: 1280, height: 800, label: 'desktop' }]);
    expect(persisted.taskRef).toBe('TASK-042');
    // The PIN — both halves, on the row the runner will read.
    expect(row.runbook_hash).toBe(hash);
    expect(row.runbook_local_version).toBe(version);
  });

  it('ROUND-TRIPS: the persisted task re-parses into something the runner accepts against the same pin', async () => {
    // The load-bearing end-to-end invariant of §5.2 seam 3. The merged task is
    // JSON-persisted, then re-parsed by `parseVerificationTaskV1` before the
    // runner compares it to the entry `parseVerifyRunbookV1` produced. If those
    // two validators ever rebuild build/serve/attestation differently, EVERY
    // pinned request would self-reject at execution with a mismatch — a total,
    // silent outage that no unit test on either parser alone would catch.
    seedRun(db, { runId: 'run-roundtrip' });
    const store = buildRunbookStore(db);
    const reg = (await store.registerDraft(1, gitRepo, 'web')) as { hash: string; version: number };
    expect(store.markProven(1, 'web', reg.hash, reg.version, '{}')).toEqual({ ok: true });
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-roundtrip',
      task: guessedTask,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    const row = readPersisted(result.outcome === 'enqueued' ? result.requestId : '');

    const reparsed = parseVerificationTaskV1(JSON.parse(row.task_json as string));
    expect(reparsed.ok).toBe(true);
    const record = store.getByHash(1, 'web', row.runbook_hash as string);
    expect(record).not.toBeNull();
    expect(
      checkRunbookPin(record, 'web', reparsed.ok ? reparsed.task : guessedTask, row.runbook_hash as string),
    ).toEqual({ ok: true });
  });

  it('an UNPROVEN draft injects nothing and stamps no pin (the degrade gate speaks downstream)', async () => {
    seedRun(db, { runId: 'run-draft' });
    const store = buildRunbookStore(db);
    await store.registerDraft(1, gitRepo, 'web'); // registered, never proven
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-draft',
      task: guessedTask,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('enqueued');
    const row = readPersisted(result.outcome === 'enqueued' ? result.requestId : '');
    expect(JSON.parse(row.task_json as string).build).toEqual(['pnpm run build']);
    expect(row.runbook_hash).toBeNull();
    expect(row.runbook_local_version).toBeNull();
  });

  it('NO store wired at all → unpinned, byte-identical to the pre-phase-2 enqueue', async () => {
    seedRun(db, { runId: 'run-nostore' });
    initScheduler(db);
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-nostore',
      task: guessedTask,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    const row = readPersisted(result.outcome === 'enqueued' ? result.requestId : '');
    expect(JSON.parse(row.task_json as string).serve.cmd).toBe('pnpm dev --port ${PORT}');
    expect(row.runbook_hash).toBeNull();
  });

  it('a SETUP-PROOF request pins its OWN draft verbatim, without needing a proven record', async () => {
    seedRun(db, { runId: 'run-proof-pin' });
    const store = buildRunbookStore(db);
    const registered = (await store.registerDraft(1, gitRepo, 'web')) as { hash: string; version: number };
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-proof-pin',
      // The setup flow composed this task FROM the draft, so no merge should happen.
      task: {
        ...task,
        build: ['pnpm run build:web'],
        serve: { cmd: 'pnpm run preview -- --port ${PORT}' },
      },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
      setupProof: true,
      runbookHash: registered.hash,
      runbookLocalVersion: registered.version,
    });

    expect(result.outcome).toBe('enqueued');
    const id = result.outcome === 'enqueued' ? result.requestId : '';
    const row = readPersisted(id);
    expect(row.runbook_hash).toBe(registered.hash);
    expect(row.runbook_local_version).toBe(registered.version);
    // Verbatim: the caller's pin is authoritative, and the draft it pins is by
    // definition not proven yet (requiring 'proven' here would deadlock setup).
    const flags = db
      .prepare('SELECT setup_proof FROM verification_requests WHERE id = ?')
      .get(id) as { setup_proof: number };
    expect(flags.setup_proof).toBe(1);
  });

  it('the §7.2 guard still fires on a setup-proof request (a pin is not an exemption)', async () => {
    seedRun(db, { runId: 'run-proof-guard' });
    initScheduler(db, buildRunbookStore(db));
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-proof-guard',
      task: { ...task, build: ['pnpm install'] },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
      setupProof: true,
      runbookHash: 'deadbeef',
      runbookLocalVersion: 1,
    });
    expect(result.outcome).toBe('skipped');
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  it('a runbook that smuggles an install through the MERGE is rejected too (§7.2 covers both sources)', async () => {
    seedRun(db, { runId: 'run-bad-runbook' });
    const badRunbook: VerifyRunbookV1 = {
      version: 1,
      modalities: {
        web: {
          build: ['pnpm install --frozen-lockfile', 'pnpm run build'],
          attestation: { kind: 'http-endpoint', urlPath: '/__cyboflow_verify__' },
        },
      },
    };
    const store = new VerifyRunbookStore(dbAdapter(db), {
      readPortableFile: async () => JSON.stringify(badRunbook),
      computeInputHash: async () => 'input-hash-1',
      hostFingerprint: async () => 'host-fingerprint-1',
    });
    const reg = (await store.registerDraft(1, gitRepo, 'web')) as { hash: string; version: number };
    expect(store.markProven(1, 'web', reg.hash, reg.version, '{}')).toEqual({ ok: true });
    initScheduler(db, store);

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-bad-runbook',
      // The COMPOSED task is clean — only the runbook is not.
      task: { ...task, build: ['pnpm run build'], serve: { cmd: 'pnpm dev --port ${PORT}' } },
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('skipped');
    const reason = result.outcome === 'skipped' ? result.reason : '';
    expect(reason).toContain(FORBIDDEN_DEP_COMMAND_ERROR);
    expect(reason).toContain("committed verification runbook");
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 0 });
  });

  // ---------------------------------------------------------------------------
  // Migration 107 — the LANE-DRIVEN bootstrap proof
  // (docs/proposals/lane-runbook-bootstrap.md §5 + §9)
  // ---------------------------------------------------------------------------

  it('gives a bootstrap proof its own enqueue generation, so a prior SKIPPED row cannot dedup it', async () => {
    // THE DEFECT THIS PINS. `findLiveRequestByEnqueueKey` counts ANY non-canceled
    // row — terminals included, and 'skipped' explicitly — as a live dedup hit.
    // A lane that was just skipped for want of a runbook therefore already owns
    // `${runId}:${ref}:${attempt}`. Firing the proof under that same key would
    // hand back the SKIPPED row's id and deploy nothing at all, while every
    // caller read it as an enqueued request: a silent, total no-op.
    seedRun(db, { runId: 'run_bs' });
    initScheduler(db);

    const ordinary = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(ordinary.outcome).toBe('enqueued');
    const skippedId = ordinary.outcome === 'enqueued' ? ordinary.requestId : '';
    // Terminalize it exactly as the §3.2 degrade gate does.
    db.prepare("UPDATE verification_requests SET status = 'skipped', error_message = ? WHERE id = ?").run(
      'no proven verification runbook for this project (run verification setup)',
      skippedId,
    );

    const proof = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs',
      task,
      laneTaskRef: 'TASK-001',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
    });

    expect(proof.outcome).toBe('enqueued');
    const proofId = proof.outcome === 'enqueued' ? proof.requestId : '';
    expect(proofId).not.toBe(skippedId);

    const row = db
      .prepare('SELECT enqueue_key AS key, bootstrap_proof AS flag FROM verification_requests WHERE id = ?')
      .get(proofId) as { key: string; flag: number };
    expect(row.key).toBe('run_bs:TASK-001:1:bootstrap:1');
    expect(row.flag).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 2 });
  });

  it('still dedups a re-fired bootstrap round, so crash recovery re-runs nothing', async () => {
    // The generation must be UNIQUE PER ROUND, not per call: "resume at the first
    // incomplete step" after a restart depends on re-firing round N returning the
    // same request rather than a duplicate deployment.
    seedRun(db, { runId: 'run_bs2' });
    initScheduler(db);

    const first = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs2',
      task,
      laneTaskRef: 'TASK-002',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
    });
    const again = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs2',
      task,
      laneTaskRef: 'TASK-002',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
    });
    expect(first.outcome).toBe('enqueued');
    expect(again).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 1 });

    // …but a SECOND draft round is a genuinely different proof and must deploy.
    const round2 = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs2',
      task,
      laneTaskRef: 'TASK-002',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 2,
    });
    expect(round2.outcome).toBe('enqueued');
    expect(db.prepare('SELECT COUNT(*) AS n FROM verification_requests').get()).toEqual({ n: 2 });
  });

  it('leaves an ordinary request unflagged and on the plain key', async () => {
    seedRun(db, { runId: 'run_bs3' });
    initScheduler(db);

    const res = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run_bs3',
      task,
      laneTaskRef: 'TASK-003',
      attempt: 2,
      worktreePath: gitRepo,
    });
    const id = res.outcome === 'enqueued' ? res.requestId : '';
    const row = db
      .prepare('SELECT enqueue_key AS key, bootstrap_proof AS flag FROM verification_requests WHERE id = ?')
      .get(id) as { key: string; flag: number };
    expect(row.key).toBe('run_bs3:TASK-003:2');
    expect(row.flag).toBe(0);
  });
});

/**
 * The runbook BOOTSTRAP at the enqueue seam (lane-runbook-bootstrap.md §12).
 *
 * Two contracts, and the second is the one that could break something silently:
 *
 *  1. WITH NO RUNNER WIRED — every unit test, and any deployment where the
 *     toggle can never be on — the enqueue is byte-for-byte what it always was.
 *     A feature that quietly altered the enqueue on projects that never opted
 *     into it would be the worst possible outcome, because nobody would be
 *     looking for it.
 *  2. THE PROOF MUST NOT RE-ENTER. The bootstrap fires its own attestation-only
 *     request through THIS SAME function; consulting the bootstrap for that
 *     request would start a second one while the first is mid-flight, and the
 *     run-scoped stamp would read the recursion as its own owner re-entering —
 *     the one shape the single-flight cannot distinguish from a restart.
 */
describe('enqueueTaskVerification — the runbook bootstrap', () => {
  const serveTask: VerificationTaskV1 = {
    ...task,
    serve: { cmd: 'pnpm dev --port ${PORT}' },
  };

  it('enqueues exactly as before when the toggle is ON but no runner is wired', async () => {
    // The bootstrap-eligible case with the acting half absent. Indistinguishable
    // from the toggle being off, which is what makes every other test in this
    // file — and every deployment that never opts in — unaffected.
    seedRun(db, { runId: 'run-pf1' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
    });
    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf1',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    // Unchanged key: no `:bootstrap:` generation, because no bootstrap ran.
    expect(readRow(result.requestId).enqueue_key).toBe('run-pf1:TASK-1:1');
  });

  it('the scheduler reports the decision it would act on', async () => {
    seedRun(db, { runId: 'run-pf2' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
    });
    await expect(
      VerificationScheduler.getInstance().evaluateRunbookBootstrap({
        projectId: 1,
        runId: 'run-pf2',
        laneTaskRef: 'TASK-1',
        modality: 'web',
        task: serveTask,
        probePath: gitRepo,
      }),
    ).resolves.toEqual({ proceed: true, adopt: false });
  });

  it('declines with the toggle OFF, which is the shipped default', async () => {
    seedRun(db, { runId: 'run-pf3' });
    initScheduler(db);
    await expect(
      VerificationScheduler.getInstance().evaluateRunbookBootstrap({
        projectId: 1,
        runId: 'run-pf3',
        laneTaskRef: 'TASK-1',
        modality: 'web',
        task: serveTask,
        probePath: gitRepo,
      }),
    ).resolves.toEqual({ proceed: false, reason: 'disabled' });
  });

  it('runs the bootstrap when a runner IS wired, and enqueues afterwards either way', async () => {
    // The acting path. The lane's own request is still enqueued — the bootstrap
    // has no channel to fail a lane and must not grow one — and on a decline the
    // §3.2 gate is what speaks, exactly as it did before this feature existed.
    const calls: Array<{ runId: string; laneTaskRef: string }> = [];
    seedRun(db, { runId: 'run-pf5' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
      runbookBootstrap: async ({ runId, laneTaskRef }) => {
        calls.push({ runId, laneTaskRef });
        return { kind: 'declined', reason: 'not-possible', detail: 'no dev server' };
      },
    });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf5',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
    });

    expect(calls).toEqual([{ runId: 'run-pf5', laneTaskRef: 'TASK-1' }]);
    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    // Still the lane's ORDINARY key — the bootstrap generation belongs to the
    // proof, never to the lane request that triggered it.
    expect(readRow(result.requestId).enqueue_key).toBe('run-pf5:TASK-1:1');
  });

  it('does NOT consult the bootstrap for the bootstrap PROOF itself', async () => {
    // The recursion guard. Without it, the proof's own enqueue would start a
    // second bootstrap while the first is mid-flight — and because the stamp is
    // keyed on (run, project, modality) with the SAME owner ref, that second
    // claim reads as the owner resuming rather than as a collision.
    const calls: string[] = [];
    seedRun(db, { runId: 'run-pf6' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
      runbookBootstrap: async ({ laneTaskRef }) => {
        calls.push(laneTaskRef);
        return { kind: 'declined', reason: 'not-possible', detail: 'x' };
      },
    });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf6',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
      bootstrapProof: true,
      bootstrapRound: 1,
    });

    expect(calls).toEqual([]);
    expect(result.outcome).toBe('enqueued');
    if (result.outcome !== 'enqueued') return;
    expect(readRow(result.requestId).enqueue_key).toBe('run-pf6:TASK-1:1:bootstrap:1');
  });

  it('does NOT consult it for a SETUP proof either', async () => {
    // The verify-setup flow is proving a draft a human already reviewed; a
    // bootstrap there would derive a rival over the very record being proven.
    const calls: string[] = [];
    seedRun(db, { runId: 'run-pf7' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
      runbookBootstrap: async ({ laneTaskRef }) => {
        calls.push(laneTaskRef);
        return { kind: 'declined', reason: 'not-possible', detail: 'x' };
      },
    });

    await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf7',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
      setupProof: true,
    });

    expect(calls).toEqual([]);
  });

  it('a THROWING bootstrap runner still enqueues — the seam never crashes a lane', async () => {
    seedRun(db, { runId: 'run-pf8' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
      runbookBootstrap: async () => {
        throw new Error('the bootstrap exploded');
      },
    });

    const result = await enqueueTaskVerification({
      db: dbAdapter(db),
      runId: 'run-pf8',
      task: serveTask,
      laneTaskRef: 'TASK-1',
      attempt: 1,
      worktreePath: gitRepo,
    });
    expect(result.outcome).toBe('enqueued');
  });

  it('the kill switch overrides the toggle', async () => {
    // The lever for "this is misbehaving on THIS host, stop now" — it must beat
    // a persisted preference that may have been set on another machine.
    const prior = process.env.CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP;
    process.env.CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP = '1';
    try {
      seedRun(db, { runId: 'run-pf4' });
      initScheduler(db, undefined, {
        config: { ...baseConfig, autoBootstrapRunbook: true },
      });
      await expect(
        VerificationScheduler.getInstance().evaluateRunbookBootstrap({
          projectId: 1,
          runId: 'run-pf4',
          laneTaskRef: 'TASK-1',
          modality: 'web',
          task: serveTask,
          probePath: gitRepo,
        }),
      ).resolves.toEqual({ proceed: false, reason: 'disabled' });
    } finally {
      if (prior === undefined) delete process.env.CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP;
      else process.env.CYBOFLOW_DISABLE_RUNBOOK_BOOTSTRAP = prior;
    }
  });

  it('a task that derives no environment is never a bootstrap candidate', async () => {
    seedRun(db, { runId: 'run-pf5' });
    initScheduler(db, undefined, {
      config: { ...baseConfig, autoBootstrapRunbook: true },
    });
    await expect(
      VerificationScheduler.getInstance().evaluateRunbookBootstrap({
        projectId: 1,
        runId: 'run-pf5',
        laneTaskRef: 'TASK-1',
        modality: 'web',
        task,
        probePath: gitRepo,
      }),
    ).resolves.toEqual({ proceed: false, reason: 'no-environment' });
  });
});
