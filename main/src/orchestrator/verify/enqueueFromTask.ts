/**
 * enqueueTaskVerification — the main-process seam that turns a task-verify-composed
 * `VerificationTaskV1` into a queued verification request for ONE sprint lane,
 * WITHOUT the MCP hop (verification-agent redesign §5.3/§5.4). The programmatic
 * `WorkflowController` calls this (via an injected `ControllerHost` capability) from
 * the agentless visual-verify inner step; orchestrated mode keeps using the MCP
 * `cyboflow_request_verification` handler instead.
 *
 * This mirrors `mcpQueryHandler.handleRequestVerification` (the dual-format enqueue)
 * for a request that ALWAYS carries a task, minus the socket plumbing:
 *   - read the run's IMMUTABLE verify stamps (verify_enabled / verify_type /
 *     verify_chain) + project id defensively; disabled/missing ⇒ a fail-open SKIP;
 *   - resolve the chain = FALLBACK_CHAINS[type] ∩ the stamped chain (an empty
 *     intersection still enqueues — the scheduler treats an empty chain as a SKIP,
 *     never a fabricated fail — exactly like the MCP handler);
 *   - capture the snapshot sha at enqueue time (§5.5); a capture failure falls back
 *     to a null sha and STILL enqueues (the provisioner's dirty-worktree bucket);
 *   - FORCE the lane identity: the controller's `laneTaskRef` is authoritative for
 *     gate attribution, so it overrides `task.taskRef` AND drives the derived legacy
 *     input, so `task_json` and `deliverable_json` carry the SAME ref regardless of
 *     what the composing agent wrote;
 *   - dedupe on `${runId}:${laneTaskRef}:${attempt}` so a crash re-walk never
 *     double-enqueues while a genuinely fresh attempt (bumped by the merge-gate
 *     loopback) re-fires (§5.3).
 *
 * Electron-free: it takes a narrow `DatabaseLike` + reads the VerificationScheduler
 * singleton (initialized in main/src/index.ts). It is injected into the controller
 * host so the controller itself stays DB/electron-free and unit-testable with a fake.
 */
import { VerificationScheduler } from './verificationScheduler';
import { captureSnapshotSha } from './snapshotProvisioner';
import { findForbiddenTaskCommands } from './dependencyCommandGuard';
import {
  deriveLegacyInputFromTask,
  FALLBACK_CHAINS,
  isVerificationType,
  resolveTaskModality,
} from '../../../../shared/types/visualVerification';
import type {
  VerificationTaskV1,
  VerificationType,
  VisualBackendId,
} from '../../../../shared/types/visualVerification';
import type { VerifyRunbookModalityEntry } from '../../../../shared/types/verifyRunbook';
import type { DatabaseLike, LoggerLike } from '../types';
import type { TaskEnqueueResult } from '../programmatic/types';

export type { TaskEnqueueResult };

// ---------------------------------------------------------------------------
// The SHARED enqueue-time preparation (§5.2 seams 1+3, §5.3, §7.2 ENQUEUE half)
//
// There are exactly TWO ways a verification request is born — the MCP handler
// (`cyboflow_request_verification`, orchestrated mode) and this module's
// `enqueueTaskVerification` (the programmatic controller's agentless
// visual-verify step) — and both must apply the identical rules to the composed
// task before a row exists:
//
//   1. REJECT a task whose build/serve mutates dependencies (§7.2);
//   2. INJECT the project's PROVEN runbook revision, replacing the composed
//      build/serve/attestation and stamping the content-addressed PIN (§5.2
//      seam 3).
//
// Duplicating that across the two entry points is how the two paths quietly
// diverge — one gets a guard widened, the other does not — so it lives here,
// once, and both call {@link prepareVerificationEnqueue}.
// ---------------------------------------------------------------------------

/**
 * The migration-096 request-row pin: the portable half's content hash plus the
 * machine-local record's CAS version, both stamped at enqueue so the runner can
 * execute exactly that revision or reject (§5.2 seam 3).
 */
