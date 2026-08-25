/**
 * trackerSync/trackerSyncService — the ASSEMBLY layer for the tracker-sync
 * engine. Design: docs/proposals/tracker-sync-integration.md ("Sync engine" +
 * "Durability & failure semantics").
 *
 * Everything below this file is a pure, independently-testable piece: store.ts
 * owns the SQL, the adapters own the network, writeBack.ts turns entity events
 * into outbox rows, outboxWorker.ts drains them, inboundSync.ts pulls the
 * tracker's changes in. This file is the only thing that knows about TIME,
 * PROCESS LIFETIME and ORDER — it owns the poll loop, boot crash-recovery, the
 * provider-client construction (and therefore secret decryption), and the
 * per-connection sync log the connected view renders.
 *
 * ONE PASS, in this order (the order is load-bearing):
 *   1. processAmbiguous — reconcile writes whose outcome the last app lifetime
 *      never learned. MUST precede the drain: an un-reconciled create would
 *      otherwise be retried and duplicate a sub-issue.
 *   2. drainOutbox      — perform the queued remote writes. MUST precede
 *      inbound: every unresolved outbox row HALTS the inbound batch (echo
 *      suppression), so draining first is what lets the cursor move at all.
 *   3. runInboundSync   — pull remote changes in, GATED on the drain having left
 *      no create whose outcome is still unknown (a provider without idempotent
 *      creates parks those `ambiguous`). See
 *      {@link TrackerSyncService.recoverCreatesBeforeInbound}: importing while
 *      one is open is how a committed-but-lost sub-issue becomes a duplicate
 *      idea. Phases 3+4 stand down for the pass rather than risk it.
 *   4. runDeletionSweep — every SWEEP_EVERY_N_PASSES-th pass, and on every
 *      "Sync now". It costs a full remote id listing, so it is deliberately not
 *      per-pass.
 *
 * CADENCE. A 60s tick selects the connections whose `last_sync_at` is at least
 * SYNC_INTERVAL_MS old (or null). The tick is the cheap clock; the 5-minute
 * cadence is the connection's own state, so it survives a restart and a
 * mid-interval "Sync now" correctly re-bases the next poll. `last_sync_at` is
 * stamped even on a FAILED pass — otherwise a permanently-failing connection
 * would be retried every 60s instead of every 5 minutes.
 *
 * FAILURE POLICY. Nothing here throws out of the loop. A TrackerAuthError (or
 * an unusable stored key) pauses the connection — the key is bad, so retrying
 * on a timer is pure noise until the user re-connects. Everything else is
 * logged into the pass log and left active: the next tick retries, and the
 * outbox's own backoff handles per-write retry.
 *
 * STATUS GUARDS. A pass only ever runs for an ACTIVE connection, and it re-reads
 * that status at every phase boundary — `disconnect` (or a pause) flips the
 * column while the pass is in flight, and from that moment the pass abandons its
 * remaining phases and persists NOTHING. See {@link TrackerSyncService.runPass}.
 *
 * LOCAL REMOVAL. Deleting or archiving a linked entity is the one flow where the
 * user rules on the tracker issue directly ("keep it" / "cancel it"). The dialog
 * only COLLECTS that ruling (stageUnlinkRuling) — it is applied by the entity
 * event the committed delete/archive emits, so a user who backs out of the
 * confirm dialog behind it has changed nothing at all. The same handler is what
 * keeps a cascade honest: a hard delete removes rows from three entity tables
 * and `entity_external_links` has no foreign key into any of them, so every
 * affected link is orphaned here or nowhere.
 *
 * WRITE-BACK LATENCY. The entity-event listener only ENQUEUES; without a nudge
 * the row would sit until the next 5-minute poll, which reads as "cyboflow
 * didn't update my tracker". So an event that leaves a pending row arms a 2s
 * debounced drain for that connection — a burst of stage moves collapses into
 * one drain, and the drain shares the per-connection lock with the full pass.
 *
 * THE UI FACADE. This class also implements {@link TrackerSyncFacade} — the
 * whole Settings > Integrations surface (wizard probes, connect, connected-view
 * reads, settings, disconnect, conflict resolution). It lives here rather than
 * in a second service because every one of those calls needs exactly what this
 * file already owns: the adapter factory (and therefore secret handling), the
 * per-connection pass, and the drain timers. Each mutation broadcasts a
 * {@link TrackerChangedEvent} on `trackerSyncEvents` so the connected view
 * re-reads; the emits are placed HERE, at the service seam, not inside the
 * engine halves — inboundSync/outboxWorker stay pure, per-connection functions
 * with no notion of a subscriber.
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type {
  EntityExternalLinkRow,
  TrackerConflictRow,
  TrackerConnectionRow,
  TrackerOutboxRow,
} from '../../database/models';
import type { BacklogTaskItem, TaskChangedEvent } from '../../../../shared/types/tasks';
import type {
  TrackerConflictChoice,
  TrackerConflictSummary,
  TrackerConnectPayload,
  TrackerConnectionSummary,
  TrackerContentSyncMode,
  TrackerCredentialsInput,
  TrackerDirectionMode,
  TrackerEntityLinkRef,
  TrackerEntityType,
  TrackerFieldOptions,
  TrackerGroupTree,
  TrackerIssue,
  TrackerNarrowKind,
  TrackerProvider,
  TrackerReconcileItem,
  TrackerSettingsPatch,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerSyncLogEntry,
  TrackerSyncPassSummary,
  TrackerWizardSourceInput,
  TrackerWorkspaceIdentity,
} from '../../../../shared/types/trackerSync';
import type { LoggerLike } from '../../orchestrator/types';
import { TASK_ALL_CHANNEL, taskChangeEvents } from '../../orchestrator/taskChangeRouter';
import {
  trackerProjectChannel,
  trackerSyncEvents,
  type TrackerChangedEvent,
  type TrackerSyncFacade,
} from '../../orchestrator/trackerSyncBridge';
import type { TrackerAdapter } from './adapterTypes';
import type { StoredSourceScope } from './store';
import {
  TrackerAuthError,
  TrackerConnectionNotFoundError,
  TrackerConnectionPausedError,
  TrackerIdentityMismatchError,
} from './errors';
import { LinearAdapter } from './linearAdapter';
import { PlaneAdapter } from './planeAdapter';
import { DartAdapter } from './dartAdapter';
import { decryptTrackerSecret, encryptTrackerSecret } from './secrets';
import {
  cancelPendingKinds,
  clearSecret,
  connectionMatchesIdentity,
  enqueueOutbox,
  findDisconnectedConnection,
  getConflict,
  getConnection,
  getLinkByEntity,
  getLinkById,
  hasActiveLinkedDescendant,
  insertConnection,
  listActiveLinksWithoutEntity,
  listConnections,
  listConnectionsByIdentity,
  listLinks,
  listOpenConflicts,
  listUnresolvedOutbox,
  markOrphaned,
  reactivateConnection,
  readSecret,
  requeueInFlightAsAmbiguous,
  resolveConflict,
  storeSecret,
  claimPushTarget,
  listConnectionsForProviderProject,
  listDuplicatePushTargets,
  sourceScopeEquals,
  storedSourceScope,
  supersedeQueuedStateWrites,
  updateBaseline,
  updateConnectionSettings,
  upsertLink,
  type NewConnectionRow,
} from './store';
import {
  joinBody,
  readConflictRemoteLocal,
  readConflictRemoteState,
  runDeletionSweep,
  runInboundSync,
  splitBody,
  type EntityWriteRouter,
  type InboundSweepReport,
  type InboundSyncReport,
  type ReviewFindingRouter,
} from './inboundSync';
import { isPriority, resolveEffectivePriorityMapping, seedDefaultPriorityMapping } from './priorityMapping';
import { isCategory, resolveEffectiveCategoryMapping, seedDefaultCategoryMapping } from './categoryMapping';
import { drainOutbox, processAmbiguous, toSqliteUtc, type OutboxDeps, type OutboxReport } from './outboxWorker';
import { resolveEffectiveMapping, resolveStageIds } from './stateMapping';
import {
  createWriteBackListener,
  enqueueArchiveWrite,
  enqueueContentWrite,
  parseJsonObject,
  readDesiredGroup,
  writeBackGroupForStage,
  type UpdateStatePayload,
  type WriteBackGroup,
  type WriteBackListener,
} from './writeBack';
import { removalWriteBackAction } from './providerCapabilities';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** The proposal's fixed poll cadence: a connection syncs at most this often. */
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;

/** How often the loop LOOKS for due connections (cheap; the cadence above gates the work). */
export const TICK_INTERVAL_MS = 60 * 1000;

/** Collapse a burst of write-back-producing entity events into one drain. */
export const WRITE_BACK_DEBOUNCE_MS = 2 * 1000;

/**
 * Deletion-sweep cadence, in passes. 12 passes x 5 minutes = roughly hourly on
 * a connection polling continuously. The counter is IN-MEMORY (see
 * {@link TrackerSyncService.passCounts}) and starts at 0, so the first pass
 * after a boot always sweeps — the moment a remote hard-delete is most likely
 * to have been missed (the app was closed) — and every 12th pass thereafter.
 */
export const SWEEP_EVERY_N_PASSES = 12;

/** Cap on a connection's stored pass log, so debounced drains cannot grow it unbounded. */
const MAX_LOG_ENTRIES = 60;

/**
 * How long a STAGED local-removal ruling stays consumable
 * ({@link TrackerSyncService.stageUnlinkRuling}). The ruling is collected in a
 * dialog that immediately opens the delete/archive confirm, so a consumed one
 * is milliseconds old; this window only has to survive a user reading that
 * confirm. Anything older was ABANDONED — the user backed out — and must never
 * be applied to some later, unrelated removal.
 */
export const UNLINK_RULING_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Direction modes
// ---------------------------------------------------------------------------

/**
 * What caused a pass. 'auto' is the 5-minute tick and the debounced write-back
 * drain — the cadences a 'manual' direction opts out of. 'manual' is the user
 * asking ("Sync now", and the first pass `connect` kicks, which is that same
 * ask spelled differently): it runs EVERY direction whatever the modes say,
 * because a mode is a statement about automatic cadence, not about consent.
 */
export type TrackerSyncTrigger = 'auto' | 'manual';

/** The outbox kinds the STATUS direction owns (linked items' state, outbound). */
const STATUS_OUTBOX_KINDS = ['update_state', 'close_parent'] as const;

/**
 * The outbox kinds the PUSH direction owns. Sub-issue mirroring rides here
 * alongside the top-level push: both file NEW issues into the user's tracker,
 * which is the thing `push_mode` decides the cadence of.
 */
const PUSH_OUTBOX_KINDS = ['create_sub_issue', 'create_issue'] as const;

/** True when a direction in `mode` may run under `trigger`. */
function directionRuns(mode: TrackerDirectionMode, trigger: TrackerSyncTrigger): boolean {
  return mode === 'auto' || trigger === 'manual';
}

/**
 * The outbox kinds the CONTENT direction owns (field write-back, migration 118).
 */
const CONTENT_OUTBOX_KINDS = ['update_content'] as const;

/**
 * The outbox kinds the ARCHIVE direction owns (remote trash/archive, migration
 * 112).
 */
const ARCHIVE_OUTBOX_KINDS = ['archive_issue'] as const;

/**
 * True when a {@link TrackerContentSyncMode} direction may run under `trigger`.
 *
 * `'off'` short-circuits BEFORE the `trigger === 'manual'` escape — the one
 * place this differs from {@link directionRuns} — because "Sync now" must
 * never drain a direction the user has declined altogether (invariant 5 of
 * docs/proposals/tracker-field-writeback.md): unlike `auto`/`manual`, which
 * only disagree about WHEN a direction runs, `'off'` disagrees about WHETHER
 * it ever does.
 */
function contentDirectionRuns(mode: TrackerContentSyncMode, trigger: TrackerSyncTrigger): boolean {
  return mode !== 'off' && (mode === 'auto' || trigger === 'manual');
}

/**
 * The outbox kinds this pass may CLAIM. Rows of every other kind stay `pending`
 * and in order until a pass whose filter includes them comes along — the whole
 * "manual delays work, it never drops it" contract, expressed as a claim
 * filter rather than as a skipped enqueue.
 */
function drainKinds(
  connection: TrackerConnectionRow,
  trigger: TrackerSyncTrigger,
): TrackerOutboxRow['kind'][] {
  const kinds: TrackerOutboxRow['kind'][] = [];
  if (directionRuns(connection.status_sync_mode, trigger)) kinds.push(...STATUS_OUTBOX_KINDS);
  if (directionRuns(connection.push_mode, trigger)) kinds.push(...PUSH_OUTBOX_KINDS);
  if (contentDirectionRuns(connection.content_sync_mode, trigger)) kinds.push(...CONTENT_OUTBOX_KINDS);
  if (contentDirectionRuns(connection.archive_sync_mode, trigger)) kinds.push(...ARCHIVE_OUTBOX_KINDS);
  return kinds;
}

/**
 * The outbox kinds NO trigger can drain for this connection right now — the
 * exact complement {@link drainKinds} can never include, whatever the trigger.
 *
 * Only the two migration-112 modes have an `'off'` state at all; the other
 * three are binary (`TrackerDirectionMode = 'auto' | 'manual'`), so their kinds
 * are always claimable by SOME trigger and can never become undrainable. That
 * is a type-level guarantee, not a convention — which is why this reads the two
 * content-sync modes directly rather than asking {@link drainKinds} what it
 * left out.
 */
function undrainableKinds(connection: TrackerConnectionRow): {
  kinds: TrackerOutboxRow['kind'][];
  reason: string;
}[] {
  const off: { kinds: TrackerOutboxRow['kind'][]; reason: string }[] = [];
  if (connection.content_sync_mode === 'off') {
    off.push({
      kinds: [...CONTENT_OUTBOX_KINDS],
      reason: 'cancelled — content sync is off for this connection',
    });
  }
  if (connection.archive_sync_mode === 'off') {
    off.push({
      kinds: [...ARCHIVE_OUTBOX_KINDS],
      reason: 'cancelled — archive sync is off for this connection',
    });
  }
  return off;
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/**
 * One line of the connected view's sync log. PROMOTED to
 * shared/types/trackerSync.ts now that the connected view reads it over tRPC;
 * re-exported here so the engine-side call sites keep their local import.
 */
export type { TrackerSyncLogEntry };

/**
 * What one {@link TrackerSyncService.syncConnection} pass did. An ALIAS of the
 * wire shape rather than a twin declaration: "Sync now" hands this straight to
 * the renderer, and a second copy of the interface is exactly the drift the IPC
 * type-parity rules exist to prevent.
 */
export type TrackerSyncPassResult = TrackerSyncPassSummary;

/**
 * Build the provider client for a connection. `secret` is the DECRYPTED API
 * key — this factory is the only place it exists as a string outside
 * secrets.ts, and it never leaves the main process.
 */
export type TrackerAdapterFactory = (
  connection: TrackerConnectionRow,
  secret: string,
) => TrackerAdapter;

/**
 * The connection's stored credentials cannot produce a working client (no
 * ciphertext, an undecryptable blob, or a provider field the connect flow never
 * filled in). Treated exactly like a TrackerAuthError: pause, do not retry on a
 * timer.
 */
export class TrackerCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrackerCredentialsError';
  }
}

/** What {@link TrackerSyncService.runWriteBack} did with phases 1+2. */
interface WriteBackOutcome {
  /** The connection ended up `paused` — an auth failure inside the worker. */
  paused: boolean;
  /** The connection stopped being active between the two phases (see runPass). */
  abandoned: boolean;
}

/** {@link TrackerSyncService.recoverCreatesBeforeInbound}'s ruling on phases 3+4. */
interface InboundGate {
  /** Inbound (and the sweep) may run this pass. */
  proceed: boolean;
  /** The extra reconcile round hit an auth failure and paused the connection. */
  paused: boolean;
}