export interface RunbookPin {
  hash: string;
  localVersion: number;
}

/** The structured error code an enqueue rejection carries when §7.2's guard fires. */
export const FORBIDDEN_DEP_COMMAND_ERROR = 'forbidden_dependency_command';

/**
 * Outcome of {@link prepareVerificationEnqueue}. `ok:false` means NOTHING is
 * enqueued and the caller surfaces `error` to the composer verbatim; `ok:true`
 * carries the task to persist (possibly runbook-merged) and the pin to stamp.
 */
export type PreparedVerificationEnqueue =
  | { ok: true; task?: VerificationTaskV1; pin?: RunbookPin }
  | { ok: false; error: string };

/**
 * Build the §7.2 rejection message. Names EVERY offending command verbatim plus
 * the rule and its reason — a composer that gets back "invalid task" cannot fix
 * it; one that gets back "you wrote `pnpm install`, here is why that is not
 * allowed here, dependencies are prepared for you" recomposes correctly on the
 * first retry.
 */
function forbiddenCommandError(offenders: string[], source: 'task' | 'runbook'): string {
  const list = offenders.map((cmd) => `  - ${cmd}`).join('\n');
  const origin =
    source === 'runbook'
      ? "this project's committed verification runbook"
      : 'the composed verification task';
  return (
    `${FORBIDDEN_DEP_COMMAND_ERROR}: ${origin} contains dependency-mutating command(s):\n${list}\n` +
    'A verification snapshot SHARES its node_modules with the live worktree (symlinked), so an ' +
    'install/rebuild/browser-install inside it writes THROUGH into the tree every sibling lane is ' +
    'building against — flipping native-module ABIs under them, invisibly to the mutation check. ' +
    'Dependencies are prepared for you before the task runs: compose build/serve steps that only ' +
    "build and serve (e.g. `pnpm run build`, `pnpm dev --port \\${PORT}`), never ones that install."
  );
}

/**
 * MERGE a proven runbook's modality entry into a composed task (§5.2 seam 3).
 *
 * THE SPLIT OF AUTHORITY. The runbook owns HOW THIS PROJECT IS STOOD UP —
 * `build`, `serve`, and the `attestation` channel that proves the surface is
 * really this deliverable. The composed task owns WHAT IS BEING CHECKED THIS
 * TIME — `summary`, `behaviors`, `viewports`, and the lane `taskRef`. Merging
 * along exactly that seam is the point of the whole phase: §1's diagnosis is
 * that the agent engine "guesses per-run with no memory and guesses wrong every
 * time" (0-for-5 in production — wrong serve form, colliding singletons, wrong
 * ABI), and the composer's guess at build/serve is precisely the part that has
 * never once been right. Its judgment about which behaviors to check is the part
 * it is actually good at, and that survives untouched.
 *
 * REPLACE, NOT MERGE-FIELDS. An absent `build` in the runbook entry REMOVES the
 * task's own build steps rather than leaving them: "this project needs no build
 * step" is a positive statement the proof validated, and keeping a guessed one
 * alongside it would re-introduce exactly the guess that was proven wrong.
 *
 * `target` is preserved: it is the composer's pre-live pointer and is orthogonal
 * to standing the project up. The entry's `viewports`/`notes` are NOT merged —
 * capture framing belongs to the request, and the notes are for humans reading
 * the committed file.
 */
export function mergeRunbookIntoTask(
  task: VerificationTaskV1,
  entry: VerifyRunbookModalityEntry,
): VerificationTaskV1 {
  return {
    version: 1,
    summary: task.summary,
    behaviors: task.behaviors,
    attestation: entry.attestation,
    ...(task.taskRef !== undefined ? { taskRef: task.taskRef } : {}),
    ...(task.target !== undefined ? { target: task.target } : {}),
    ...(task.modality !== undefined ? { modality: task.modality } : {}),
    ...(task.viewports !== undefined ? { viewports: task.viewports } : {}),
    ...(task.timeoutMs !== undefined ? { timeoutMs: task.timeoutMs } : {}),
    ...(entry.build !== undefined ? { build: entry.build } : {}),
    ...(entry.serve !== undefined ? { serve: entry.serve } : {}),
  };
}

/**
 * Apply the two enqueue-time rules to a composed task, in order. Called by BOTH
 * enqueue entry points; see this section's header for why it is shared.
 *
 * ORDER MATTERS. The §7.2 guard runs FIRST, on what the composer actually wrote:
 * a task carrying `pnpm install` is rejected with that command named, before any
 * runbook merge could quietly replace it and hide the composer's mistake (the
 * composer would keep making it). It then runs AGAIN on the merged result,
 * because §7.2's rule is explicitly "every composed task's build/serve steps —
 * runbook-sourced and agent-composed alike": a runbook that smuggles an install
 * through the merge is exactly as dangerous, and is arguably worse because it is
 * PROVEN and would repeat on every request.
 *
 * A SETUP-PROOF REQUEST PINS ITS OWN DRAFT. `pin` supplied by the caller is
 * stamped verbatim and no lookup happens: the phase-2 setup flow is trying to
 * PROVE a revision, which by definition is not proven yet, so requiring a proven
 * record here would be a bootstrap deadlock (the same reason §3.6 exempts it
 * from the degrade gate). Its task was composed from that draft, so re-merging
 * would be a no-op at best.
 *
 * EVERY UNHAPPY PATH IS "UNPINNED", NOT "FAILED". No store wired, no proven
 * record, a record that declares no entry for this modality, a resolution error
 * — all resolve to `{ ok: true, task }` with no pin. The §3.2 degrade gate then
 * gives the honest answer downstream (skip + a setup CTA for a build/serve task;
 * nothing at all for a degenerate pre-live one). The ONLY hard rejection here is
 * the dependency guard, because that one is a hazard rather than a gap.
 */
export async function prepareVerificationEnqueue(args: {
  projectId: number;
  runId: string;
  type: VerificationType;
  /** The composed task, when the request carries one (the legacy intent-only path passes undefined). */
  task?: VerificationTaskV1;
  /** A caller-supplied pin — a setup-proof request pinning the draft it is proving. */
  pin?: RunbookPin;
  /** The tree whose portable runbook half is probed; absent ⇒ the scheduler resolves it from the run/project. */
  probePath?: string;
  logger?: LoggerLike;
}): Promise<PreparedVerificationEnqueue> {
  const { task, logger } = args;
  if (task === undefined) return { ok: true };

  // (1) §7.2 — the composer's own commands.
  const composed = findForbiddenTaskCommands(task);
  if (composed.length > 0) {
    return { ok: false, error: forbiddenCommandError(composed, 'task') };
  }

  // (2) A caller-supplied pin is authoritative (setup proof) — stamp it verbatim.
  if (args.pin !== undefined) {
    return { ok: true, task, pin: args.pin };
  }

  // (3) §5.2 seam 3 — the proven-runbook injection.
  const scheduler = VerificationScheduler.tryGetInstance();
  if (scheduler === null) return { ok: true, task };
  const modality = resolveTaskModality(args.type, task);
  const revision = await scheduler.resolveProvenRunbook({
    projectId: args.projectId,
    runId: args.runId,
    modality,
    ...(args.probePath !== undefined ? { probePath: args.probePath } : {}),
  });
  if (revision === null) return { ok: true, task };

  const merged = mergeRunbookIntoTask(task, revision.entry);

  // The stamped modality is re-derived from the PERSISTED task
  // (`scheduler.enqueue` → `resolveTaskModality`), so a merge that changes the
  // `serve.attach` discriminant would stamp a modality DIFFERENT from the one
  // this runbook was resolved for — the capability ledger, the screen lease and
  // the runner's preflight would then all key on a modality nothing was proven
  // against. That can only happen if a record filed under modality M declares an
  // entry inconsistent with M (a malformed runbook), so the response is to drop
  // the injection and let the degrade gate speak, never to silently execute the
  // inconsistency.
  if (resolveTaskModality(args.type, merged) !== modality) {
    logger?.warn('[prepareVerificationEnqueue] runbook entry contradicts its own modality; skipping injection', {
      projectId: args.projectId,
      runId: args.runId,
      modality,
      merged: resolveTaskModality(args.type, merged),
      runbookHash: revision.hash,
    });
    return { ok: true, task };
  }

  // (4) §7.2 again, now over the runbook-sourced commands.
  const fromRunbook = findForbiddenTaskCommands(merged);
  if (fromRunbook.length > 0) {
    return { ok: false, error: forbiddenCommandError(fromRunbook, 'runbook') };
  }

  logger?.debug('[prepareVerificationEnqueue] injected a proven runbook revision', {
    projectId: args.projectId,
    runId: args.runId,
    modality,
    runbookHash: revision.hash,
    runbookLocalVersion: revision.version,
  });
  return { ok: true, task: merged, pin: { hash: revision.hash, localVersion: revision.version } };
}