export interface TrackerSyncServiceDeps {
  /** Real better-sqlite3 handle; all tracker-table access goes through store.ts. */
  db: Database.Database;
  /**
   * The entity write chokepoint. Declared structurally (TaskChangeRouter
   * satisfies it) for the same reason inboundSync does: nothing here should be
   * tempted to reach past applyChange.
   */
  router: EntityWriteRouter;
  /**
   * The review-inbox chokepoint. Declared structurally (ReviewItemRouter
   * satisfies it) for the same reason `router` is. OPTIONAL so a test can drive
   * the loop without one — the engine then files no auto-resolution audit
   * findings, and the resolved conflict rows stay the only record.
   */
  reviewRouter?: ReviewFindingRouter;
  /** Injected clock (ISO-8601). Defaults to the real one. */
  nowIso?: () => string;
  /** Injected provider-client construction. Defaults to {@link defaultAdapterFactory}. */
  adapterFactory?: TrackerAdapterFactory;
  /** Optional structured logger for loop-level failures. */
  logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Default adapter construction
// ---------------------------------------------------------------------------

/**
 * Provider client from a connection row + its decrypted key.
 *
 * PLANE'S WORKSPACE SLUG comes from `workspace_id`, not `source_json`.
 * `source_json` holds the wizard's Step-1 source choice (container/narrow ids)
 * and nothing else; the slug is workspace IDENTITY, and PlaneAdapter's own
 * `validateCredentials` returns `workspaceId: <slug>` — so the connect flow
 * that persists the validated identity necessarily writes the slug into
 * `workspace_id`. A Plane connection without one cannot address any REST path,
 * hence the hard error rather than a guess.
 */
export function defaultAdapterFactory(
  connection: TrackerConnectionRow,
  secret: string,
): TrackerAdapter {
  switch (connection.provider) {
    case 'linear':
      return new LinearAdapter({ apiKey: secret });
    case 'dart':
      // Dart is cloud-only and workspace-scoped by the token itself, so it needs
      // neither a base URL nor a workspace slug — the key alone addresses
      // everything.
      return new DartAdapter({ apiKey: secret });
    case 'plane': {
      const workspaceSlug = (connection.workspace_id ?? '').trim();
      if (workspaceSlug.length === 0) {
        throw new TrackerCredentialsError(
          `connection ${connection.id}: plane connections need a workspace slug in workspace_id`,
        );
      }
      return new PlaneAdapter({
        apiKey: secret,
        workspaceSlug,
        // undefined (not null) so PlaneAdapter's own `?? DEFAULT_BASE_URL` applies.
        baseUrl: connection.base_url ?? undefined,
      });
    }
    default: {
      // Exhaustiveness guard: TrackerProvider gained a member and this factory
      // did not. A `never` binding turns that into a COMPILE error, so the
      // failure surfaces at the seam rather than as a connection silently
      // adopting whichever adapter the old if/else fell through to.
      const unreachable: never = connection.provider;
      throw new TrackerCredentialsError(
        `connection ${connection.id}: unsupported tracker provider ${String(unreachable)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Staged local-removal rulings
// ---------------------------------------------------------------------------

/** One collected-but-not-yet-consumed local-removal ruling. */
interface StagedUnlinkRuling {
  /** The user's answer: cancel the tracker issue, or leave it exactly as it is. */
  cancelRemote: boolean;
  /** When it was collected (ms), for the {@link UNLINK_RULING_TTL_MS} expiry. */
  stagedAt: number;
}

/** The staged-ruling map's key. */
function rulingKey(entityType: TrackerEntityType, entityId: string): string {
  return `${entityType}:${entityId}`;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class TrackerSyncService implements TrackerSyncFacade {
  private readonly db: Database.Database;
  private readonly router: EntityWriteRouter;
  private readonly reviewRouter?: ReviewFindingRouter;
  private readonly nowIso: () => string;
  private readonly adapterFactory: TrackerAdapterFactory;
  private readonly logger?: LoggerLike;

  private timer: ReturnType<typeof setInterval> | null = null;
  private listener: WriteBackListener | null = null;
  /** The bound emitter subscription, kept so stop() can remove exactly it. */
  private subscription: ((event: TaskChangedEvent) => void) | null = null;

  /**
   * Per-connection mutex. A second syncConnection while one is in flight
   * COALESCES onto the running pass rather than queueing a redundant one — a
   * "Sync now" during a poll should not double-poll, and two ticks can never
   * interleave two drains of the same outbox.
   */
  private readonly passes = new Map<string, Promise<TrackerSyncPassResult>>();

  /** Passes since boot, per connection — the deletion sweep's cadence counter. */
  private readonly passCounts = new Map<string, number>();

  /** Armed write-back debounce timers, per connection. */
  private readonly drainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Local-removal rulings the delete/archive dialog has COLLECTED but whose
   * entity has not been removed yet, keyed `entityType:entityId`
   * ({@link rulingKey}).
   *
   * DELIBERATELY IN-MEMORY, and deliberately not durable. A ruling exists only
   * for the milliseconds between the dialog's button and the confirm dialog's
   * mutation, in ONE app session — it is never read by another process and
   * never survives a quit usefully. Persisting it would be strictly worse: an
   * unconsumed ruling (the user backed out of the confirm) would then outlive
   * the session and silently cancel someone's issue the next time that entity
   * was deleted, weeks later.
   *
   * A ruling is keyed by ENTITY ONLY — it carries no correlation to the one
   * removal the user was looking at — so an ABANDONED one is a loaded gun
   * pointed at every later removal of that entity. Three layers keep it
   * harmless, and each covers a case the others cannot:
   *
   *   1. EXPLICIT INVALIDATION ({@link TrackerSyncService.clearUnlinkRuling}).
   *      The renderer clears the ruling the moment its confirm dialog closes
   *      without committing (and when the ruling dialog itself is dismissed).
   *      The precise, immediate answer — but it depends on the renderer being
   *      alive and reachable, so it cannot be the only one.
   *   2. ACTOR CHECK ({@link TrackerSyncService.handleLocalRemoval}). A ruling
   *      is a HUMAN's answer to a dialog, so only an `actor: 'user'` removal
   *      may spend it. A provider-authored (inbound sync) or
   *      orchestrator-authored archive/delete during the window can never
   *      consume one, however the window was left open.
   *   3. TTL ({@link UNLINK_RULING_TTL_MS}). The backstop under both: it bounds
   *      abandonment that layer 1 missed (renderer crash, a reload mid-confirm)
   *      to ten minutes, after which no actor can spend the ruling either.
   */
  private readonly stagedRulings = new Map<string, StagedUnlinkRuling>();

  constructor(deps: TrackerSyncServiceDeps) {
    this.db = deps.db;
    this.router = deps.router;
    this.reviewRouter = deps.reviewRouter;
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.adapterFactory = deps.adapterFactory ?? defaultAdapterFactory;
    this.logger = deps.logger;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Boot the loop (idempotent). Order matters: crash recovery runs BEFORE any
   * listener or timer, so no drain can start against a connection whose
   * `in_flight` rows have not yet been demoted to `ambiguous` — that demotion
   * is the only thing standing between a lost create response and a duplicate
   * sub-issue.
   */
  start(): void {
    if (this.timer !== null) return;

    this.recoverInFlightWrites();
    this.reconcilePushTargets();

    this.listener = createWriteBackListener({ db: this.db, nowIso: this.nowIso });
    this.subscription = (event: TaskChangedEvent): void => this.handleTaskChanged(event);
    taskChangeEvents.on(TASK_ALL_CHANNEL, this.subscription);

    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.logger?.error('[trackerSync] tick failed', { error: describeError(err) });
      });
    }, TICK_INTERVAL_MS);
    // Never keep the app alive for the poll timer.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * Stop the loop (idempotent). In-flight passes are NOT cancelled — each one
   * settles its own outbox rows, and abandoning a pass mid-drain is exactly the
   * crash the ambiguous-recovery path exists to clean up. Quitting mid-pass is
   * therefore safe, just not free.
   */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const timer of this.drainTimers.values()) clearTimeout(timer);
    this.drainTimers.clear();
    // A ruling is only ever consumed by an entity event, and we are about to
    // stop listening for those — keeping one would just be a stale answer to a
    // question a future session never asked.
    this.stagedRulings.clear();
    if (this.subscription !== null) {
      taskChangeEvents.off(TASK_ALL_CHANNEL, this.subscription);
      this.subscription = null;
    }
    this.listener?.dispose();
    this.listener = null;
  }

  /**
   * Boot repair for the one-pusher-per-(project, provider) invariant. connect()
   * never leaves two armed rows behind, but a ledger-wiped migration replay
   * can: 105's table recreate predates 109, so a full replay drops push_target
   * and 109 re-adds it at DEFAULT 1 on EVERY row (109's header documents this).
   * Left alone, the next pushed idea would file one remote issue per armed
   * sibling. The oldest ARMED row keeps the flag — stable, and for any
   * pre-replay state the row most likely to have held it; a row someone
   * deliberately demoted is never re-armed by the repair.
   */
  private reconcilePushTargets(): void {
    try {
      for (const pair of listDuplicatePushTargets(this.db)) {
        const rows = listConnectionsForProviderProject(this.db, pair.project_id, pair.provider);
        const armed = rows.filter((row) => row.push_target === 1);
        if (armed.length === 0) continue;
        claimPushTarget(this.db, pair.project_id, pair.provider, armed[0].id);
        this.logger?.warn('[trackerSync] boot recovery: demoted duplicate push targets', {
          projectId: pair.project_id,
          provider: pair.provider,
          keptConnectionId: armed[0].id,
        });
      }
    } catch (err) {
      this.logger?.error('[trackerSync] boot recovery: push-target reconciliation failed', {
        error: describeError(err),
      });
    }
  }

  /**
   * Boot crash recovery: every `in_flight` outbox row belongs to a write whose
   * outcome the last app lifetime never learned, so it becomes `ambiguous` and
   * the next pass reconciles it before retrying anything. Fail-soft per
   * connection — one unreadable connection must not strand the others.
   */
  private recoverInFlightWrites(): void {
    let connections: TrackerConnectionRow[];
    try {
      connections = listConnections(this.db);
    } catch (err) {
      this.logger?.error('[trackerSync] boot recovery: listing connections failed', {
        error: describeError(err),
      });
      return;
    }
    for (const connection of connections) {
      if (connection.status !== 'active') continue;
      try {
        const requeued = requeueInFlightAsAmbiguous(this.db, connection.id);
        if (requeued > 0) {
          this.logger?.warn('[trackerSync] boot recovery: requeued in-flight writes as ambiguous', {
            connectionId: connection.id,
            requeued,
          });
        }
      } catch (err) {
        this.logger?.error('[trackerSync] boot recovery failed for a connection', {
          connectionId: connection.id,
          error: describeError(err),
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  /**
   * Run every DUE connection, one at a time. Exposed (rather than living inside
   * the interval callback) so tests drive the loop directly instead of waiting
   * on wall-clock timers — the interval is a thin caller of this.
   *
   * Sequential by design: two connections syncing at once would double the
   * concurrent API pressure for no latency the user can perceive on a 5-minute
   * cadence.
   */
  async tick(): Promise<void> {
    let connections: TrackerConnectionRow[];
    try {
      connections = listConnections(this.db);
    } catch (err) {
      this.logger?.error('[trackerSync] tick: listing connections failed', {
        error: describeError(err),
      });
      return;
    }
    for (const connection of connections) {
      if (connection.status !== 'active') continue;
      if (!this.isDue(connection)) continue;
      await this.syncConnection(connection.id);
    }
  }

  /** A connection is due when it has never synced, or its last pass is a full interval old. */
  private isDue(connection: TrackerConnectionRow): boolean {
    const last = parseTimestamp(connection.last_sync_at);
    if (last === null) return true;
    const now = parseTimestamp(this.nowIso()) ?? Date.now();
    return now - last >= SYNC_INTERVAL_MS;
  }

  /**
   * Run ONE pass for one connection. See the file header for the phase order
   * and the failure policy. Never rejects: every failure is folded into the
   * returned result and the persisted log.
   */
  syncConnection(
    connectionId: string,
    opts: { force?: boolean; trigger?: TrackerSyncTrigger } = {},
  ): Promise<TrackerSyncPassResult> {
    const trigger = opts.trigger ?? 'auto';
    return this.lock(connectionId, () => this.runPass(connectionId, opts.force === true, trigger));
  }

  /**
   * The manual "Sync now" — a forced pass, which also always sweeps for
   * deletions AND runs every direction regardless of its mode (see
   * {@link TrackerSyncTrigger}).
   */
  syncNow(connectionId: string): Promise<TrackerSyncPassResult> {
    return this.syncConnection(connectionId, { force: true, trigger: 'manual' });
  }

  /**
   * Per-connection mutex. Returns the IN-FLIGHT pass when one exists so
   * concurrent callers coalesce onto a single run instead of serializing two.
   */
  private lock(
    connectionId: string,
    run: () => Promise<TrackerSyncPassResult>,
  ): Promise<TrackerSyncPassResult> {
    const inFlight = this.passes.get(connectionId);
    if (inFlight !== undefined) return inFlight;
    const started = (async (): Promise<TrackerSyncPassResult> => {
      try {
        return await run();
      } finally {
        this.passes.delete(connectionId);
      }
    })();
    this.passes.set(connectionId, started);
    return started;
  }

  /**
   * ONE pass, guarded at every phase boundary.
   *
   * A pass is only ever legitimate for an ACTIVE connection. `tick` already
   * filters, but "Sync now" (and the fire-and-forget pass `connect` kicks) can
   * arrive against a row the user paused or disconnected in the meantime — hence
   * the entry check.
   *
   * ABANDONING. The status is then RE-READ between phases, because `disconnect`
   * flips that column while a pass is in flight. Once it is no longer active the
   * pass stops where it stands and persists NOTHING — no `last_sync_at`, no log,
   * no broadcast. The phase already in flight still finishes (nothing can
   * un-send an HTTP request), but its outcome can no longer be followed by
   * another local write, remote write, or cursor advance. What that leaves
   * behind — a settled outbox row, a moved cursor, an un-swept deletion — is
   * exactly the shape a crash mid-pass leaves, which boot recovery
   * ({@link recoverInFlightWrites}) and the next pass already reconcile.
   *
   * The one status change that does NOT abandon is this pass's own auth pause:
   * it must still write the '⚠ authorization failed' line the connected view
   * renders as a re-connect prompt.
   */
  private async runPass(
    connectionId: string,
    force: boolean,
    trigger: TrackerSyncTrigger,
  ): Promise<TrackerSyncPassResult> {
    const entries: TrackerSyncLogEntry[] = [];
    const connection = getConnection(this.db, connectionId);
    if (connection === null) {
      return {
        connectionId,
        ran: false,
        swept: false,
        paused: false,
        entries,
        error: 'connection not found',
      };
    }
    if (connection.status !== 'active') return inactiveResult(connectionId, connection.status);

    // Counted BEFORE the work so a failing pass still advances the sweep clock.
    const passIndex = this.passCounts.get(connectionId) ?? 0;
    this.passCounts.set(connectionId, passIndex + 1);
    const sweepDue = force || passIndex % SWEEP_EVERY_N_PASSES === 0;

    let paused = false;
    let swept = false;
    let error: string | null = null;
    /** Conflicts opened/auto-resolved this pass — drives the 'conflicts' broadcast. */
    let conflictsTouched = 0;

    // THE DIRECTION GATES for this pass, resolved once from the connection's
    // three modes and the trigger, and reported into the log so a user looking
    // at "nothing happened" can see which direction was holding.
    //
    // The inbound PHASE is gated on the union: status sync and import are two
    // independent directions that happen to share one fetch, so a connection
    // that pulls manually but syncs status automatically must still merge its
    // linked items every pass (and sweep for remote deletions). Inside the
    // phase, each direction gates its own half — see runInboundSync's
    // applyLinkedStage / importNewIssues.
    const drainable = drainKinds(connection, trigger);
    const pullRuns = directionRuns(connection.pull_mode, trigger);
    const applyLinkedStage = directionRuns(connection.status_sync_mode, trigger);
    const inboundRuns = pullRuns || applyLinkedStage;
    appendHeldDirectionLines(entries, connection, trigger);

    try {
      const adapter = this.buildAdapter(connection);
      const writeBack = await this.runWriteBack(connection, adapter, entries, drainable);
      if (writeBack.abandoned) return abandonedResult(connectionId, entries);
      paused = writeBack.paused;

      // Phases 3+4 are gated on the outbox holding no unresolved create whose
      // outcome is still unknown — see {@link recoverCreatesBeforeInbound}.
      let inboundAllowed = false;
      if (!paused && inboundRuns) {
        // Its own phase boundary: the gate can perform a remote lookup and
        // adopt a create locally, neither of which may follow a disconnect.
        if (!this.isStillActive(connectionId)) return abandonedResult(connectionId, entries);
        const gate = await this.recoverCreatesBeforeInbound(connection, adapter, entries);
        paused = gate.paused;
        inboundAllowed = gate.proceed;
      }

      if (!paused && inboundAllowed) {
        if (!this.isStillActive(connectionId)) return abandonedResult(connectionId, entries);
        // THE LAST MOMENT BEFORE THE BLOCKER SCAN, and deliberately not earlier
        // — see {@link settleUndrainableRows} for why every requeue source in
        // this pass has to have run first.
        this.settleUndrainableRows(connection, entries);
        entries.push({ marker: '▸', line: 'GET issues' });
        const inbound = await runInboundSync(
          {
            db: this.db,
            adapter,
            router: this.router,
            reviewRouter: this.reviewRouter,
            nowIso: this.nowIso,
            applyLinkedStage,
            importNewIssues: pullRuns,
          },
          connection,
        );
        appendInboundLines(entries, inbound);
        conflictsTouched += inbound.conflictsOpened + inbound.autoResolved;

        if (sweepDue) {
          if (!this.isStillActive(connectionId)) return abandonedResult(connectionId, entries);
          entries.push({ marker: '▸', line: 'GET issue ids' });
          const sweep = await runDeletionSweep(
            { db: this.db, adapter, router: this.router, nowIso: this.nowIso },
            connection,
          );
          swept = true;
          appendSweepLines(entries, sweep);
          conflictsTouched += sweep.conflictsOpened + sweep.sweepArchived;
        }
      }
    } catch (err) {
      error = describeError(err);
      if (isCredentialFailure(err)) {
        updateConnectionSettings(this.db, connection.id, { status: 'paused' });
        paused = true;
        entries.push({ marker: '⚠', line: `authorization failed · ${error}` });
        // The connection ROW changed (active -> paused), which the connected
        // view renders as a re-connect prompt — a separate signal from the
        // 'sync' broadcast below.
        this.emitTrackerChange(connection.project_id, connection.id, 'connection');
      } else {
        entries.push({ marker: '⚠', line: `sync failed · ${error}` });
        this.logger?.error('[trackerSync] pass failed', { connectionId, error });
      }
    }

    // The last boundary — a disconnect that landed during the final phase must
    // not have its log and poll-clock stamp written out from under it. `paused`
    // is this pass's own doing, so it is not an abandon.
    if (!paused && !this.isStillActive(connectionId)) {
      return abandonedResult(connectionId, entries);
    }

    entries.push(
      paused
        ? { marker: '⚠', line: 'connection paused — reconnect to resume' }
        : { marker: '✓', line: `sync complete · next in ${SYNC_INTERVAL_MS / 60_000}m` },
    );

    // `last_sync_at` is stamped on FAILED passes too: it is the poll clock, not
    // a success marker, and leaving it null would retry a broken connection
    // every tick instead of every interval.
    this.persistLog(connection.id, entries, { stampSyncedAt: true });
    this.emitTrackerChange(connection.project_id, connection.id, 'sync');
    if (conflictsTouched > 0) {
      this.emitTrackerChange(connection.project_id, connection.id, 'conflicts');
    }

    return { connectionId, ran: true, swept, paused, entries, error };
  }

  /**
   * Phases 1+2 — reconcile ambiguous writes, then drain the queue, with the
   * phase boundary between them guarded exactly like the later ones (see
   * {@link runPass}): a disconnect during the reconcile round-trip must not be
   * followed by a fresh burst of remote writes. An auth pause is this pass's own
   * doing, so it reports `paused`, never `abandoned`.
   */
  private async runWriteBack(
    connection: TrackerConnectionRow,
    adapter: TrackerAdapter,
    entries: TrackerSyncLogEntry[],
    allowedKinds: readonly TrackerOutboxRow['kind'][],
  ): Promise<WriteBackOutcome> {
    const deps: OutboxDeps = {
      db: this.db,
      adapterFor: () => adapter,
      router: this.router,
      nowIso: this.nowIso,
    };
    // DELIBERATELY NOT kind-filtered: an `ambiguous` row is a write whose
    // outcome nobody knows, and leaving one unreconciled halts the inbound
    // batch for every direction. Reconciling is establishing what already
    // happened remotely, not performing a held direction's work — and a row the
    // reconcile returns to `pending` is then subject to the drain filter below
    // like any other.
    const ambiguous = await processAmbiguous(deps, connection);
    const abandoned = !ambiguous.authPaused && !this.isStillActive(connection.id);
    const drained =
      ambiguous.authPaused || abandoned ? null : await drainOutbox(deps, connection, allowedKinds);
    appendWriteBackLines(entries, ambiguous, drained);
    return { paused: ambiguous.authPaused || drained?.authPaused === true, abandoned };
  }

  /**
   * ORDERING BACKSTOP between the drain and the inbound fetch: a create whose
   * outcome nobody knows must be settled BEFORE anything is imported.
   *
   * THE HAZARD. Where a provider cannot make a create idempotent (Plane), a
   * create that COMMITS and then loses its response leaves an `ambiguous` outbox
   * row and a live remote child under a PROVIDER-MINTED id. Inbound halts on an
   * unresolved row's `external_id` / `client_key`, and that child's id is
   * neither — so it reads as an unlinked issue and gets imported as a second,
   * duplicate idea for work we already mirrored.
   *
   * TWO LAYERS, and both are needed. inboundSync additionally halts on the
   * recovery MARKER the child carries in its description
   * (`TrackerIssue.recoveryClientKey`), which is exact but only speaks for an
   * issue this pass actually fetched WITH a description on it. This backstop
   * covers everything that arm cannot see — a slim list payload, a provider that
   * drops the description field, a child outside the fetch window — by simply
   * not importing at all while the question is open.
   *
   * WHAT IT DOES. Nothing when the adapter has idempotent creates (the client
   * key IS the issue id there, so recovery is a point lookup and inbound's
   * `client_key` arm already covers it). Otherwise: one extra
   * {@link processAmbiguous} round — the drain may have just parked a row that
   * phase 1 never saw — and, if anything is STILL unresolved after it, phases
   * 3+4 stand down for this pass. The next pass re-reconciles; deferring an
   * inbound poll costs one interval, a duplicate idea costs the user a cleanup.
   */
  private async recoverCreatesBeforeInbound(
    connection: TrackerConnectionRow,
    adapter: TrackerAdapter,
    entries: TrackerSyncLogEntry[],
  ): Promise<InboundGate> {
    if (!hasUnresolvedCreateRecovery(this.db, connection.id, adapter)) {
      return { proceed: true, paused: false };
    }
    const deps: OutboxDeps = {
      db: this.db,
      adapterFor: () => adapter,
      router: this.router,
      nowIso: this.nowIso,
    };
    const recovered = await processAmbiguous(deps, connection);
    appendWriteBackLines(entries, recovered, null);
    if (recovered.authPaused) return { proceed: false, paused: true };
    if (!hasUnresolvedCreateRecovery(this.db, connection.id, adapter)) {
      return { proceed: true, paused: false };
    }
    entries.push({ marker: '⚠', line: 'inbound deferred · unresolved create recovery' });
    return { proceed: false, paused: false };
  }

  /**
   * SELF-HEALING GATE against a permanent inbound stall: settle every PENDING
   * row whose direction is currently `'off'`, whatever kind it is.
   *
   * WHY THE FLIP-TIME SWEEP IS NOT ENOUGH, even though it exists and stays.
   * `updateSettings` settles the rows that are pending AT THE MOMENT of the
   * flip, which is the right thing to do for immediacy — but `pending` is not a
   * terminal state, and rows keep ARRIVING in it from behind:
   *
   *   - an `in_flight` row (deliberately left alone by the flip, since its
   *     request cannot be recalled) fails retryably afterwards, and
   *     `resolveOutbox`'s retry arm puts it back to `pending`;
   *   - an `ambiguous` row (likewise left alone) is requeued to `pending` by
   *     {@link processAmbiguous} — every non-create kind takes that path by
   *     design, because re-performing them is idempotent;
   *   - a crash mid-flight demotes to `ambiguous` at boot and then follows the
   *     same route.
   *
   * Each of those lands a claimable-looking row of a kind
   * {@link claimNextPending} will never claim — and `collectOutboxBlockers` is
   * KIND-AGNOSTIC, so `runInboundSync` halts at that issue on every pass,
   * forever. Chasing the transitions individually would mean auditing every
   * present and future path into `pending`; asking the question once per pass,
   * where the modes are already resolved, cannot be forgotten by code written
   * later.
   *
   * PLACED IMMEDIATELY BEFORE THE INBOUND FETCH, which is the only correct
   * point and was worth getting wrong once to learn. It has to be LATE enough
   * that every requeue source in this pass has already run — `processAmbiguous`
   * fires twice per pass (once inside the write-back phase, once inside
   * {@link recoverCreatesBeforeInbound}) and each one can move an off-kind row
   * from `ambiguous` to `pending`, so a sweep at the top of the pass heals rows
   * that are then re-stranded behind it. And EARLY enough to precede
   * `runInboundSync`, which is where `collectOutboxBlockers` reads the queue
   * and where the stall would otherwise materialize.
   *
   * The drain needs no protection from either side of that: `claimNextPending`
   * is already filtered by {@link drainKinds}, so an off-kind row is invisible
   * to it whether or not this has run. The debounced write-back drain
   * ({@link drainConnection}) therefore does not call this at all — it performs
   * no inbound fetch, so it has no blocker scan to protect, and the next full
   * pass heals whatever it leaves.
   */
  private settleUndrainableRows(
    connection: TrackerConnectionRow,
    entries: TrackerSyncLogEntry[],
  ): void {
    let settled = 0;
    for (const off of undrainableKinds(connection)) {
      settled += cancelPendingKinds(this.db, connection.id, off.kinds, off.reason);
    }
    if (settled === 0) return;
    // Loud, not silent: these are writes the user's own edits produced, and
    // dropping them is a consequence of a setting they may not connect to it.
    entries.push({
      marker: '⚠',
      line: `${plural(settled, 'queued write')} dropped · that direction is off`,
    });
  }

  /**
   * Phase-boundary guard: is the connection STILL active as PERSISTED right
   * now? Deliberately a re-read rather than the row captured at the start of the
   * pass — `disconnect` (and the auth-pause path) write that column while a pass
   * is in flight, and the captured row would never see it.
   */
  private isStillActive(connectionId: string): boolean {
    return getConnection(this.db, connectionId)?.status === 'active';
  }

  // -------------------------------------------------------------------------
  // Write-back nudge
  // -------------------------------------------------------------------------

  /**
   * Entity-event handler. The listener does the stage/mirroring translation (and
   * never throws — this runs inline on TaskChangeRouter's post-commit emit); we
   * add the local-REMOVAL half and the latency nudge on top.
   *
   * Removal runs FIRST: a ruling that orphans the link must land before the
   * listener looks at the same event, or an archive would still stream a stage
   * write-back for an entity the user just took out of the sync.
   */
  private handleTaskChanged(event: TaskChangedEvent): void {
    this.handleLocalRemoval(event);
    this.listener?.handleTaskChanged(event);
    this.scheduleWriteBackDrain(event.projectId);
  }

  /**
   * Arm the debounced drain for every connection in the event's project that
   * now has a pending outbox row. Checking for a pending row (rather than
   * arming blindly) keeps the common case — an entity that is not linked to any
   * tracker — down to one cheap query and no timer.
   */
  private scheduleWriteBackDrain(projectId: number): void {
    try {
      for (const connection of listConnections(this.db, projectId)) {
        if (connection.status !== 'active') continue;
        // The nudge is an AUTOMATIC cadence, so it only ever arms for a row an
        // 'auto' direction owns. A pending row belonging to a held direction is
        // not a reason to wake up — it is waiting for a "Sync now", which runs
        // its own pass.
        const kinds = new Set<TrackerOutboxRow['kind']>(drainKinds(connection, 'auto'));
        if (kinds.size === 0) continue;
        const pending = listUnresolvedOutbox(this.db, connection.id).some(
          (row) => row.state === 'pending' && kinds.has(row.kind),
        );
        if (!pending) continue;
        this.armDrainTimer(connection.id);
      }
    } catch (err) {
      // Same reasoning as the listener's own swallow: this runs inline on an
      // entity write, so a sync-side failure must never break the backlog write.
      this.logger?.error('[trackerSync] scheduling write-back drain failed', {
        projectId,
        error: describeError(err),
      });
    }
  }

  private armDrainTimer(connectionId: string): void {
    const existing = this.drainTimers.get(connectionId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.drainTimers.delete(connectionId);
      // A full pass is already running. Coalescing onto it would be WRONG here:
      // that pass may have drained before this row was enqueued, which would
      // silently defer the write-back to the next 5-minute tick. Re-arm instead
      // — the row is durable, so waiting another debounce costs nothing.
      if (this.passes.has(connectionId)) {
        this.armDrainTimer(connectionId);
        return;
      }
      void this.drainConnection(connectionId).catch((err: unknown) => {
        this.logger?.error('[trackerSync] debounced write-back drain failed', {
          connectionId,
          error: describeError(err),
        });
      });
    }, WRITE_BACK_DEBOUNCE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.drainTimers.set(connectionId, timer);
  }

  /**
   * Write-back-only pass: reconcile + drain, no inbound fetch and no sweep.
   * Shares the per-connection lock so it can never interleave with a full pass
   * (the debounce timer re-arms rather than coalescing — see
   * {@link armDrainTimer}), and APPENDS its lines to the stored log without
   * touching `last_sync_at` — the 5-minute inbound cadence is unaffected by how
   * often the user moves cards.
   */
  async drainConnection(connectionId: string): Promise<TrackerSyncPassResult> {
    return this.lock(connectionId, async () => {
      const entries: TrackerSyncLogEntry[] = [];
      const connection = getConnection(this.db, connectionId);
      if (connection === null) {
        return {
          connectionId,
          ran: false,
          swept: false,
          paused: false,
          entries,
          error: 'connection not found',
        };
      }
      // Same guard as a full pass: a drain armed just before the user paused or
      // disconnected must not run — it would find no stored key and pause a row
      // that is already retired.
      if (connection.status !== 'active') return inactiveResult(connectionId, connection.status);

      let paused = false;
      let error: string | null = null;
      try {
        const adapter = this.buildAdapter(connection);
        // 'auto' trigger: the debounced drain IS the automatic cadence, so a
        // held direction's rows stay queued for the next "Sync now".
        const writeBack = await this.runWriteBack(
          connection,
          adapter,
          entries,
          drainKinds(connection, 'auto'),
        );
        if (writeBack.abandoned) return abandonedResult(connectionId, entries);
        paused = writeBack.paused;
      } catch (err) {
        error = describeError(err);
        if (isCredentialFailure(err)) {
          updateConnectionSettings(this.db, connection.id, { status: 'paused' });
          paused = true;
          entries.push({ marker: '⚠', line: `authorization failed · ${error}` });
          this.emitTrackerChange(connection.project_id, connection.id, 'connection');
        } else {
          entries.push({ marker: '⚠', line: `write-back failed · ${error}` });
          this.logger?.error('[trackerSync] write-back drain failed', { connectionId, error });
        }
      }

      // Same last boundary as a full pass: a drain whose connection was retired
      // under it appends nothing to the log it no longer owns.
      if (!paused && !this.isStillActive(connectionId)) {
        return abandonedResult(connectionId, entries);
      }

      // A drain that had nothing to say leaves the last pass's log alone.
      if (entries.length > 0) {
        this.persistLog(connection.id, entries, { stampSyncedAt: false });
        this.emitTrackerChange(connection.project_id, connection.id, 'sync');
      }
      return { connectionId, ran: true, swept: false, paused, entries, error };
    });
  }

  // -------------------------------------------------------------------------
  // Adapters + log persistence
  // -------------------------------------------------------------------------

  /**
   * Build this pass's provider client. ONE per pass, shared by the write-back
   * and inbound halves: the adapters carry per-instance caches (Plane's project
   * identifier lookup) that a per-phase rebuild would throw away, and building
   * fresh each pass keeps a re-connected key from being pinned by a stale
   * instance.
   */
  private buildAdapter(connection: TrackerConnectionRow): TrackerAdapter {
    const cipher = readSecret(this.db, connection.id);
    if (cipher === null || cipher.length === 0) {
      throw new TrackerCredentialsError(`connection ${connection.id} has no stored API key`);
    }
    let secret: string;
    try {
      secret = decryptTrackerSecret(cipher);
    } catch (err) {
      throw new TrackerCredentialsError(
        `connection ${connection.id}: stored API key could not be decrypted · ${describeError(err)}`,
      );
    }
    return this.adapterFactory(connection, secret);
  }

  /**
   * Persist a pass log. A full pass REPLACES the log (it is the narrative of
   * that pass); a debounced drain APPENDS to it, capped at MAX_LOG_ENTRIES so
   * a busy hour of card moves cannot grow the blob without bound.
   */
  private persistLog(
    connectionId: string,
    entries: TrackerSyncLogEntry[],
    opts: { stampSyncedAt: boolean },
  ): void {
    const composed = opts.stampSyncedAt
      ? entries
      : readStoredLog(this.db, connectionId).concat(entries).slice(-MAX_LOG_ENTRIES);
    updateConnectionSettings(this.db, connectionId, {
      ...(opts.stampSyncedAt ? { last_sync_at: toSqliteUtc(this.nowIso()) } : {}),
      last_sync_log_json: JSON.stringify(composed),
    });
  }

  /** Broadcast one connection change on its project channel (see trackerSyncBridge). */
  private emitTrackerChange(
    projectId: number,
    connectionId: string,
    kind: TrackerChangedEvent['kind'],
  ): void {
    const event: TrackerChangedEvent = { projectId, connectionId, kind };
    trackerSyncEvents.emit(trackerProjectChannel(projectId), event);
  }

  // =========================================================================
  // TrackerSyncFacade — the Settings > Integrations surface
  // =========================================================================

  // -------------------------------------------------------------------------
  // Wizard probes (stateless — NOTHING is persisted)
  // -------------------------------------------------------------------------

  /**
   * Build a THROWAWAY provider client from renderer-supplied credentials.
   *
   * The row handed to the factory is a VALUE OBJECT, never inserted: it exists
   * only so the wizard reuses the exact construction path the sync loop uses
   * (including the INJECTED `adapterFactory`, so a test drives the wizard
   * through the same fake adapter). The plaintext key lives for the duration of
   * the call and is written nowhere — `connect` is the only method that
   * persists one, and it encrypts first.
   *
   * `workspace_id` carries Plane's workspace SLUG (what defaultAdapterFactory
   * addresses every REST path with); Linear ignores it.
   */
  private adapterForCredentials(credentials: TrackerCredentialsInput): TrackerAdapter {
    const scratch: TrackerConnectionRow = {
      id: `wizard-${credentials.provider}`,
      project_id: 0,
      provider: credentials.provider,
      status: 'active',
      workspace_id: credentials.workspaceSlug ?? null,
      workspace_name: null,
      actor_label: null,
      base_url: credentials.baseUrl ?? null,
      secret_ciphertext: null,
      source_json: null,
      selection_mode: 'all',
      selection_json: null,
      state_mapping_json: '{}',
      // Irrelevant to a probe (nothing syncs through a scratch row) but the
      // shape is the row's, so they are spelled out rather than guessed at.
      status_sync_mode: 'manual',
      pull_mode: 'manual',
      push_mode: 'manual',
      push_target: 0,
      content_sync_mode: 'off',
      archive_sync_mode: 'off',
      priority_mapping_json: '{}',
      category_mapping_json: '{}',
      mirror_subissues: 0,
      conflict_mode: 'auto',
      cursor_updated_at: null,
      cursor_external_id: null,
      last_sync_at: null,
      last_sync_log_json: null,
      created_at: '',
      updated_at: '',
    };
    return this.adapterFactory(scratch, credentials.apiKey);
  }

  /**
   * The credentials an EXISTING connection already holds, decrypted — the
   * "add another mapping to this connection" path's answer to "where is the key".
   *
   * Mapping management re-enters the wizard from a connection the user has
   * already authorized, so re-asking for the key would be a worse question than
   * not asking: the same key is sitting encrypted on the row, and every probe the
   * wizard makes is against that same workspace and instance. Addressing
   * (`baseUrl`) and Plane's slug (`workspaceSlug`) come off the ROW rather than
   * from anything the renderer sends — this resolves a key, it never re-points a
   * connection at a different instance.
   *
   * A DISCONNECTED row is treated as absent: `disconnect` deliberately clears the
   * ciphertext, so there is no key to reuse and "not found" is the honest answer
   * rather than an auth failure the user cannot act on.
   *
   * @throws {TrackerConnectionNotFoundError} unknown or retired connection id.
   * @throws {TrackerAuthError} the stored key is missing or undecryptable
   *   (mapped to UNAUTHORIZED — the actionable fix is pasting a fresh key).
   */
  private credentialsForConnection(connectionId: string): TrackerCredentialsInput {
    const row = getConnection(this.db, connectionId);
    if (row === null || row.status === 'disconnected') {
      throw new TrackerConnectionNotFoundError(connectionId);
    }
    const cipher = readSecret(this.db, connectionId);
    if (cipher === null || cipher.length === 0) {
      throw new TrackerAuthError(
        row.provider,
        'stored API key for this connection is unusable — reconnect with a fresh key',
      );
    }
    let secret: string;
    try {
      secret = decryptTrackerSecret(cipher);
    } catch {
      throw new TrackerAuthError(
        row.provider,
        'stored API key for this connection is unusable — reconnect with a fresh key',
      );
    }
    return {
      provider: row.provider,
      apiKey: secret,
      baseUrl: row.base_url ?? undefined,
      workspaceSlug: row.workspace_id ?? undefined,
    };
  }

  /**
   * Resolve a wizard probe's credential SOURCE — a pasted key or an existing
   * connection's stored one — into the credentials the probe runs with.
   *
   * EXACTLY ONE, enforced rather than defaulted: the two keys answer the same
   * question, so a payload carrying both is a caller bug (which key did it mean?)
   * and one carrying neither cannot probe anything. A plain Error, because there
   * is no renderer-actionable distinction to make — the tRPC layer refines the
   * same rule and rejects it as BAD_REQUEST before it reaches here.
   */
  private credentialsFromSource(source: TrackerWizardSourceInput): TrackerCredentialsInput {
    if (source.credentials !== undefined) {
      if (source.connectionId !== undefined) {
        throw new Error('exactly one of credentials / connectionId');
      }
      return source.credentials;
    }
    if (source.connectionId === undefined) {
      throw new Error('exactly one of credentials / connectionId');
    }
    return this.credentialsForConnection(source.connectionId);
  }

  /** Live credential probe — the wizard's "Authorized as …" card. */
  async wizardValidate(credentials: TrackerCredentialsInput): Promise<TrackerWorkspaceIdentity> {
    return this.adapterForCredentials(credentials).validateCredentials();
  }

  /**
   * The Map step's groups — every tracker grouping that can be mapped onto a
   * cyboflow project, each carrying the source selection a `connect` for it
   * would persist.
   *
   * Takes a credential SOURCE rather than credentials: mapping management
   * re-enters this step from an already-authorized connection, and that run has
   * no pasted key to offer (see {@link credentialsForConnection}).
   */
  async wizardGroups(source: TrackerWizardSourceInput): Promise<TrackerGroupTree> {
    return this.adapterForCredentials(this.credentialsFromSource(source)).listGroups();
  }

  /** Wizard Step 1, top level (Linear teams / Plane projects). */
  async wizardContainers(credentials: TrackerCredentialsInput): Promise<TrackerSourceTree> {
    return this.adapterForCredentials(credentials).listContainers();
  }

  /** Wizard Step 1, second level for one container. */
  async wizardNarrows(
    credentials: TrackerCredentialsInput,
    containerId: string,
  ): Promise<TrackerSourceNarrow[]> {
    return this.adapterForCredentials(credentials).listNarrows(containerId);
  }

  /**
   * Wizard Step 3 — the source's states, with canonical groups for the mapping
   * table. Credential SOURCE, like {@link wizardGroups}.
   */
  async wizardStates(
    source: TrackerWizardSourceInput,
    selection: TrackerSourceSelection,
  ): Promise<TrackerState[]> {
    return this.adapterForCredentials(this.credentialsFromSource(source)).listStates(selection);
  }

  /**
   * The provider's own priority and type vocabularies, backing the
   * priority/category mapping tables. Credential SOURCE, like
   * {@link wizardStates}: mapping management re-enters this step from an
   * already-authorized connection with no pasted key to offer.
   *
   * NO SELECTION ARGUMENT, unlike wizardStates: none of the three providers
   * scopes these lists to a container (Dart's are workspace-wide `/config`
   * lists; Linear's and Plane's are fixed scales), so asking for one would
   * invent a dependency the seam does not have.
   *
   * The seeded mappings are computed HERE, main-side, over the just-fetched
   * live options — never left for the wizard to re-derive, which would
   * duplicate priorityMapping.ts/categoryMapping.ts's seed tables client-side.
   */
  async wizardFieldOptions(source: TrackerWizardSourceInput): Promise<TrackerFieldOptions> {
    const credentials = this.credentialsFromSource(source);
    const options = await this.adapterForCredentials(credentials).listFieldOptions();
    return {
      ...options,
      defaultPriorityMapping: seedDefaultPriorityMapping(credentials.provider, options.priorities),
      defaultCategoryMapping: seedDefaultCategoryMapping(credentials.provider, options.categories),
    };
  }

  /**
   * Wizard Step 2 — every issue in the chosen source (no `since` bound: the
   * wizard's pickers and the Reconcile suggestions need the full set, not an
   * incremental slice). Credential SOURCE, like {@link wizardGroups}.
   */
  async wizardIssues(
    source: TrackerWizardSourceInput,
    selection: TrackerSourceSelection,
  ): Promise<TrackerIssue[]> {
    return this.adapterForCredentials(this.credentialsFromSource(source)).listIssues(selection);
  }

  // -------------------------------------------------------------------------
  // Reconcile
  // -------------------------------------------------------------------------

  /**
   * The wizard's Reconcile rows: the project's ACTIVE ideas + tasks, each with
   * a suggested issue match (or null).
   *
   * "Active" = not archived, not on a terminal stage (Done / Won't do), not a
   * retired (decomposed) idea, not an A/B experiment sandbox row, and not
   * already linked to a tracker issue — a row the user has nothing left to
   * decide about is noise in a six-step wizard.
   *
   * MATCH RULE (deliberately simple + deterministic, no fuzzy scoring library):
   * both titles are normalized (lowercased, every non-alphanumeric run collapsed
   * to a single space, trimmed), then a pair matches when EITHER
   *   - one normalized title CONTAINS the other, or
   *   - their word sets overlap by >= 75% (|A n B| / |A u B|).
   * The best-scoring issue wins; ties break on the lower externalId so the same
   * inputs always produce the same suggestion.
   */
  async reconcilePreview(
    projectId: number,
    issues: TrackerIssue[],
  ): Promise<TrackerReconcileItem[]> {
    const candidates = listReconcileCandidates(this.db, projectId);
    const normalizedIssues = issues.map((issue) => ({
      externalId: issue.externalId,
      normalized: normalizeTitle(issue.title),
    }));
    return candidates.map((row) => ({
      entityType: row.type,
      entityId: row.id,
      ref: row.ref,
      title: row.title,
      suggestedExternalId: suggestMatch(row.title, normalizedIssues),
    }));
  }

  // -------------------------------------------------------------------------
  // Connect / settings / disconnect
  // -------------------------------------------------------------------------

  /**
   * Persist a connection from the wizard's Review step and start syncing it.
   *
   * ORDER IS DELIBERATE:
   *   0. Probe the key live, and if this exact mapping is ALREADY connected,
   *      return its id and do nothing else — the multi-mapping wizard retries
   *      failed connects by re-submitting the whole set (see below).
   *   1. Then encrypt the key. The wizard validated it in Step 0,
   *      but the row's identity columns — and Plane's addressing slug — come
   *      from the LIVE identity, not from anything the renderer typed; and a
   *      safeStorage refusal must be known before anything is written.
   *   2. Persist the row + store the secret. This pair is the DURABLE ANCHOR:
   *      up to here nothing entity-visible has happened, so a failure — a
   *      constraint, a crash, an unusable keychain — leaves genuinely nothing
   *      behind and `connect` rejects with no half-built state.
   *      RE-CONNECT, NOT A SECOND CONNECTION: when a DISCONNECTED row already
   *      holds this workspace's identity, its id is REUSED and the row rewritten
   *      in place — see {@link findDisconnectedConnection} for the identity key
   *      and the note below for why minting a fresh one duplicates a backlog.
   *   3. THEN the reconcile decisions (discards, then links), FAIL-SOFT per row.
   *      Each row is an independent user decision, so a rejected archive (an
   *      active run on a task) or a colliding external id is logged and skipped:
   *      it must neither sink the connection the user just authorized nor stop
   *      the rows after it. Running these BEFORE the anchor is what used to make
   *      a rejection destructive — the earlier discards were already committed,
   *      and connect then failed with no connection to show for them.
   *   4. Kick the first pass fire-and-forget: the wizard closes on the mutation's
   *      return, and the first pass is a full network round-trip.
   *
   * THE KEY may be pasted (`credentials`) or borrowed from a connection the user
   * already authorized (`sourceConnectionId` — mapping management adding a second
   * group to an existing connection). Exactly one, resolved once here; from that
   * line on this method cannot tell which it was, so every behaviour below —
   * the live probe, the idempotent re-submit, the revival, claimPushTarget — is
   * byte-for-byte what a pasted key always did.
   */
  async connect(payload: TrackerConnectPayload): Promise<{ connectionId: string }> {
    const credentials = this.credentialsFromSource({
      credentials: payload.credentials,
      connectionId: payload.sourceConnectionId,
    });
    const identity = await this.adapterForCredentials(credentials).validateCredentials();

    // IDEMPOTENT RE-SUBMIT. The multi-mapping wizard calls connect once per
    // mapping, sequentially, and offers a retry when one of them fails — so the
    // retry re-runs the mappings that already SUCCEEDED. Without this, each
    // re-run would mint a second row for the same (project, source) pair: two
    // connections polling one scope, each importing the other's issues as new
    // ideas, and each pushing its own copy back.
    //
    // The match is the mapping's full identity — project, provider, workspace,
    // instance, and the FULL source scope (container + narrow + kind: every
    // Linear project group under one team shares the team's containerId, so a
    // container-only match would swallow the team's second mapping) — so it
    // recognizes only a row this same submit would have created. The reconcile
    // decisions are skipped, not re-run: the successful call applied them, and
    // re-applying would re-archive rows the user has since restored. What IS
    // re-applied is everything the re-submit legitimately carries fresh: the
    // just-validated key (a paused row's whole problem is a stale one — resume
    // it and kick a pass), and the push-target choice (the wizard recomputes it
    // from the live radio, so a retry after re-picking must land the new
    // choice; the early return used to drop it, leaving two armed siblings).
    const cipher = encryptTrackerSecret(credentials.apiKey);
    const incomingScope: StoredSourceScope = {
      containerId: payload.source.containerId,
      narrowId: payload.source.narrowId,
      narrowKind: payload.source.narrowKind,
    };
    const existing = listConnectionsByIdentity(
      this.db,
      credentials.provider,
      identity.workspaceId,
      credentials.baseUrl ?? null,
    ).find(
      (row) =>
        row.project_id === payload.projectId &&
        sourceScopeEquals(storedSourceScope(row), incomingScope),
    );
    if (existing !== undefined) {
      storeSecret(this.db, existing.id, cipher);
      if (payload.pushTarget === false) {
        updateConnectionSettings(this.db, existing.id, { push_target: 0 });
      } else {
        claimPushTarget(this.db, payload.projectId, credentials.provider, existing.id);
      }
      if (existing.status === 'paused') {
        updateConnectionSettings(this.db, existing.id, {
          status: 'active',
          workspace_name: identity.workspaceName,
          actor_label: identity.actorLabel,
        });
        void this.syncNow(existing.id).catch((err: unknown) => {
          this.logger?.error('[trackerSync] sync after a paused mapping was re-connected failed', {
            connectionId: existing.id,
            error: describeError(err),
          });
        });
      }
      this.emitTrackerChange(payload.projectId, existing.id, 'connection');
      return { connectionId: existing.id };
    }

    // The row the wizard just described, composed ONCE so the insert and the
    // re-connect path below cannot drift apart.
    const row: Omit<NewConnectionRow, 'id'> = {
      project_id: payload.projectId,
      provider: credentials.provider,
      status: 'active',
      workspace_id: identity.workspaceId,
      workspace_name: identity.workspaceName,
      actor_label: identity.actorLabel,
      base_url: credentials.baseUrl ?? null,
      // Written by storeSecret below, never inline — the plaintext-never-touches
      // -sqlite invariant lives in exactly one call site.
      secret_ciphertext: null,
      // The Step-1 choice PLUS its display label. The label is an extra key on
      // the same blob rather than a column of its own: parseSourceSelection
      // reads containerId/narrowId/narrowKind by name and ignores everything
      // else, so the two coexist without a migration.
      source_json: JSON.stringify({ ...payload.source, label: payload.sourceLabel }),
      selection_mode: payload.selectionMode,
      selection_json:
        payload.selectionJson === null ? null : JSON.stringify(payload.selectionJson),
      state_mapping_json: JSON.stringify(payload.stateMapping),
      status_sync_mode: payload.statusSyncMode,
      pull_mode: payload.pullMode,
      push_mode: payload.pushMode,
      // Omitted = the push target, which is what a single-mapping connect (every
      // pre-rev-4 one) means. Only the Map step's sibling mappings send false.
      push_target: payload.pushTarget === false ? 0 : 1,
      // Omitted = 'off' (the column default) — a pre-Phase-6 caller that never
      // offered the control.
      content_sync_mode: payload.contentSyncMode ?? 'off',
      archive_sync_mode: payload.archiveSyncMode ?? 'off',
      // Omitted = the seed only, no user override — same reasoning.
      priority_mapping_json:
        payload.priorityMapping !== undefined ? JSON.stringify(payload.priorityMapping) : '{}',
      category_mapping_json:
        payload.categoryMapping !== undefined ? JSON.stringify(payload.categoryMapping) : '{}',
      mirror_subissues: payload.mirrorSubissues ? 1 : 0,
      conflict_mode: payload.conflictMode,
      cursor_updated_at: null,
      cursor_external_id: null,
      last_sync_at: null,
      last_sync_log_json: null,
    };

    // RE-CONNECT vs. a genuinely new connection. `disconnect` retires the row
    // but KEEPS its links — they are the history of what synced — and a link is
    // scoped to a `connection_id`. So minting a fresh id for a workspace this
    // project already syncs would strand every one of those links on the dead
    // row, and the first pass would find each remote issue unlinked and import
    // it as a NEW idea: a routine credential rotation (disconnect, paste the new
    // key, connect) silently duplicating the entire synced backlog.
    //
    // Reviving instead is what makes the retained links do their job. The row is
    // rewritten from this wizard run — credentials, source, selection, mapping,
    // flags, status — with the CURSOR reset to null, and that reset is
    // load-bearing: the first pass re-fetches from the beginning, so every issue
    // meets its existing link and merges against its own baseline instead of
    // importing. Identity is (project_id, provider, workspace_id, base_url); a
    // different workspace, a different INSTANCE of the same workspace slug, or
    // one whose identity was never recorded, still mints.
    //
    // A different SOURCE SCOPE is a different MAPPING under multi-project
    // mapping and mints its own row, which is why the full scope triple joins
    // the revival key — container alone would let a Linear team's second
    // project group revive (and repoint) its sibling's retired row. The
    // deliberate exceptions are store.revivableSourceMatch's WIDENING arms —
    // a whole-container scope claims any narrow of that container, a Dart
    // SPACE scope claims its member boards — because a superset scope cannot
    // strand a retained link, and pre-rev-4 rows (board- or narrow-scoped)
    // would otherwise re-import their whole backlog as duplicates.
    const revivable = findDisconnectedConnection(
      this.db,
      payload.projectId,
      credentials.provider,
      identity.workspaceId,
      credentials.baseUrl ?? null,
      incomingScope,
    );
    const connectionId = revivable?.id ?? `trk_${randomUUID()}`;
    if (revivable === null) insertConnection(this.db, { id: connectionId, ...row });
    else reactivateConnection(this.db, connectionId, row);
    storeSecret(this.db, connectionId, cipher);
    // Enforce the one-pusher-per-(project, provider) invariant across WIZARD
    // RUNS: a later run mapping a second group into an already-mapped project
    // arrives here with pushTarget true (its own run's cluster default) while
    // the earlier row is still armed — the newest choice wins and the sibling
    // is demoted, else one new idea would file one remote issue per armed row.
    if (payload.pushTarget !== false) {
      claimPushTarget(this.db, payload.projectId, credentials.provider, connectionId);
    }

    // OWNERSHIP FIRST. A reconcile decision names an entity by bare id, and the
    // payload is a wizard submission that can be minutes stale — composed
    // against one project, submitted after the user switched to another. Neither
    // the archive below nor `upsertLink` checks project membership on its own,
    // so an id from project A applied under a project-B connection would
    // silently archive A's idea, or hang a live link (and therefore inbound
    // mutations, and write-back) off an entity that is not in this connection's
    // project at all.
    //
    // Only ACTIONABLE rows are checked: a 'keep' decides to do nothing, and
    // reporting a no-op as skipped would be noise.
    const skippedRefs: string[] = [];
    const decisions = payload.reconcile.filter((decision) => {
      if (decision.action === 'keep') return false;
      if (entityBelongsToProject(this.db, decision.entityType, decision.entityId, payload.projectId)) {
        return true;
      }
      skippedRefs.push(`${decision.entityType} ${decision.entityId}`);
      return false;
    });
    if (skippedRefs.length > 0) {
      this.logger?.error('[trackerSync] reconcile decisions skipped — entity is not in this project', {
        connectionId,
        projectId: payload.projectId,
        entities: skippedRefs,
      });
      this.persistLog(
        connectionId,
        [
          {
            marker: '⚠',
            line: `${skippedRefs.length} reconcile ${
              skippedRefs.length === 1 ? 'row' : 'rows'
            } skipped · not in this project`,
          },
        ],
        { stampSyncedAt: false },
      );
    }

    // Past the anchor: every reconcile row from here is applied on its own, and
    // a failure is logged and skipped rather than thrown.
    for (const decision of decisions) {
      if (decision.action !== 'discard') continue;
      try {
        await this.router.applyChange(payload.projectId, {
          actor: 'user',
          entityType: decision.entityType,
          taskId: decision.entityId,
          archived: true,
        });
      } catch (err) {
        this.logger?.error('[trackerSync] reconcile discard failed', {
          connectionId,
          entityId: decision.entityId,
          error: describeError(err),
        });
      }
    }

    for (const decision of decisions) {
      if (decision.action !== 'link') continue;
      const externalId = decision.linkExternalId;
      if (externalId === undefined || externalId.length === 0) continue;
      try {
        upsertLink(this.db, {
          connection_id: connectionId,
          entity_type: decision.entityType,
          entity_id: decision.entityId,
          provider: credentials.provider,
          external_id: externalId,
          // BASELINE LEFT NULL on purpose: we hold no remote snapshot here, and
          // inbound's first pass ADOPTS the issue's current snapshot for a
          // baseline-less link and applies nothing (applyIssue) — the least
          // destructive way to become mergeable from the next change on.
          // The ref chip fields DO land now: the wizard carries the issue's
          // identifier + url on the decision, since nothing back-fills them later.
          external_identifier: decision.linkIdentifier ?? null,
          external_url: decision.linkUrl ?? null,
          baseline_json: null,
        });
      } catch (err) {
        this.logger?.error('[trackerSync] reconcile link failed', {
          connectionId,
          entityId: decision.entityId,
          error: describeError(err),
        });
      }
    }

    this.emitTrackerChange(payload.projectId, connectionId, 'connection');

    void this.syncNow(connectionId).catch((err: unknown) => {
      this.logger?.error('[trackerSync] initial sync after connect failed', {
        connectionId,
        error: describeError(err),
      });
    });

    return { connectionId };
  }

  /**
   * ROTATE a live connection's API key, in place. The reconnect path for the
   * one thing `connect` cannot express: the key changed, nothing else did.
   *
   * WHY NOT JUST RE-RUN THE WIZARD. `connect` only revives a DISCONNECTED row
   * (see {@link findDisconnectedConnection}); against an active or paused one it
   * mints a SECOND connection, stranding every link on the first and re-importing
   * the whole synced backlog as fresh ideas. A paused connection — which is
   * exactly what a revoked key produces — therefore had no non-destructive way
   * back, short of disconnecting first and remembering to.
   *
   * ORDER, and what each step buys:
   *   1. PROBE the new key live. It is the only way to learn what the key
   *      actually authorizes, and it must happen before anything is stored.
   *   2. CHECK THE IDENTITY against the row's own workspace
   *      ({@link connectionMatchesIdentity} — the same test the re-connect
   *      lookup applies, from the other end). A key for a DIFFERENT workspace is
   *      refused: storing it would leave every retained link pointing at
   *      external ids that belong to somebody else's workspace, so write-back
   *      would target strangers' issues and the deletion sweep would read their
   *      absence as deletions and archive live local entities. That workspace
   *      wants its own connection, not this one's history.
   *      (On Plane the check is a formality — its `validateCredentials` reports
   *      back the slug it was GIVEN — but the probe it makes is workspace-scoped
   *      and 403s/404s a key that cannot see the slug, which enforces the same
   *      thing one layer down.)
   *   3. STORE encrypted, exactly as connect does; the plaintext never reaches
   *      sqlite and never returns to the renderer (the result is the identity,
   *      which carries no key material).
   *   4. RESUME: status back to 'active', which is what un-gates the poll loop
   *      and the drain — including every row an auth failure HELD unsettled
   *      (outboxWorker.pauseConnection), which now replays in order.
   *   5. Kick a pass fire-and-forget, like connect, so the user sees it work.
   *
   * Steps 3-5 run for EVERY live row sharing this key's (provider, workspace,
   * instance) — the sibling mappings a multi-project connect minted — so one
   * paste resumes all of them; see the fan-out note at the store call.
   *
   * @throws {TrackerConnectionNotFoundError} unknown connection id.
   * @throws {TrackerIdentityMismatchError} the key authorizes another workspace.
   */
  async updateCredentials(connectionId: string, apiKey: string): Promise<TrackerWorkspaceIdentity> {
    const connection = getConnection(this.db, connectionId);
    if (connection === null) throw new TrackerConnectionNotFoundError(connectionId);

    const identity = await this.adapterForCredentials({
      provider: connection.provider,
      apiKey,
      // The connection's OWN addressing, not the renderer's: this call rotates a
      // key, it does not re-point a connection at a different instance.
      baseUrl: connection.base_url ?? undefined,
      workspaceSlug: connection.workspace_id ?? undefined,
    }).validateCredentials();

    if (!connectionMatchesIdentity(connection, identity.workspaceId, connection.base_url)) {
      throw new TrackerIdentityMismatchError(connection.workspace_id, identity.workspaceId);
    }

    const cipher = encryptTrackerSecret(apiKey);
    // FAN OUT ACROSS THE SIBLING MAPPINGS. Multi-project mapping mints one row
    // per (tracker group -> cyboflow project) pair, each holding its OWN copy of
    // the same encrypted key — so a rotation applied to the named row alone
    // would leave every sibling paused on a key that no longer works, with the
    // connected view offering no way to fix them but re-pasting the key once per
    // mapping. The identity probe above already proved this key for the shared
    // (provider, workspace, instance); each row gets exactly the treatment the
    // single-row path always gave it.
    //
    // The NAMED row leads the list unconditionally, rather than being taken from
    // the lookup: `listConnectionsByIdentity` skips disconnected rows (a
    // rotation must not silently re-arm a connection someone retired), and the
    // caller named this one explicitly.
    const siblings = listConnectionsByIdentity(
      this.db,
      connection.provider,
      identity.workspaceId,
      connection.base_url,
    );
    const rotating = [connection, ...siblings.filter((row) => row.id !== connection.id)];
    for (const sibling of rotating) {
      storeSecret(this.db, sibling.id, cipher);
      updateConnectionSettings(this.db, sibling.id, {
        status: 'active',
        // The authorizing user can legitimately change with the key; the
        // workspace cannot (step 2 just proved it).
        workspace_name: identity.workspaceName,
        actor_label: identity.actorLabel,
      });
      this.emitTrackerChange(sibling.project_id, sibling.id, 'connection');

      void this.syncNow(sibling.id).catch((err: unknown) => {
        this.logger?.error('[trackerSync] sync after a credential rotation failed', {
          connectionId: sibling.id,
          error: describeError(err),
        });
      });
    }

    return identity;
  }

  /** The project's connected-view cards (disconnected connections are not listed). */
  async connections(projectId: number): Promise<TrackerConnectionSummary[]> {
    return listConnections(this.db, projectId).map((row) => this.summarizeConnection(row));
  }

  /**
   * Every LIVE mapping sharing this connection's tracker identity — `(provider,
   * workspace_id, base_url)` — ACROSS PROJECTS, which is what makes it a
   * different question from {@link connections}.
   *
   * The management view's model. A rev-4 wizard run mints one sibling row per
   * (tracker group -> cyboflow project) pair, all on one authorization, and the
   * user's mental object is that authorization, not any one row: "which groups
   * am I syncing, into which projects, and which one pushes?" A per-project
   * listing can never answer it, because the siblings are in OTHER projects by
   * construction.
   *
   * The NAMED row is always in the result, even retired: `listConnectionsByIdentity`
   * deliberately skips disconnected rows (a rotation must not re-arm one), but a
   * user who navigated to this connection is owed its own card back. It leads the
   * list in that case; otherwise the store's own oldest-first order stands.
   *
   * A row whose `workspace_id` was never recorded has no identity to fan out on
   * (see {@link connectionMatchesIdentity}: an identity we never learned cannot be
   * claimed BY identity), so it is a mapping set of exactly itself.
   *
   * @throws {TrackerConnectionNotFoundError} unknown connection id. A DISCONNECTED
   *   one is allowed through — it is a real row with a real mapping set.
   */
  async mappings(connectionId: string): Promise<TrackerConnectionSummary[]> {
    const row = getConnection(this.db, connectionId);
    if (row === null) throw new TrackerConnectionNotFoundError(connectionId);
    if (row.workspace_id === null) return [this.summarizeConnection(row)];

    const siblings = listConnectionsByIdentity(
      this.db,
      row.provider,
      row.workspace_id,
      row.base_url,
    ).map((sibling) => this.summarizeConnection(sibling));
    return row.status === 'disconnected'
      ? [this.summarizeConnection(row), ...siblings]
      : siblings;
  }

  /**
   * ARM this mapping as its (project, provider) pair's one push target, demoting
   * whichever sibling held it.
   *
   * The management view's edit for the choice the wizard's Map step makes once
   * and then has no way to revisit: which of N mappings into one project files a
   * locally-created idea as a new tracker issue. Enforced through the same
   * {@link claimPushTarget} statement connect uses, so the "at most one pusher
   * per (project, provider)" invariant has exactly one implementation — an
   * `updateSettings`-style per-row write could leave two armed rows, and one new
   * idea would file two remote issues.
   *
   * A DISCONNECTED row is refused: it has no key and syncs nothing, so arming it
   * would leave the project with no live pusher at all.
   *
   * A PAUSED row is refused only while an ACTIVE sibling is carrying the role:
   * the paused row enqueues nothing (write-back skips on status before
   * push_target) and a locally-created idea is pushed exactly once, at creation
   * — never back-filled — so the swap would drop every idea filed until the row
   * reconnects. With NO active sibling (a key expiry paused the whole pair)
   * the arm is allowed as pre-designation: it costs nothing now and self-heals
   * the moment a fresh key lands.
   *
   * @throws {TrackerConnectionNotFoundError} unknown or retired connection id.
   * @throws {TrackerConnectionPausedError} paused row while an active sibling pushes.
   */
  async setPushTarget(connectionId: string): Promise<void> {
    const row = getConnection(this.db, connectionId);
    if (row === null || row.status === 'disconnected') {
      throw new TrackerConnectionNotFoundError(connectionId);
    }
    if (row.status !== 'active') {
      const live = listConnectionsForProviderProject(this.db, row.project_id, row.provider);
      if (live.some((sibling) => sibling.id !== row.id && sibling.status === 'active')) {
        throw new TrackerConnectionPausedError(connectionId);
      }
    }
    claimPushTarget(this.db, row.project_id, row.provider, row.id);
    this.emitTrackerChange(row.project_id, row.id, 'connection');
  }

  /** Project one connection row onto its renderer-visible summary (never the key). */
  private summarizeConnection(row: TrackerConnectionRow): TrackerConnectionSummary {
    return {
      id: row.id,
      projectId: row.project_id,
      provider: row.provider,
      status: row.status,
      workspaceName: row.workspace_name ?? '',
      actorLabel: row.actor_label ?? '',
      baseUrl: row.base_url,
      sourceLabel: readSourceLabel(row),
      sourceScope: readSourceScope(row),
      selectionMode: row.selection_mode,
      statusSyncMode: row.status_sync_mode,
      pullMode: row.pull_mode,
      pushMode: row.push_mode,
      contentSyncMode: row.content_sync_mode,
      archiveSyncMode: row.archive_sync_mode,
      mirrorSubissues: row.mirror_subissues === 1,
      conflictMode: row.conflict_mode,
      pushTarget: row.push_target !== 0,
      // resolveEffectiveMapping over an EMPTY state list is exactly "the stored
      // overlay, filtered to valid targets" — the defensive parse we want, with
      // no network round-trip for the provider's live state list.
      stateMapping: resolveEffectiveMapping([], row.state_mapping_json),
      // No live options round-trip for a summary read either — same
      // no-network-call reasoning as stateMapping above; the seed's static
      // canonical tokens (or, for Dart, whatever the overlay itself names)
      // are what a summary can answer without probing the provider.
      priorityMapping: resolveEffectivePriorityMapping(row.provider, null, row.priority_mapping_json),
      categoryMapping: resolveEffectiveCategoryMapping(row.provider, null, row.category_mapping_json),
      lastSyncAt: row.last_sync_at,
      lastSyncLog: parseLogEntries(row.last_sync_log_json),
      linkedCount: listLinks(this.db, row.id, { activeOnly: true }).length,
      openConflictCount: listOpenConflicts(this.db, row.id).length,
    };
  }

  /**
   * Patch the connected view's editable settings. Only the keys present on
   * `patch` are written (mirroring the store's own patch semantics); an unknown
   * connection id is an idempotent no-op.
   *
   * TURNING A CONTENT DIRECTION OFF ALSO CLEARS ITS QUEUE — see
   * {@link cancelPendingKinds}. Flipping `auto`/`manual` → `'off'` while rows
   * are still pending would STRAND them: `'off'` is enforced at the claim, so
   * nothing (not even "Sync now") would ever drain them, and the kind-agnostic
   * inbound blocker would halt the pass at those issues forever. The sweep runs
   * after the write so it can never settle rows for a mode the write then
   * failed to apply, and only for the direction the user actually turned off.
   */
  async updateSettings(connectionId: string, patch: TrackerSettingsPatch): Promise<void> {
    const connection = getConnection(this.db, connectionId);
    if (connection === null) return;
    updateConnectionSettings(this.db, connectionId, {
      ...(patch.statusSyncMode !== undefined ? { status_sync_mode: patch.statusSyncMode } : {}),
      ...(patch.pullMode !== undefined ? { pull_mode: patch.pullMode } : {}),
      ...(patch.pushMode !== undefined ? { push_mode: patch.pushMode } : {}),
      ...(patch.contentSyncMode !== undefined ? { content_sync_mode: patch.contentSyncMode } : {}),
      ...(patch.archiveSyncMode !== undefined ? { archive_sync_mode: patch.archiveSyncMode } : {}),
      ...(patch.priorityMapping !== undefined
        ? { priority_mapping_json: JSON.stringify(patch.priorityMapping) }
        : {}),
      ...(patch.categoryMapping !== undefined
        ? { category_mapping_json: JSON.stringify(patch.categoryMapping) }
        : {}),
      ...(patch.mirrorSubissues !== undefined
        ? { mirror_subissues: patch.mirrorSubissues ? 1 : 0 }
        : {}),
      ...(patch.conflictMode !== undefined ? { conflict_mode: patch.conflictMode } : {}),
      ...(patch.stateMapping !== undefined
        ? { state_mapping_json: JSON.stringify(patch.stateMapping) }
        : {}),
      ...(patch.selectionMode !== undefined ? { selection_mode: patch.selectionMode } : {}),
      ...(patch.selectionJson !== undefined
        ? {
            selection_json:
              patch.selectionJson === null ? null : JSON.stringify(patch.selectionJson),
          }
        : {}),
    });

    if (patch.contentSyncMode === 'off') {
      cancelPendingKinds(
        this.db,
        connectionId,
        CONTENT_OUTBOX_KINDS,
        'cancelled — content sync was turned off for this connection',
      );
    }
    if (patch.archiveSyncMode === 'off') {
      cancelPendingKinds(
        this.db,
        connectionId,
        ARCHIVE_OUTBOX_KINDS,
        'cancelled — archive sync was turned off for this connection',
      );
    }

    this.emitTrackerChange(connection.project_id, connectionId, 'connection');
  }

  /**
   * Retire a connection: `status = 'disconnected'` and the stored ciphertext
   * cleared. The row and its LINKS stay — they are the history of what synced —
   * but nothing can sync again without a fresh key.
   *
   * The armed write-back drain is disarmed as part of this: it would otherwise
   * fire two seconds later, find no stored key, and PAUSE the connection —
   * flipping the row straight back off 'disconnected'.
   *
   * STOPPING AN IN-FLIGHT PASS. Disconnect does not cancel a running pass, it
   * DEFUSES it — which is why `status` is written FIRST, before the secret and
   * the timer. That column is what every phase boundary in {@link runPass}
   * re-reads, so an adapter call already in flight finishes (nothing can un-send
   * an HTTP request) but no later phase starts, and the pass persists neither
   * `last_sync_at` nor its log. Cancelling mid-phase instead would buy nothing:
   * what an abandoned pass leaves behind is exactly the crash case boot recovery
   * already reconciles.
   */
  async disconnect(connectionId: string): Promise<void> {
    const connection = getConnection(this.db, connectionId);
    if (connection === null) return;
    // push_target cleared with the retirement so a later revival cannot
    // resurrect a stale claim; the survivor promotion below is what keeps the
    // (project, provider) pair pushing in the meantime.
    updateConnectionSettings(this.db, connectionId, { status: 'disconnected', push_target: 0 });
    const timer = this.drainTimers.get(connectionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.drainTimers.delete(connectionId);
    }
    clearSecret(this.db, connectionId);

    // Retiring the ARMED mapping must not leave its (project, provider) pair
    // with live rows and no pusher: writeBack.handleIdeaPush skips every
    // push_target = 0 row, so the project would silently stop filing new ideas
    // — no error, no repair (the boot reconciliation only fixes DUPLICATE
    // claims). The oldest surviving live sibling inherits the flag, the same
    // tie-break the boot repair uses; with no survivors this is a no-op.
    if (connection.push_target === 1) {
      const survivors = listConnectionsForProviderProject(
        this.db,
        connection.project_id,
        connection.provider,
      );
      if (survivors.length > 0) {
        claimPushTarget(this.db, connection.project_id, connection.provider, survivors[0].id);
        this.emitTrackerChange(connection.project_id, survivors[0].id, 'connection');
      }
    }

    this.emitTrackerChange(connection.project_id, connectionId, 'connection');
  }

  // -------------------------------------------------------------------------
  // Conflicts
  // -------------------------------------------------------------------------

  /**
   * The connection's OPEN conflicts, each carrying the linked entity's ref +
   * title where they can still be resolved (a conflict outlives its link — the
   * `link_id` FK is ON DELETE SET NULL — and can outlive the entity too).
   */
  async conflicts(connectionId: string): Promise<TrackerConflictSummary[]> {
    const links = new Map(listLinks(this.db, connectionId).map((link) => [link.id, link]));
    return listOpenConflicts(this.db, connectionId).map((row) => {
      const link = row.link_id === null ? undefined : links.get(row.link_id);
      const entity =
        link === undefined ? null : readEntityIdentity(this.db, link.entity_type, link.entity_id);
      return {
        id: row.id,
        connectionId: row.connection_id,
        kind: row.kind,
        field: row.field,
        localValue: row.local_value,
        remoteValue: row.remote_value,
        entityRef: entity?.ref ?? null,
        entityTitle: entity?.title ?? null,
        createdAt: row.created_at,
      };
    });
  }

  /**
   * Resolve ONE open conflict the user's way. An unknown, already-resolved, or
   * orphan-connection conflict id is an idempotent no-op (the list the user
   * clicked may be a few seconds stale).
   *
   * Every branch ends with a resolved row, so the next inbound pass stops
   * skipping the item (hasOpenConflictForLink) and it starts flowing again.
   */
  async resolveConflictChoice(
    conflictId: number,
    choice: TrackerConflictChoice,
  ): Promise<void> {
    const conflict = getConflict(this.db, conflictId);
    if (conflict === null || conflict.state !== 'open') return;
    const connection = getConnection(this.db, conflict.connection_id);
    if (connection === null) return;
    const link = conflict.link_id === null ? null : getLinkById(this.db, conflict.link_id);

    if (conflict.kind === 'remote_deleted') {
      await this.resolveRemoteDeleted(connection, conflict, link, choice);
    } else {
      await this.resolveFieldConflict(connection, conflict, link, choice);
    }
    this.emitTrackerChange(connection.project_id, connection.id, 'conflicts');
  }

  /**
   * The remote issue is gone. 'remote' accepts that: archive the entity IN
   * PLACE (we never hard-delete locally) and orphan the link. 'local' keeps the
   * entity and STILL orphans the link — there is no issue left to sync it
   * against, and an un-orphaned link would have the deletion sweep re-open the
   * same conflict on its next run.
   */
  private async resolveRemoteDeleted(
    connection: TrackerConnectionRow,
    conflict: TrackerConflictRow,
    link: EntityExternalLinkRow | null,
    choice: TrackerConflictChoice,
  ): Promise<void> {
    if (choice === 'remote' && link !== null) {
      await this.router.applyChange(connection.project_id, {
        actor: connection.provider,
        entityType: link.entity_type,
        taskId: link.entity_id,
        archived: true,
      });
    }
    if (link !== null) markOrphaned(this.db, link.id);
    resolveConflict(this.db, conflict.id, choice === 'remote' ? 'manual-remote' : 'manual-local');
  }

  /**
   * A three-way field conflict the Manual mode parked. 'remote' applies the
   * stored `remote_value` to the entity; 'local' leaves the entity alone and
   * queues the write-back that makes the TRACKER converge onto our value — a
   * state write for a stage conflict, a content write for the other four
   * (title, description, priority, category). Either way the link's BASELINE
   * has to move, or the ruling does not stick — see
   * {@link acceptLocalFieldValue}.
   */
  private async resolveFieldConflict(
    connection: TrackerConnectionRow,
    conflict: TrackerConflictRow,
    link: EntityExternalLinkRow | null,
    choice: TrackerConflictChoice,
  ): Promise<void> {
    if (choice === 'remote') {
      if (link !== null) await this.applyRemoteFieldValue(connection, conflict, link);
      resolveConflict(this.db, conflict.id, 'manual-remote');
      return;
    }
    if (link !== null) this.acceptLocalFieldValue(connection, conflict, link);
    resolveConflict(this.db, conflict.id, 'manual-local');
  }

  /**
   * Accept the LOCAL side of a field conflict. The entity already HOLDS the
   * value being kept, so all the work is in the baseline — and skipping it is
   * what made this ruling not stick: the baseline still held the PRE-conflict
   * snapshot, so the next inbound pass saw both sides changed and re-opened the
   * very conflict the user had just settled, forever.
   *
   * Advancing the conflicting field to the REMOTE's value ends that loop. The
   * baseline means "where the remote stood when we last looked", and the remote
   * genuinely IS at that value, so the stamp is TRUE: the next pass reads
   * remote-unchanged + local-changed and lets the local value win silently,
   * while a LATER genuine remote edit still diverges from the stamp and
   * conflicts again — which is the whole point of keeping a baseline.
   *
   * STAMP BEFORE ENQUEUE, on every arm. The stamp is what the outbound content
   * trigger diffs against, and the enqueue helpers dedupe against the rows that
   * already exist — so stamping first means the ruling's own row is composed
   * against a baseline that already tells the truth, and an entity event
   * arriving in between cannot queue a second row for the same edit. It also
   * mirrors {@link applyRemoteFieldValue}'s ordering, where the reason is
   * sharper still (writeBack's listener runs INLINE inside applyChange).
   */
  private acceptLocalFieldValue(
    connection: TrackerConnectionRow,
    conflict: TrackerConflictRow,
    link: EntityExternalLinkRow,
  ): void {
    if (conflict.field === 'stage') {
      // `remote_value` here is the MAPPED board stage, so the raw state comes
      // off the payload the conflict recorded (inboundSync's
      // TrackerConflictPayload). A row written without it — a pre-existing one
      // — simply keeps the old recur-forever shape rather than stamping a state
      // id we would have to invent. The convergence write-back below is a
      // two-way-only affordance, so on a ONE-WAY connection this stamp is the
      // only thing standing between the user and the same prompt every pass.
      const remote = readConflictRemoteState(conflict.payload_json);
      if (remote !== null) {
        this.stampBaseline(link, {
          stateId: remote.stateId,
          // Mirrors inboundSync's stampRemoteGroup: a null group CLEARS the key
          // rather than leaving a stale one that would suppress a later, genuine
          // local write-back.
          lastWrittenGroup: remote.group ?? undefined,
        });
      }
      this.enqueueStageWriteBack(connection, link, conflict.local_value);
      return;
    }

    if (conflict.field === 'title') {
      // A title conflict always carries the remote's title; a null would only
      // corrupt the baseline into unparseability, so it is left alone.
      if (conflict.remote_value !== null) this.stampBaseline(link, { title: conflict.remote_value });
      this.enqueueContentWriteBack(connection, link);
      return;
    }

    if (conflict.field === 'description') {
      // null is a legitimate remote description ("this issue has no body"), so
      // it is stamped as-is rather than guarded away.
      this.stampBaseline(link, { description: conflict.remote_value });
      this.enqueueContentWriteBack(connection, link);
      return;
    }

    // MAPPED fields (priority / category). `remote_value` is the PROVIDER-RAW
    // token, which is exactly what the baseline stores (invariant 2), so the
    // stamp is a straight copy — no mapping is needed on this path at all. A
    // null is legitimate (Dart spells a cleared priority as no value) and is
    // stamped as-is, like a null description.
    if (conflict.field === 'priority') this.stampBaseline(link, { priority: conflict.remote_value });
    else if (conflict.field === 'category') {
      this.stampBaseline(link, { category: conflict.remote_value });
    } else {
      // An unrecognized field (a row from a future build, or hand-edited): the
      // conflict still resolves, but nothing is stamped and nothing is queued —
      // guessing which field to write would be worse than doing nothing.
      return;
    }
    this.enqueueContentWriteBack(connection, link);
  }

  /** Write one conflict's `remote_value` onto the linked entity, per field. */
  private async applyRemoteFieldValue(
    connection: TrackerConnectionRow,
    conflict: TrackerConflictRow,
    link: EntityExternalLinkRow,
  ): Promise<void> {
    const remote = conflict.remote_value;
    // actor = the provider: this IS the tracker's value landing locally, and the
    // entity_events row should read that way whoever clicked the button.
    const base = {
      actor: connection.provider,
      entityType: link.entity_type,
      taskId: link.entity_id,
    } as const;

    if (conflict.field === 'stage') {
      // `remote_value` on a stage conflict is the MAPPED board stage id, not the
      // tracker's state id — so the raw state comes off the payload the conflict
      // recorded (inboundSync's TrackerConflictPayload).
      //
      // STAMP BEFORE APPLY, for the reason inboundSync.stampRemoteGroup
      // documents: writeBack's listener runs INLINE on TaskChangeRouter's
      // post-commit emit, so a stage move to Done/Won't do that finds no
      // matching `lastWrittenGroup` on the link reads as a LOCAL change and
      // enqueues an update_state. The worker then writes the FIRST state of that
      // group — which is not necessarily the state the user just accepted (a
      // workspace with two completed states loses the one they picked). Stamping
      // first makes the listener recognize the move as already-remote and queue
      // nothing. A stamp that lands on a failed applyChange is still TRUE: it
      // says only where the remote stands.
      //
      // A legacy row that carries no state id cannot be stamped without
      // inventing one, so it keeps the previous behavior: the next pass's
      // three-way merge sees the entity agreeing with the remote and refreshes
      // the whole baseline itself.
      if (remote === null) return;
      const remoteState = readConflictRemoteState(conflict.payload_json);
      if (remoteState !== null) {
        this.stampBaseline(link, {
          stateId: remoteState.stateId,
          // Mirrors inboundSync's stampRemoteGroup: a null group CLEARS the key
          // rather than leaving a stale one that would suppress a later, genuine
          // local write-back.
          lastWrittenGroup: remoteState.group ?? undefined,
        });
      }
      await this.router.applyChange(connection.project_id, { ...base, stageId: remote });
      return;
    }

    if (conflict.field === 'title') {
      if (remote === null) return;
      await this.router.applyChange(connection.project_id, { ...base, fields: { title: remote } });
      this.stampBaseline(link, { title: remote });
      return;
    }

    if (conflict.field === 'description') {
      // Only the remote-owned HALF of the body is replaced — the cyboflow-owned
      // provenance footer is split off and re-joined, exactly as an inbound
      // description apply would do it.
      const entity = readEntityIdentity(this.db, link.entity_type, link.entity_id);
      const { footer } = splitBody(entity?.body ?? null);
      await this.router.applyChange(connection.project_id, {
        ...base,
        fields: { body: joinBody(remote, footer) },
      });
      this.stampBaseline(link, { description: remote });
      return;
    }

    // MAPPED fields. The local value to write is NOT derived here: the pass that
    // detected the conflict resolved it under the live mapping and recorded it
    // on the payload, so this applies the pass's own answer rather than
    // rebuilding a mapping (which would need the provider's live option list —
    // a network call from a UI click, and one that could answer differently
    // now). A row that carries none — written before this key existed, or
    // hand-edited — applies nothing rather than guessing a level; the conflict
    // still resolves and the next pass re-derives from the baseline.
    const remoteLocal = readConflictRemoteLocal(conflict.payload_json);

    if (conflict.field === 'priority') {
      if (!isPriority(remoteLocal)) return;
      // STAMP BEFORE APPLY, for the reason the stage arm above documents:
      // writeBack's listener runs INLINE on TaskChangeRouter's post-commit emit,
      // and from Phase 5 a content write-back triggers on the entity diverging
      // from its baseline. A priority write that lands while the baseline still
      // says otherwise reads as a LOCAL change and queues an echo of the value
      // we just took FROM the tracker. A stamp left behind by a failed
      // applyChange is still TRUE: it says only where the remote stands.
      this.stampBaseline(link, { priority: remote });
      await this.router.applyChange(connection.project_id, {
        ...base,
        fields: { priority: remoteLocal },
      });
      return;
    }

    if (conflict.field === 'category') {
      if (!isCategory(remoteLocal)) return;
      this.stampBaseline(link, { category: remote });
      await this.router.applyChange(connection.project_id, {
        ...base,
        fields: { category: remoteLocal },
      });
    }
  }

  /**
   * Merge `patch` into a link's `baseline_json` without disturbing the other
   * half's keys (the outbound worker stamps its own `lastWrittenGroup` /
   * `lastWrittenAt` onto the same blob). A patch value of `undefined` REMOVES
   * its key — JSON.stringify drops undefined members — which is how the stage
   * branch clears a `lastWrittenGroup` the remote has moved out of.
   */
  private stampBaseline(link: EntityExternalLinkRow, patch: Record<string, unknown>): void {
    updateBaseline(
      this.db,
      link.id,
      JSON.stringify({ ...parseJsonObject(link.baseline_json), ...patch }),
    );
  }

  /**
   * Queue the state write that makes the tracker converge onto our stage after
   * the user accepts the LOCAL side of a stage conflict. Mirrors writeBack's own
   * enqueue guard (same-intent unresolved rows dedupe), and no-ops when the
   * stage has no outbound meaning — Idea and Ready for development deliberately
   * write nothing.
   *
   * `status_sync_mode` is NOT consulted, for the reason writeBack's header
   * gives: an enqueue is durable INTENT and the drain is where a held direction
   * waits. The user has just ruled that their stage is the truth; a manual
   * status mode says when that ruling reaches the tracker, not whether.
   */
  private enqueueStageWriteBack(
    connection: TrackerConnectionRow,
    link: EntityExternalLinkRow,
    stageId: string | null,
  ): void {
    if (stageId === null) return;
    const group = writeBackGroupForStage(stageId, resolveStageIds(this.db, connection.project_id));
    if (group === null) return;
    this.enqueueGroupWriteBack(connection, link, group);
  }

  /**
   * Queue ONE state write for a link's issue, deduped against the connection's
   * unresolved queue exactly the way writeBack.ts's own enqueue does — `kind` is
   * deliberately NOT part of the key, because update_state and close_parent move
   * the same issue to the same group. Returns true when a row was written.
   */
  private enqueueGroupWriteBack(
    connection: TrackerConnectionRow,
    link: EntityExternalLinkRow,
    group: WriteBackGroup,
  ): boolean {
    const duplicate = listUnresolvedOutbox(this.db, connection.id).some(
      (row) =>
        row.external_id === link.external_id &&
        (row.kind === 'update_state' || row.kind === 'close_parent') &&
        readDesiredGroup(row.payload_json) === group,
    );
    if (duplicate) return false;
    const payload: UpdateStatePayload = { desiredGroup: group };
    const enqueued = enqueueOutbox(this.db, {
      connection_id: connection.id,
      kind: 'update_state',
      entity_type: link.entity_type,
      entity_id: link.entity_id,
      external_id: link.external_id,
      payload_json: JSON.stringify(payload),
    });
    // Same reasoning as writeBack's own enqueue: this row is now the truth
    // about the issue's state, so anything still queued for it would regress the
    // tracker if a backoff let it drain last.
    supersedeQueuedStateWrites(this.db, connection.id, link.external_id, enqueued.id);
    return true;
  }

  /**
   * The remote write a "cancel it in the tracker" ruling turns into — see
   * {@link dropLink} for the choice between the two and why the mode only gates
   * the `'off'` end.
   */
  private enqueueRemovalWriteBack(
    connection: TrackerConnectionRow,
    link: EntityExternalLinkRow,
  ): boolean {
    // The SAME decision linksForEntity discloses to the removal dialog — the
    // two must never disagree, or the dialog promises an action this enqueue
    // does not perform.
    const action = removalWriteBackAction(connection.provider, connection.archive_sync_mode);
    if (action === 'archive') {
      return enqueueArchiveWrite(
        { db: this.db, nowIso: this.nowIso },
        { link, connection },
        link.entity_type,
        link.entity_id,
      );
    }
    return this.enqueueGroupWriteBack(connection, link, 'cancelled');
  }

  /**
   * Queue ONE content write for a link's issue after the user accepts the LOCAL
   * side of a title/description/priority/category conflict — the ruling's own
   * convergence write, mirroring what {@link enqueueStageWriteBack} does for a
   * stage conflict.
   *
   * GATED ON `content_sync_mode !== 'off'`, and this is the one enqueue site
   * where that gate is easy to miss (invariant 5 calls it out by name). The
   * `auto`/`manual` distinction says WHEN a ruling reaches the tracker and is
   * therefore not consulted here — the enqueue is durable intent, and the drain
   * is where a held direction waits. `'off'` says WHETHER, and an off-mode
   * ruling must stamp the baseline ONLY: an `update_content` row it enqueued
   * could not be claimed by any pass, not even "Sync now", while still halting
   * the inbound batch at that issue forever.
   *
   * The payload is empty for the same reason writeBack's own content enqueue
   * leaves it empty: the drain composes from the entity as it stands then.
   */
  private enqueueContentWriteBack(
    connection: TrackerConnectionRow,
    link: EntityExternalLinkRow,
  ): void {
    if (connection.content_sync_mode === 'off') return;
    const entityType = link.entity_type;
    if (entityType === 'epic') return;
    enqueueContentWrite(
      { db: this.db, nowIso: this.nowIso },
      { link, connection },
      entityType,
      link.entity_id,
    );
  }

  // -------------------------------------------------------------------------
  // Entity link lookup + the local-removal ruling
  //
  // THE ORDER THIS FEATURE RUNS IN. The dialog in front of a delete/archive only
  // COLLECTS the user's answer (stageUnlinkRuling); nothing is mutated there,
  // because the user still has the ordinary confirm dialog to back out of. The
  // ruling is CONSUMED by handleLocalRemoval when the entity write actually
  // lands — so backing out of the confirm leaves the link live, the issue
  // untouched, and the abandoned ruling expiring on its own.
  // -------------------------------------------------------------------------

  /**
   * EVERY live tracker link for one entity — one per provider at most (the
   * schema's `UNIQUE (entity_type, entity_id, provider)`). ORPHANED links are
   * excluded: they point at an issue the remote no longer has, so an "open in
   * Linear" affordance built on one would be a dead end.
   *
   * Was `linkForEntity`, returning only the FIRST provider's link: the removal
   * dialog built on that shape disclosed one provider while
   * {@link handleLocalRemoval}/{@link unlinkEntity} apply the ruling to EVERY
   * live link — an entity synced to both Linear and Dart showed "Archive in
   * Linear" while ALSO trashing the Dart task, undisclosed. The ruling itself
   * stays global (a deleted entity must not leave a live link anywhere), so the
   * fix is disclosure, not scoping.
   */
  async linksForEntity(
    entityType: TrackerEntityType,
    entityId: string,
  ): Promise<TrackerEntityLinkRef[]> {
    return this.liveLinksForEntity(entityType, entityId).map((link) => {
      const connection = getConnection(this.db, link.connection_id);
      return {
        provider: link.provider,
        externalUrl: link.external_url,
        externalIdentifier: link.external_identifier,
        // What a removal ruling would ACTUALLY do to this issue — the removal
        // dialog's copy must promise the action enqueueRemovalWriteBack
        // performs, not assume the archive path (adversarial round 3, finding
        // 2: under the default archive_sync_mode 'off' every ruling falls back
        // to the cancelled-state write). A connection row that vanished mid-read
        // gets the conservative 'cancel'.
        removalAction:
          connection === null
            ? ('cancel' as const)
            : removalWriteBackAction(connection.provider, connection.archive_sync_mode),
      };
    });
  }

  /**
   * True when hard-deleting this entity would ALSO remove at least one OTHER
   * synced entity (an idea's epics/tasks, an epic's tasks). The removal dialog
   * asks so its copy can say the one ruling covers those children too — which is
   * exactly what {@link handleLocalRemoval} then does.
   *
   * Deliberately its own call rather than a field on {@link linksForEntity}'s
   * result: that shape is the "open in Linear" chip's data, and a cascade
   * question has no business being answered on every read of it.
   */
  async hasLinkedDescendants(entityType: TrackerEntityType, entityId: string): Promise<boolean> {
    return hasActiveLinkedDescendant(this.db, entityType, entityId);
  }

  /**
   * COLLECT the local-removal ruling (design doc → "Deletes") without applying
   * any part of it. The user is about to be shown the ordinary delete/archive
   * confirm and may still back out; nothing here touches a link, a connection or
   * the outbox.
   *
   * The ruling is consumed by {@link handleLocalRemoval} when the entity write
   * actually commits, and by nothing else — an abandoned one simply expires
   * ({@link UNLINK_RULING_TTL_MS}). Re-staging for the same entity overwrites:
   * the newest answer is the one the user is looking at.
   */
  async stageUnlinkRuling(
    entityType: TrackerEntityType,
    entityId: string,
    opts: { cancelRemote: boolean },
  ): Promise<void> {
    this.pruneStaleRulings();
    this.stagedRulings.set(rulingKey(entityType, entityId), {
      cancelRemote: opts.cancelRemote,
      stagedAt: this.rulingNowMs(),
    });
  }

  /**
   * DISCARD a staged ruling the user has backed out of — layer 1 of the three
   * defenses documented at {@link TrackerSyncService.stagedRulings}. Called
   * when the archive/delete confirm behind the ruling dialog closes without
   * committing, and when the ruling dialog itself is dismissed.
   *
   * Without it the answer stays consumable for the whole TTL, and the NEXT
   * user-authored removal of that same entity — minutes later, from anywhere in
   * the UI — would spend it and cancel a tracker issue the user explicitly
   * declined to cancel.
   *
   * Idempotent and total: clearing an entity with no staged ruling is a no-op,
   * so the renderer can fire it defensively without first asking whether one
   * exists.
   */
  async clearUnlinkRuling(entityType: TrackerEntityType, entityId: string): Promise<void> {
    this.stagedRulings.delete(rulingKey(entityType, entityId));
  }

  /**
   * The LOCAL-DELETE ruling applied DIRECTLY, without the staging step. Both
   * answers ORPHAN the link — the entity is going away, so there is nothing left
   * to sync — and `cancelRemote` additionally queues the state write that moves
   * the issue into the tracker's cancelled group. There is no remote hard-delete
   * on this path, ever: the worst we ever do to someone else's tracker is cancel
   * an issue.
   *
   * EVERY live link is dropped, not just the first provider's: an entity that is
   * about to disappear must not leave a live link pointing at it from the other
   * tracker. `unlinked: false` therefore means "nothing was linked".
   *
   * NOT the board's delete path any more — that one stages a ruling and lets the
   * committed delete consume it, so a cancelled confirm mutates nothing. This
   * stays for the callers that have already committed to dropping a link with no
   * confirm behind them (and as the direct-application core the removal handler
   * shares).
   */
  async unlinkEntity(
    entityType: TrackerEntityType,
    entityId: string,
    opts: { cancelRemote: boolean },
  ): Promise<{ unlinked: boolean }> {
    const links = this.liveLinksForEntity(entityType, entityId);
    for (const link of links) this.dropLink(link, opts.cancelRemote);
    return { unlinked: links.length > 0 };
  }

  /** Every LIVE (non-orphaned) link an entity has, one per provider at most. */
  private liveLinksForEntity(
    entityType: TrackerEntityType,
    entityId: string,
  ): EntityExternalLinkRow[] {
    const links: EntityExternalLinkRow[] = [];
    for (const provider of LINK_PROVIDERS) {
      const link = getLinkByEntity(this.db, entityType, entityId, provider);
      if (link === null || link.orphaned_at !== null) continue;
      links.push(link);
    }
    return links;
  }

  /**
   * Orphan ONE link, first queueing the remote write the ruling asked for.
   *
   * ORDER IS LOAD-BEARING: the enqueue reads the LIVE link (it needs the
   * external id, and the dedup scan is against rows for that issue), and a
   * half-applied ruling — orphaned but never acted on — is exactly the outcome
   * the user asked us to avoid. The outbox row addresses `(connection,
   * external_id)`, so the drain does not need the link to still be live; only
   * this enqueue does.
   *
   * WHICH WRITE, and why it is no longer always the cancelled-state one. The
   * locked scope decision is that a local removal becomes a remote TRASH or
   * ARCHIVE — never a delete, and no longer a mere status change where the
   * provider offers something better. So a provider with a real archive
   * endpoint (Linear, Dart) gets `archive_issue`; `archive: 'none'` (Plane)
   * keeps the cancelled-state write, which is the strongest thing its API can
   * actually do.
   *
   * `archive_sync_mode` GATES ONLY THE `'off'` END OF THAT CHOICE, for
   * invariant 5's reason and no other: an `archive_issue` row whose direction
   * is off can never be claimed, and an unclaimable row halts inbound for that
   * issue forever. An off connection therefore falls back to the cancelled
   * -state write too — the user's explicit ruling still reaches the tracker,
   * through a direction that can carry it. `auto` vs `manual` is NOT consulted,
   * exactly as `status_sync_mode` is not: those modes govern the AUTOMATIC
   * cadence, whereas this is a direct instruction about the one issue in front
   * of the user, answered in a dialog that named it.
   *
   * A disconnected connection is skipped entirely: its stored key is gone, so
   * no row of any kind could drain.
   */
  private dropLink(link: EntityExternalLinkRow, cancelRemote: boolean): void {
    const connection = getConnection(this.db, link.connection_id);

    if (cancelRemote && connection !== null && connection.status !== 'disconnected') {
      if (this.enqueueRemovalWriteBack(connection, link)) {
        // Same 2s nudge a stage move gets — without it the write would sit
        // until the next 5-minute poll, long after the entity is gone.
        this.armDrainTimer(connection.id);
      }
    }

    markOrphaned(this.db, link.id);
    if (connection !== null) {
      // 'connection' (not 'sync'): the connected view's linked-item counts are
      // what changed, and no pass ran.
      this.emitTrackerChange(connection.project_id, connection.id, 'connection');
    }
  }

  // -------------------------------------------------------------------------
  // Consuming a staged ruling
  // -------------------------------------------------------------------------

  /**
   * The CONSUMPTION half of {@link stageUnlinkRuling}, driven by the committed
   * entity write itself. Two triggers:
   *
   *   DELETE. The entity's rows are already gone, so its links MUST be orphaned
   *   whether or not a ruling was staged — `entity_external_links` has no entity
   *   foreign key, so nothing else ever will, and a link to a nonexistent entity
   *   is a zombie the inbound poller skips forever (it finds the link, finds no
   *   local entity, and moves on every single pass).
   *
   *   ARCHIVE. Only ever acted on WITH a staged ruling. An archive is not a
   *   removal in itself — inbound sync archives entities on the tracker's behalf
   *   and manages those links itself — so the ruling's presence is precisely
   *   what distinguishes "the user chose this in the removal dialog" from "the
   *   provider did this to us". An inbound apply never stages one.
   *
   * ONLY A HUMAN'S REMOVAL SPENDS A HUMAN'S RULING (layer 2 of the three
   * defenses at {@link TrackerSyncService.stagedRulings}). The ruling is the
   * answer to a dialog a person was looking at, so it is consumable ONLY by an
   * `actor: 'user'` event. A provider- or orchestrator-authored archive/delete
   * landing inside the window is treated exactly as it would be with no ruling
   * staged at all: a delete still orphans its links (they have nowhere else to
   * go), an archive is left alone, and NOTHING is queued at the tracker. The
   * ruling itself survives untouched for the removal it was actually collected
   * for. An event with no `actor` at all (a hand-built broadcast) is
   * unattributed, and therefore not a user.
   *
   * CASCADE MEMBERS INHERIT THE ROOT'S RULING (and the dialog says so). The
   * router emits one 'deleted' event per cascade entity, CHILDREN FIRST — and it
   * has already deleted every row by then, so the only place a child's lineage
   * still exists is the pre-delete snapshot on its own event. Hence the
   * parent-epic / originating-idea lookups rather than a DB walk.
   *
   * Never throws: this runs inline on TaskChangeRouter's post-commit emit, where
   * a throw would surface as a failed backlog write.
   */
  private handleLocalRemoval(event: TaskChangedEvent): void {
    try {
      const deleted = event.action === 'deleted';
      const archived = event.task.archived_at !== null;
      if (!deleted && !archived) return;

      this.pruneStaleRulings();
      const byUser = event.actor === 'user';
      const key = rulingKey(event.task.type, event.taskId);
      const own = byUser ? (this.stagedRulings.get(key) ?? null) : null;
      // Inheritance is a DELETE-only affair: the archive toggle changes exactly
      // one row, so an archived epic's children are still on the board. Gated on
      // `byUser` too — a cascade member must not reach around the actor check to
      // pick up the root's ruling.
      const ruling = own ?? (deleted && byUser ? this.inheritedRuling(event.task) : null);
      if (!deleted && ruling === null) return;

      for (const link of this.liveLinksForEntity(event.task.type, event.taskId)) {
        this.dropLink(link, ruling?.cancelRemote === true);
      }

      if (own !== null) this.stagedRulings.delete(key);

      // The zombie sweep can only run once NO ruling is still waiting to be
      // consumed. Sweeping mid-cascade would orphan a sibling's link before that
      // sibling's own event arrived to apply the root's ruling to it — turning a
      // "cancel these in Linear" into a silent unlink.
      if (deleted && this.stagedRulings.size === 0) {
        this.sweepZombieLinks(event.projectId, ruling);
      }
    } catch (err) {
      this.logger?.error('[trackerSync] applying the local-removal ruling failed', {
        taskId: event.taskId,
        error: describeError(err),
      });
    }
  }

  /** The ruling staged on this entity's delete-cascade ROOT, or null. */
  private inheritedRuling(task: BacklogTaskItem): StagedUnlinkRuling | null {
    if (task.parent_epic_id !== null) {
      const viaEpic = this.stagedRulings.get(rulingKey('epic', task.parent_epic_id));
      if (viaEpic !== undefined) return viaEpic;
    }
    if (task.originating_idea_id !== null) {
      const viaIdea = this.stagedRulings.get(rulingKey('idea', task.originating_idea_id));
      if (viaIdea !== undefined) return viaIdea;
    }
    return null;
  }

  /**
   * Orphan every link in the project whose entity no longer exists, applying
   * `ruling` to each. The SAFETY NET behind the per-entity handling above: a
   * cascade member whose snapshot could not be built broadcasts no event at all,
   * and its link would otherwise be stranded live forever.
   */
  private sweepZombieLinks(projectId: number, ruling: StagedUnlinkRuling | null): void {
    for (const link of listActiveLinksWithoutEntity(this.db, projectId)) {
      this.dropLink(link, ruling?.cancelRemote === true);
    }
  }

  /** Drop rulings past {@link UNLINK_RULING_TTL_MS} — the user backed out of the confirm. */
  private pruneStaleRulings(): void {
    const now = this.rulingNowMs();
    for (const [key, ruling] of this.stagedRulings) {
      if (now - ruling.stagedAt >= UNLINK_RULING_TTL_MS) this.stagedRulings.delete(key);
    }
  }

  /** The ruling clock — the service's injected `nowIso`, so tests own it. */
  private rulingNowMs(): number {
    return parseTimestamp(this.nowIso()) ?? Date.now();
  }
}

// ---------------------------------------------------------------------------
// Not-run pass results
// ---------------------------------------------------------------------------

/**
 * A pass/drain that never started because the connection is not active. Same
 * "nothing ran, nothing persisted" contract as the unknown-connection result.
 */
function inactiveResult(
  connectionId: string,
  status: TrackerConnectionRow['status'],
): TrackerSyncPassResult {
  return {
    connectionId,
    ran: false,
    swept: false,
    paused: status === 'paused',
    entries: [],
    error: `connection is ${status}`,
  };
}

/**
 * A pass that stopped at a phase boundary because the connection stopped being
 * active mid-flight (see the abandon note on {@link TrackerSyncService.runPass}).
 * `entries` is what it had composed so far — returned for the caller's benefit,
 * NOT persisted: an abandoned pass writes nothing.
 */
function abandonedResult(
  connectionId: string,
  entries: TrackerSyncLogEntry[],
): TrackerSyncPassResult {
  return {
    connectionId,
    ran: false,
    swept: false,
    paused: false,
    entries,
    error: 'connection is no longer active',
  };
}

// ---------------------------------------------------------------------------
// Log composition
// ---------------------------------------------------------------------------

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

/** Phases 1+2's counters. `drained` is null when an auth failure stopped the pass early. */
function appendWriteBackLines(
  entries: TrackerSyncLogEntry[],
  ambiguous: OutboxReport,
  drained: OutboxReport | null,
): void {
  const sent = ambiguous.sent + (drained?.sent ?? 0);
  const created = ambiguous.created + (drained?.created ?? 0);
  const pushed = ambiguous.pushedIdeas + (drained?.pushedIdeas ?? 0);
  const mirrored = created - pushed;
  const contentWritten = ambiguous.contentWritten + (drained?.contentWritten ?? 0);
  const contentWithheld = ambiguous.contentWithheld + (drained?.contentWithheld ?? 0);
  const archived = ambiguous.archived + (drained?.archived ?? 0);
  const recovered = ambiguous.ambiguousResolved;
  const retries = ambiguous.retriesScheduled + (drained?.retriesScheduled ?? 0);
  const failed = ambiguous.failedTerminal + (drained?.failedTerminal ?? 0);
  const superseded = ambiguous.superseded + (drained?.superseded ?? 0);
  const orphaned = ambiguous.orphanedCreates + (drained?.orphanedCreates ?? 0);

  if (recovered > 0) {
    entries.push({ marker: '·', line: `recovered ${plural(recovered, 'in-flight write')}` });
  }
  if (sent > 0) entries.push({ marker: '✓', line: `wrote ${plural(sent, 'issue state')}` });
  if (pushed > 0) entries.push({ marker: '✓', line: `pushed ${plural(pushed, 'idea')}` });
  if (mirrored > 0) entries.push({ marker: '✓', line: `mirrored ${plural(mirrored, 'sub-issue')}` });
  if (contentWritten > 0) {
    entries.push({ marker: '✓', line: `updated ${plural(contentWritten, 'issue')} in the tracker` });
  }
  // The lost-update guard fired: a tracker-side edit landed after the baseline
  // stamp, so the write was withheld and the inbound conflict machinery owns it.
  if (contentWithheld > 0) {
    entries.push({
      marker: '⚠',
      line: `held back ${plural(contentWithheld, 'write')} · concurrent tracker edit — next sync resolves it`,
    });
  }
  // "archived" is the local vocabulary; what the provider actually performs is
  // its trash or archive, never a delete — see the locked scope decision.
  if (archived > 0) {
    entries.push({ marker: '✓', line: `archived ${plural(archived, 'issue')} in the tracker` });
  }
  if (superseded > 0) {
    entries.push({ marker: '·', line: `${plural(superseded, 'stale write')} superseded` });
  }
  // The ONLY surface that names a remote issue we created and can no longer
  // point at — see outboxWorker.adoptOrOrphanPush. The row's `last_error`
  // carries its identifier and URL.
  if (orphaned > 0) {
    entries.push({
      marker: '⚠',
      line: `${plural(orphaned, 'created issue')} left orphaned · the local idea was removed`,
    });
  }
  if (retries > 0) entries.push({ marker: '·', line: `${plural(retries, 'write')} queued for retry` });
  if (failed > 0) entries.push({ marker: '⚠', line: `${plural(failed, 'write')} failed` });
}

/**
 * Does the outbox still hold a create whose REMOTE OUTCOME is genuinely
 * unknown? True only for a provider without idempotent creates — everywhere
 * else the client key IS the created issue's id, so a lost create is recovered
 * by a point lookup and inbound's own `client_key` halt already covers the
 * window.
 *
 * UNSETTLED IS NOT THE SAME AS UNKNOWN, and conflating the two is what made
 * this gate a deadlock. `listUnresolvedOutbox` returns pending / in_flight /
 * ambiguous, and a NEVER-ATTEMPTED pending row has a perfectly known outcome:
 * no request was ever sent, so no remote issue exists and nothing can be
 * re-imported. Gating on it disabled inbound sync entirely for a connection
 * whose push direction is 'manual' — the backfill default for every existing
 * Plane connection — because the create it enqueues is never claimed until the
 * user drains push by hand, and until then automatic pull AND linked-status
 * sync were both wedged behind it, indefinitely.
 *
 * So the gate asks {@link outcomeIsUnknown} instead, which still covers every
 * genuine hazard: a row mid-send, a row parked `ambiguous`, and a row that was
 * attempted and then returned to the queue.
 */
function hasUnresolvedCreateRecovery(
  db: Database.Database,
  connectionId: string,
  adapter: TrackerAdapter,
): boolean {
  if (adapter.capabilities.idempotentCreate) return false;
  // BOTH create kinds. A pushed idea's unacked issue is the same hazard as an
  // unacked mirrored child — the remote issue exists under a provider-minted id
  // that matches neither the outbox row's `external_id` nor its `client_key` —
  // except that importing it would duplicate the very idea that produced it.
  return listUnresolvedOutbox(db, connectionId).some(
    (row) =>
      (row.kind === 'create_sub_issue' || row.kind === 'create_issue') && outcomeIsUnknown(row),
  );
}

/**
 * Could this unsettled outbox row have produced a remote issue nobody knows
 * about?
 *
 *   - `in_flight`  — claimed and mid-send. The definition of unknown.
 *   - `ambiguous`  — parked precisely BECAUSE the outcome is unknown.
 *   - `pending` with `attempts > 0` — claimed at least once, so a request went
 *     out, and something put the row back in the queue. Even the paths that
 *     requeue only after PROVING the create never landed
 *     (outboxWorker.resolveAmbiguous) are treated as unknown here: the proof
 *     was a lookup at some earlier moment, this predicate costs at most one
 *     deferred poll, and a wrong answer costs a duplicated idea.
 *   - `pending` with `attempts === 0` — never claimed, therefore never sent.
 *     KNOWN, and the only case that must not gate.
 *
 * `attempts` is incremented by store.claimNextPending inside the claim
 * transaction, so it is exactly "how many times this row has been handed to a
 * sender" — the fact this reading needs, and one no other column carries.
 */
function outcomeIsUnknown(row: TrackerOutboxRow): boolean {
  return row.state === 'pending' ? row.attempts > 0 : true;
}

/**
 * One line per direction this pass is HOLDING, so "sync complete · 0 changes"
 * on a manual-mode connection is legible instead of looking broken. A pass with
 * every direction running says nothing extra.
 */
function appendHeldDirectionLines(
  entries: TrackerSyncLogEntry[],
  connection: TrackerConnectionRow,
  trigger: TrackerSyncTrigger,
): void {
  const held: string[] = [];
  if (!directionRuns(connection.status_sync_mode, trigger)) held.push('status');
  if (!directionRuns(connection.pull_mode, trigger)) held.push('import');
  if (!directionRuns(connection.push_mode, trigger)) held.push('push');
  for (const direction of held) {
    entries.push({ marker: '·', line: `${direction} held · manual — use Sync now` });
  }

  // The two content-sync-mode directions get their OWN phrasing rather than
  // reusing the loop above: 'off' is not something "Sync now" can unstick (it
  // gates at the enqueue, never the drain — invariant 5), so a held line that
  // said "use Sync now" for an 'off' direction would promise a fix that does
  // nothing.
  appendContentModeLine(entries, 'content changes', connection.content_sync_mode, trigger);
  appendContentModeLine(entries, 'archive', connection.archive_sync_mode, trigger);
}

/** One {@link appendHeldDirectionLines} line for a single content-sync-mode direction, or none. */
function appendContentModeLine(
  entries: TrackerSyncLogEntry[],
  label: string,
  mode: TrackerContentSyncMode,
  trigger: TrackerSyncTrigger,
): void {
  if (mode === 'off') {
    entries.push({ marker: '·', line: `${label} off` });
    return;
  }
  if (mode === 'manual' && trigger !== 'manual') {
    entries.push({ marker: '·', line: `${label} held (manual) · use Sync now` });
  }
}

/** Phase 3's counters. */
function appendInboundLines(entries: TrackerSyncLogEntry[], report: InboundSyncReport): void {
  // "matched" = fetched issues that already had a local counterpart, whether or
  // not they carried a change (updated) or were deliberately passed over
  // (skipped). Fresh imports are reported on their own line below.
  entries.push({ marker: '·', line: `matched ${report.updated + report.skipped}` });
  if (report.imported > 0) {
    entries.push({ marker: '✓', line: `created ${plural(report.imported, 'idea')}` });
  }
  if (report.updated > 0) {
    entries.push({ marker: '✓', line: `updated ${plural(report.updated, 'linked item')}` });
  }
  const conflicts = report.conflictsOpened + report.autoResolved;
  if (conflicts > 0) entries.push({ marker: '✎', line: `conflicts ${conflicts}` });
  if (report.crossScopeSkips > 0) {
    entries.push({
      marker: '·',
      line: `${plural(report.crossScopeSkips, 'cross-scope duplicate')} skipped`,
    });
  }
  if (report.stageDeferred > 0) {
    entries.push({
      marker: '·',
      line: `${plural(report.stageDeferred, 'status change')} held — use Sync now`,
    });
  }
  if (report.importDeferred > 0) {
    entries.push({
      marker: '·',
      line: `${plural(report.importDeferred, 'new issue')} held — use Sync now`,
    });
  }
  if (report.contentDeferred > 0) {
    entries.push({
      marker: '·',
      line: `${plural(report.contentDeferred, 'content change')} waiting on an open conflict`,
    });
  }
  if (report.entityLocked > 0) {
    entries.push({
      marker: '·',
      line: `${plural(report.entityLocked, 'status change')} waiting on an active run`,
    });
  }
  if (report.unmappedFieldValues > 0) {
    // A '⚠' rather than a '·': this is the loud-failure convention for a value
    // the tracker renamed out from under a mapping (Dart addresses priorities
    // and types by title). Nothing was applied, and it stays reported on every
    // pass until the mapping is confirmed.
    entries.push({
      marker: '⚠',
      line: `${plural(report.unmappedFieldValues, 'unmapped remote value')} · confirm the mapping`,
    });
  }
  if (report.archivedRemotely > 0) {
    entries.push({ marker: '·', line: `archived ${plural(report.archivedRemotely, 'remote item')}` });
  }
  if (report.haltedOnOutbox !== undefined) {
    entries.push({ marker: '·', line: `held at ${report.haltedOnOutbox} — our write is in flight` });
  }
}

/** Phase 4's counters. */
function appendSweepLines(entries: TrackerSyncLogEntry[], sweep: InboundSweepReport): void {
  if (sweep.sweepArchived > 0) {
    entries.push({ marker: '·', line: `swept ${plural(sweep.sweepArchived, 'deleted issue')}` });
  }
  if (sweep.outOfScope > 0) {
    entries.push({ marker: '·', line: `${plural(sweep.outOfScope, 'issue')} out of scope · left linked` });
  }
  if (sweep.entityLocked > 0) {
    entries.push({
      marker: '·',
      line: `${plural(sweep.entityLocked, 'deleted issue')} waiting on an active run`,
    });
  }
  if (sweep.conflictsOpened > 0) {
    entries.push({ marker: '✎', line: `conflicts ${sweep.conflictsOpened}` });
  }
}

/** The connection's currently-stored log; an absent/corrupt blob reads back empty. */
function readStoredLog(db: Database.Database, connectionId: string): TrackerSyncLogEntry[] {
  return parseLogEntries(getConnection(db, connectionId)?.last_sync_log_json ?? null);
}

/**
 * Parse a `last_sync_log_json` blob. DEFENSIVE by contract: an absent, corrupt,
 * non-array, or partially-malformed blob degrades to the entries it can read
 * (or none) — a log is a display artifact, and a bad one must never break the
 * connected view or a pass that appends to it.
 */
function parseLogEntries(raw: string | null): TrackerSyncLogEntry[] {
  if (raw === null || raw.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isLogEntry);
}

function isLogEntry(value: unknown): value is TrackerSyncLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.marker === 'string' && typeof candidate.line === 'string';
}

// ---------------------------------------------------------------------------
// Connected-view + reconcile reads
//
// Plain SELECTs against the NATIVE entity tables, which store.ts does not own —
// the same split inboundSync.readLocalEntity documents: the chokepoint rule
// governs WRITES, and taskListing's projections carry run overlays these reads
// have no use for.
// ---------------------------------------------------------------------------

/** Link lookup order for an entity whose provider we do not know up front. */
const LINK_PROVIDERS: readonly TrackerProvider[] = ['linear', 'plane', 'dart'];

/** The connected view's source label, read back off `source_json`. */
function readSourceLabel(connection: TrackerConnectionRow): string {
  const parsed = parseJsonObject(connection.source_json);
  if (typeof parsed.label === 'string' && parsed.label.length > 0) return parsed.label;
  // Pre-label rows (and any hand-edited blob) fall back to the narrow/container
  // id — meaningless to a human but never blank, and never a crash.
  if (typeof parsed.narrowId === 'string' && parsed.narrowId.length > 0) return parsed.narrowId;
  if (typeof parsed.containerId === 'string') return parsed.containerId;
  return '';
}

/** The narrow kinds the wire type admits, as a runtime set. */
const NARROW_KINDS: readonly TrackerNarrowKind[] = [
  'all',
  'project',
  'view',
  'cycle',
  'module',
  'space',
];

/**
 * The connected view's source SCOPE, read back off `source_json` — the mapping
 * identity the management view groups and de-duplicates rows by, where
 * {@link readSourceLabel} is only what it prints.
 *
 * `storedSourceScope` types `narrowKind` as a bare string on purpose (it is
 * parsing an arbitrary persisted blob), so an unrecognized value is normalized
 * to 'all' rather than cast: 'all' is the same fallback parseSourceSelection
 * applies, and a scope that lies about its kind would be worse than a wide one.
 */
function readSourceScope(row: TrackerConnectionRow): TrackerConnectionSummary['sourceScope'] {
  const scope = storedSourceScope(row);
  if (scope === null) return null;
  const narrowKind = NARROW_KINDS.find((kind) => kind === scope.narrowKind) ?? 'all';
  return { containerId: scope.containerId, narrowId: scope.narrowId, narrowKind };
}

/** An entity's display identity + body, for conflict rows and description merges. */
interface EntityIdentity {
  ref: string;
  title: string;
  body: string | null;
}

const IDENTITY_TABLE: Record<TrackerEntityType, 'ideas' | 'epics' | 'tasks'> = {
  idea: 'ideas',
  epic: 'epics',
  task: 'tasks',
};

function readEntityIdentity(
  db: Database.Database,
  entityType: TrackerEntityType,
  entityId: string,
): EntityIdentity | null {
  const row = db
    .prepare(`SELECT ref, title, body FROM ${IDENTITY_TABLE[entityType]} WHERE id = ?`)
    .get(entityId) as EntityIdentity | undefined;
  return row ?? null;
}

/**
 * Does this entity exist AND live in `projectId`? The membership check behind
 * `connect`'s reconcile decisions — a missing row and a row belonging to
 * another project are the same answer here, because both mean "not something
 * this connection may act on".
 */
function entityBelongsToProject(
  db: Database.Database,
  entityType: TrackerEntityType,
  entityId: string,
  projectId: number,
): boolean {
  const row = db
    .prepare(`SELECT project_id FROM ${IDENTITY_TABLE[entityType]} WHERE id = ?`)
    .get(entityId) as { project_id: number } | undefined;
  return row?.project_id === projectId;
}

/** One Reconcile candidate row (the union of active ideas + active tasks). */
interface ReconcileCandidateRow {
  id: string;
  type: 'idea' | 'task';
  ref: string;
  title: string;
}

/**
 * The project's reconcilable entities: ideas + tasks that are not archived, not
 * on a terminal stage, not a retired (decomposed) idea, not an A/B experiment
 * sandbox row, and not already linked to a tracker issue. Epics are excluded —
 * they are never linked to an issue (imports land as ideas, mirroring creates
 * sub-issues for tasks).
 */
function listReconcileCandidates(
  db: Database.Database,
  projectId: number,
): ReconcileCandidateRow[] {
  return db
    .prepare(
      `SELECT i.id AS id, 'idea' AS type, i.ref AS ref, i.title AS title
         FROM ideas i
         JOIN board_stages s ON s.id = i.stage_id
        WHERE i.project_id = ?
          AND i.archived_at IS NULL
          AND i.decomposed_at IS NULL
          AND i.experiment_id IS NULL
          AND s.is_terminal = 0
          AND NOT EXISTS (
            SELECT 1 FROM entity_external_links l
             WHERE l.entity_type = 'idea' AND l.entity_id = i.id
          )
        UNION ALL
       SELECT t.id AS id, 'task' AS type, t.ref AS ref, t.title AS title
         FROM tasks t
         JOIN board_stages s ON s.id = t.stage_id
        WHERE t.project_id = ?
          AND t.archived_at IS NULL
          AND t.experiment_id IS NULL
          AND s.is_terminal = 0
          AND NOT EXISTS (
            SELECT 1 FROM entity_external_links l
             WHERE l.entity_type = 'task' AND l.entity_id = t.id
          )
        ORDER BY type ASC, ref ASC`,
    )
    .all(projectId, projectId) as ReconcileCandidateRow[];
}

// ---------------------------------------------------------------------------
// Reconcile title matching
// ---------------------------------------------------------------------------

/** The token-overlap ratio at which two titles are treated as the same item. */
const TITLE_MATCH_THRESHOLD = 0.75;

/** Lowercase, collapse every non-alphanumeric run to one space, trim. */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Word set of a normalized title (empty string -> empty set). */
function tokenize(normalized: string): Set<string> {
  return new Set(normalized.length === 0 ? [] : normalized.split(' '));
}

/**
 * 1.0 for a containment match (one normalized title inside the other), else the
 * Jaccard overlap of the two word sets (|A n B| / |A u B|). Containment scores
 * highest because "Ship tracker sync" inside "Ship tracker sync (Linear)" is a
 * stronger signal than any partial word overlap.
 */
function titleScore(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  if (a.includes(b) || b.includes(a)) return 1;
  const setA = tokenize(a);
  const setB = tokenize(b);
  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared++;
  const union = setA.size + setB.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * The best-matching issue for a local title, or null when nothing clears
 * {@link TITLE_MATCH_THRESHOLD}. Ties break on the lower externalId so the same
 * inputs always yield the same suggestion.
 */
function suggestMatch(
  title: string,
  issues: ReadonlyArray<{ externalId: string; normalized: string }>,
): string | null {
  const normalized = normalizeTitle(title);
  let bestId: string | null = null;
  let bestScore = 0;
  for (const issue of issues) {
    const score = titleScore(normalized, issue.normalized);
    if (score < TITLE_MATCH_THRESHOLD) continue;
    if (score > bestScore || (score === bestScore && bestId !== null && issue.externalId < bestId)) {
      bestScore = score;
      bestId = issue.externalId;
    }
  }
  return bestId;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** Both flavours of "the stored key will not work" — pause, do not retry on a timer. */
function isCredentialFailure(err: unknown): boolean {
  return err instanceof TrackerAuthError || err instanceof TrackerCredentialsError;
}

/**
 * Epoch ms for a timestamp in EITHER shape we write: sqlite's `datetime('now')`
 * ('YYYY-MM-DD HH:MM:SS', implicitly UTC) or a JS ISO-8601 string. Null when
 * absent or unparseable — the caller then treats the connection as never synced.
 */
function parseTimestamp(value: string | null): number | null {
  if (value === null || value.length === 0) return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