/** Parse the stamped `verify_chain` JSON into a `VisualBackendId[]` (mirrors mcpQueryHandler). Fail-soft → []. */
function parseStampedChain(v: unknown): VisualBackendId[] {
  if (typeof v !== 'string' || v.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(v);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is VisualBackendId => typeof x === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

export interface EnqueueTaskVerificationOptions {
  db: DatabaseLike;
  runId: string;
  task: VerificationTaskV1;
  /** The lane's authoritative ref/id — overrides `task.taskRef` for gate attribution. */
  laneTaskRef: string;
  /** 1-based lane attempt; part of the idempotency key so a fresh attempt re-fires. */
  attempt: number;
  /** The run worktree the snapshot sha is captured from (§5.5). */
  worktreePath: string;
  /**
   * §3.6 (docs/proposals/verification-setup-flow.md) — mark this as a phase-2
   * SETUP/PROOF request rather than ordinary lane traffic: exempt from the
   * project's lifetime verification budget, never counted against it, and exempt
   * from the §3.2 "no proven runbook" degrade gate (proving the runbook is how a
   * project stops being unproven). Defaults to false; no caller in phase 0 sets
   * it — the channel exists so the phase-2 setup flow can enqueue its proof run
   * through this SAME seam instead of a parallel one.
   */
  setupProof?: boolean;
  /**
   * Migration 107 — mark this as the LANE-DRIVEN bootstrap proof
   * (docs/proposals/lane-runbook-bootstrap.md §5): exempt from the §3.2 degrade
   * gate (it exists to prove the runbook whose absence the gate is complaining
   * about) but COUNTED against the project budget and drained at ordinary
   * priority, unlike `setupProof`. Never settable over the MCP wire — this
   * in-process option is its only writer.
   *
   * Must be paired with {@link bootstrapRound}, which makes the enqueue key
   * unique; see the key derivation below for why that is load-bearing rather
   * than cosmetic.
   */
  bootstrapProof?: boolean;
  /**
   * 1-based bootstrap draft round, part of the enqueue key. Ignored unless
   * {@link bootstrapProof} is set.
   */
  bootstrapRound?: number;
  /**
   * §5.2 seam 3 — a caller-supplied PIN, stamped verbatim onto the request row.
   * The phase-2 setup flow's proof run is the caller: it is trying to PROVE a
   * specific derived revision, so it pins that revision's own hash + CAS version
   * rather than waiting for a proven record that by definition does not exist
   * yet (the same bootstrap reasoning that exempts a `setupProof` request from
   * the §3.2 degrade gate). Absent ⇒ the pin, if any, is resolved from the
   * project's PROVEN runbook by {@link prepareVerificationEnqueue}.
   *
   * Both must be supplied together to have an effect — half a pin is not a pin,
   * and the runner's validation would have nothing to CAS against.
   */
  runbookHash?: string;
  runbookLocalVersion?: number;
  logger?: LoggerLike;
}

/**
 * Enqueue a composed visual-verification task for one lane. Returns
 * `{ outcome: 'enqueued', requestId }` on success, or `{ outcome: 'skipped', reason }`
 * when verification is disabled/missing for the run or the scheduler is unavailable
 * (both fail-open — the caller advances the lane without parking). NEVER throws.
 *
 * ONE outcome is deliberately NOT fail-open: a task whose build/serve mutates
 * dependencies (§7.2) resolves `{ outcome: 'skipped', reason: <the structured
 * guard message> }`. Skipping is still lane-advancing (this seam has no channel
 * to fail a lane and must not grow one), but the reason names the offending
 * command so the loopback that follows recomposes correctly instead of the
 * enqueue quietly writing a row that would poison every sibling lane's
 * node_modules.
 */
export async function enqueueTaskVerification(
  opts: EnqueueTaskVerificationOptions,
): Promise<TaskEnqueueResult> {
  const { db, runId, laneTaskRef, attempt, worktreePath, logger } = opts;

  // (1) Immutable verify stamps + project id (resolveReviewItemRunContext's minimal
  // query, reduced to the columns this seam needs). Read defensively — a pre-078 /
  // pre-055 DB lacking the columns degrades to a disabled posture (skipped).
  let enabled = false;
  let stampedType: VerificationType | null = null;
  let stampedChain: VisualBackendId[] = [];
  let projectId = Number.NaN;
  try {
    const row = db
      .prepare(
        `SELECT project_id AS projectId, verify_enabled AS verifyEnabled,
                verify_type AS verifyType, verify_chain AS verifyChain
           FROM workflow_runs WHERE id = ?`,
      )
      .get(runId) as
      | { projectId?: unknown; verifyEnabled?: unknown; verifyType?: unknown; verifyChain?: unknown }
      | undefined;
    if (!row) return { outcome: 'skipped', reason: 'verification-disabled' };
    enabled = row.verifyEnabled === 1 || row.verifyEnabled === true;
    stampedType = isVerificationType(row.verifyType) ? row.verifyType : null;
    stampedChain = parseStampedChain(row.verifyChain);
    projectId = typeof row.projectId === 'number' ? row.projectId : Number(row.projectId);
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] verify-stamp read failed (fail-open skip)', {
      runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'skipped', reason: 'verification-disabled' };
  }

  if (!enabled || stampedType === null || !Number.isFinite(projectId)) {
    return { outcome: 'skipped', reason: 'verification-disabled' };
  }

  const type: VerificationType = stampedType;
  // Effective chain = FALLBACK_CHAINS[type] ∩ the stamped (host-available) chain,
  // in FALLBACK_CHAINS order. An empty intersection still enqueues (scheduler SKIP).
  const chain = FALLBACK_CHAINS[type].filter((backend) => stampedChain.includes(backend));

  // (3) FORCE lane identity: laneTaskRef is authoritative for gate attribution, so
  // it overrides task.taskRef AND drives the derived legacy input — both persisted
  // columns then carry the SAME ref regardless of what the composing agent wrote.
  const composedTask: VerificationTaskV1 = { ...opts.task, taskRef: laneTaskRef };

  // (3a) The RUNBOOK BOOTSTRAP (lane-runbook-bootstrap.md §12 steps 1–8).
  //
  // Runs HERE — before the shared preparation, before any row — because that is
  // the last moment a decision still exists. Once the request is written and the
  // §3.2 gate skips it, the only thing left to write is a `skipped` terminal, and
  // that terminal BURNS the enqueue key: findLiveRequestByEnqueueKey counts it as
  // a live dedup hit, so a bootstrap running afterwards could not re-fire this
  // lane's own request at all.
  //
  // The bootstrap either PROVES a runbook (after which the shared preparation
  // below resolves it, merges it, and pins it — so the lane verifies exactly as
  // it would on a project a human had configured) or it does not, in which case
  // this function carries on unchanged and the gate skips the request with a
  // reason naming the situation. It has no channel to fail a lane, by design.
  //
  // THE PROOF ITSELF MUST NOT RE-ENTER HERE. The bootstrap fires its own
  // attestation-only request through this same seam with `bootstrapProof: true`;
  // consulting the bootstrap for that request would recurse into a second
  // bootstrap while the first is mid-flight, and the stamp would report the
  // recursion as its own owner re-entering. A proof request is by definition the
  // thing a bootstrap already decided to do.
  //
  // Wrapped like every other collaborator call in this function: the seam's
  // contract is NEVER THROWS, and an unavailable scheduler here must degrade to
  // today's enqueue rather than crash a lane.
  if (opts.bootstrapProof !== true && opts.setupProof !== true) {
    try {
      const outcome = await VerificationScheduler.getInstance().maybeBootstrapRunbook({
        projectId,
        runId,
        laneTaskRef,
        modality: resolveTaskModality(type, composedTask),
        task: composedTask,
        probePath: worktreePath,
      });
      if (outcome.kind !== 'not-attempted') {
        logger?.info('[enqueueTaskVerification] runbook bootstrap finished', {
          runId,
          laneTaskRef,
          outcome: outcome.kind,
          ...(outcome.kind === 'proven'
            ? { runbookHash: outcome.runbookHash, runbookLocalVersion: outcome.runbookVersion }
            : { detail: outcome.kind === 'declined' ? outcome.detail : outcome.detail }),
        });
      }
    } catch (err) {
      logger?.debug('[enqueueTaskVerification] runbook bootstrap unavailable', {
        runId,
        laneTaskRef,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // (3a1) Snapshot sha (§5.5) — captured AFTER the bootstrap, deliberately.
  //
  // The bootstrap writes up to TWO commits onto this branch: the rung-1 config
  // edit (§8.1 gives it its own commit) and the runbook itself. Capturing the
  // sha before them pinned the verification to a tree in which the runbook's own
  // ENABLING EDIT does not exist — so the request would execute a runbook
  // describing a project that only starts at the commit after the snapshot.
  //
  // Live-observed 2026-08-20: a lane whose bootstrap derived `port-from-env` on
  // `app.config.mjs` then verified against the pre-edit sha, where the port was
  // still a literal. The harness exported the declared `portEnv`, the config read
  // it nowhere, the server bound its hardcoded default, and the serve-identity
  // probe found no listener on the leased port — a `failed`/`ambiguous` terminal
  // for a deliverable that was fine. Every first lane verification on a project
  // needing a rung-1 edit would have failed this way.
  //
  // Nothing between here and the old position consumed the sha, and the bootstrap
  // does not read it, so this is a pure reordering. A capture failure still falls
  // back to null and STILL enqueues (the provisioner's dirty-worktree bucket).
  let snapshotSha: string | null = null;
  try {
    snapshotSha = await captureSnapshotSha(worktreePath);
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] snapshot sha capture failed; enqueuing without a snapshot', {
      runId,
      worktreePath,
      error: err instanceof Error ? err.message : String(err),
    });
    snapshotSha = null;
  }

  // (3b) The SHARED enqueue-time rules (§7.2 guard + §5.2 seam-3 injection). Runs
  // BEFORE deriving the legacy input so `deliverable_json` is derived from the
  // task that is actually persisted, not from the pre-merge one.
  // Wrapped despite `prepareVerificationEnqueue` being total today: this seam's
  // contract is NEVER THROWS (a throw here crashes a lane), and that must not
  // depend on a collaborator two modules away staying total forever. An
  // unexpected throw degrades to "unpinned, unvalidated" and still enqueues,
  // which is the pre-phase-2 behavior.
  let prepared: PreparedVerificationEnqueue;
  try {
    prepared = await prepareVerificationEnqueue({
      projectId,
      runId,
      type,
      task: composedTask,
      ...(opts.runbookHash !== undefined && opts.runbookLocalVersion !== undefined
        ? { pin: { hash: opts.runbookHash, localVersion: opts.runbookLocalVersion } }
        : {}),
      probePath: worktreePath,
      ...(logger ? { logger } : {}),
    });
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] enqueue preparation threw; enqueuing unpinned', {
      runId,
      laneTaskRef,
      error: err instanceof Error ? err.message : String(err),
    });
    prepared = { ok: true, task: composedTask };
  }
  if (!prepared.ok) {
    logger?.warn('[enqueueTaskVerification] composed task rejected at enqueue; skipping visual verification', {
      runId,
      laneTaskRef,
      error: prepared.error,
    });
    return { outcome: 'skipped', reason: prepared.error };
  }
  const task: VerificationTaskV1 = prepared.task ?? composedTask;
  const input = deriveLegacyInputFromTask(task, laneTaskRef);
  // THE KEY MUST CARRY A GENERATION FOR A BOOTSTRAP PROOF (mig 105).
  //
  // `findLiveRequestByEnqueueKey` treats ANY non-canceled row sharing the key as
  // a live dedup hit — terminals included, and explicitly including 'skipped'.
  // A lane that just got skipped for want of a runbook therefore already OWNS
  // `${runId}:${laneTaskRef}:${attempt}`, so firing the proof under that same key
  // would hand back the skipped row's id and deploy NOTHING, while every caller
  // read it as an enqueued request. Silent, total, and indistinguishable from
  // success from the outside.
  //
  // The `:bootstrap:<round>` segment is what makes each proof its own request,
  // and re-firing round N after a crash still dedups correctly — which is the
  // property that lets the bootstrap's recovery be "resume at the first
  // incomplete step" rather than a bespoke state machine.
  const enqueueKey =
    opts.bootstrapProof === true
      ? `${runId}:${laneTaskRef}:${attempt}:bootstrap:${opts.bootstrapRound ?? 1}`
      : `${runId}:${laneTaskRef}:${attempt}`;

  // (4) Enqueue on the singleton. Guard getInstance (+ the enqueue itself) so an
  // uninitialized scheduler or a transient enqueue error is a fail-open SKIP, never
  // a thrown lane crash.
  try {
    // The modality stamp is NOT set here: this seam delegates to
    // scheduler.enqueue, which resolves + stamps it from (type, task) at the
    // single INSERT — one derivation site, so a lane enqueue and an MCP enqueue
    // can never disagree about a request's modality.
    const requestId = VerificationScheduler.getInstance().enqueue({
      runId,
      projectId,
      type,
      input,
      chain,
      task,
      snapshotSha,
      enqueueKey,
      ...(opts.setupProof === true ? { setupProof: true } : {}),
      ...(opts.bootstrapProof === true ? { bootstrapProof: true } : {}),
      ...(prepared.pin
        ? { runbookHash: prepared.pin.hash, runbookLocalVersion: prepared.pin.localVersion }
        : {}),
    });
    logger?.debug('[enqueueTaskVerification] enqueued lane verification', {
      runId,
      requestId,
      laneTaskRef,
      attempt,
      enqueueKey,
      hasSnapshot: snapshotSha !== null,
      runbookHash: prepared.pin?.hash ?? null,
      bootstrapProof: opts.bootstrapProof === true,
    });
    return { outcome: 'enqueued', requestId };
  } catch (err) {
    logger?.warn('[enqueueTaskVerification] scheduler unavailable; skipping visual verification', {
      runId,
      laneTaskRef,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: 'skipped', reason: 'scheduler-unavailable' };
  }
}
