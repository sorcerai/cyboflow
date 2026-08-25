/**
 * trackerSyncBridge — the seam between the tracker-sync ENGINE
 * (main/src/services/trackerSync/*) and the tRPC surface that drives it
 * (trpc/routers/tracker.ts). Design: docs/proposals/tracker-sync-integration.md.
 *
 * WHY A BRIDGE. tRPC router files must standalone-typecheck: no 'electron', no
 * 'better-sqlite3', nothing under main/src/services/*. The router therefore
 * cannot name TrackerSyncService — so this file declares the FACADE the router
 * talks to, in terms of shared/types/trackerSync + plain JSON only, and the
 * composition root (main/src/index.ts) injects the live service into it at boot.
 * Same shape as trpc/routers/health.ts's setHealthProvider, one level up so the
 * service (which may import orchestrator files — inboundSync already does) can
 * implement the interface without importing a router.
 *
 * SECRETS. Nothing on this seam returns key material. `TrackerCredentialsInput`
 * travels renderer -> main on the wizard/connect calls and is encrypted before
 * it reaches sqlite; every read model here is key-free by construction.
 */
import { EventEmitter } from 'node:events';
import type {
  TrackerConflictChoice,
  TrackerConflictSummary,
  TrackerConnectPayload,
  TrackerConnectionSummary,
  TrackerCredentialsInput,
  TrackerEntityLinkRef,
  TrackerEntityType,
  TrackerFieldOptions,
  TrackerGroupTree,
  TrackerIssue,
  TrackerReconcileItem,
  TrackerSettingsPatch,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerSourceTree,
  TrackerState,
  TrackerSyncPassSummary,
  TrackerWizardSourceInput,
  TrackerWorkspaceIdentity,
} from '../../../shared/types/trackerSync';

// ---------------------------------------------------------------------------
// The facade
// ---------------------------------------------------------------------------

/**
 * Everything the tracker tRPC surface can ask of the sync engine.
 * TrackerSyncService implements this directly (structurally AND nominally — it
 * declares `implements TrackerSyncFacade`).
 *
 * The seven `wizard*` methods are STATELESS probes: they build a throwaway
 * provider client from the credentials in hand, persist nothing, and are the
 * only methods that run before a connection row exists.
 *
 * Four of them (`wizardGroups` / `wizardStates` / `wizardFieldOptions` /
 * `wizardIssues`) take a credential SOURCE rather than credentials, because
 * MAPPING MANAGEMENT re-enters those steps from a connection the user already
 * authorized and has no pasted key to offer — main resolves the stored one, so no key crosses IPC on that path at
 * all. `wizardValidate` / `wizardContainers` / `wizardNarrows` keep taking bare
 * credentials: they only ever run on the paste path, ahead of any connection.
 */
export interface TrackerSyncFacade {
  /** Live credential probe — the wizard's "Authorized as …" card. Persists nothing. */
  wizardValidate(credentials: TrackerCredentialsInput): Promise<TrackerWorkspaceIdentity>;
  /** The Map step's mappable tracker groups (Linear projects/teams, Plane projects, Dart spaces). */
  wizardGroups(source: TrackerWizardSourceInput): Promise<TrackerGroupTree>;
  /** Wizard Step 1, top level (Linear teams / Plane projects). */
  wizardContainers(credentials: TrackerCredentialsInput): Promise<TrackerSourceTree>;
  /** Wizard Step 1, second level for one container (always includes 'all'). */
  wizardNarrows(
    credentials: TrackerCredentialsInput,
    containerId: string,
  ): Promise<TrackerSourceNarrow[]>;
  /** Wizard Step 3's mapping table — the source's states with canonical groups. */
  wizardStates(
    source: TrackerWizardSourceInput,
    selection: TrackerSourceSelection,
  ): Promise<TrackerState[]>;
  /**
   * The mapping step's field vocabularies — the provider's priority tokens and
   * (Dart only) type titles. Takes no selection, unlike `wizardStates`: none of
   * the three providers scopes these lists to a container.
   */
  wizardFieldOptions(source: TrackerWizardSourceInput): Promise<TrackerFieldOptions>;
  /** Wizard Step 2 — the issues in the chosen source (assignee/manual pickers + Reconcile). */
  wizardIssues(
    source: TrackerWizardSourceInput,
    selection: TrackerSourceSelection,
  ): Promise<TrackerIssue[]>;

  /** Wizard Step 4 — the project's pre-existing backlog items with suggested matches. */
  reconcilePreview(projectId: number, issues: TrackerIssue[]): Promise<TrackerReconcileItem[]>;

  /**
   * Persist the connection (+ encrypted key + reconcile decisions) and kick the
   * first pass. The key is either pasted (`payload.credentials`) or borrowed from
   * a connection already authorized for this workspace
   * (`payload.sourceConnectionId`) — exactly one, and everything downstream of
   * that resolution is identical either way.
   */
  connect(payload: TrackerConnectPayload): Promise<{ connectionId: string }>;

  /**
   * ROTATE an existing connection's API key in place, resuming it: the key is
   * probed live, checked against the connection's own workspace, stored
   * encrypted, and the connection goes back to 'active' — which replays every
   * write an auth failure had held.
   *
   * The reconnect path for a revoked or rotated key, which `connect` cannot
   * serve: against a connection that is still active or paused it would mint a
   * SECOND one and re-import the whole synced backlog.
   *
   * Rejects with a NOT_FOUND-shaped error for an unknown id, and with a typed
   * mismatch error when the key authorizes a DIFFERENT workspace than the
   * connection is bound to. The returned identity carries no key material.
   */
  updateCredentials(connectionId: string, apiKey: string): Promise<TrackerWorkspaceIdentity>;

  /** The project's connected-view cards. */
  connections(projectId: number): Promise<TrackerConnectionSummary[]>;

  /**
   * Every LIVE mapping sharing this connection's tracker identity — `(provider,
   * workspace, instance)` — ACROSS projects, which is what makes it a different
   * question from {@link TrackerSyncFacade.connections}: one authorization mints
   * one sibling row per (tracker group -> cyboflow project) pair, and the
   * management view's object is that authorization, not any single row.
   *
   * The named connection is always present, retired included (a disconnected row
   * leads the list); an unknown id rejects NOT_FOUND-shaped.
   */
  mappings(connectionId: string): Promise<TrackerConnectionSummary[]>;

  /**
   * ARM this mapping as the one its (project, provider) pair pushes new ideas
   * through, demoting whichever sibling held the flag — the management view's
   * edit for a choice the wizard's Map step otherwise makes exactly once.
   *
   * Rejects NOT_FOUND-shaped for an unknown or DISCONNECTED id: a retired row
   * has no key and syncs nothing, so arming it would leave the project with no
   * live pusher.
   */
  setPushTarget(connectionId: string): Promise<void>;

  /** Patch a connection's editable settings. Unknown id is a no-op. */
  updateSettings(connectionId: string, patch: TrackerSettingsPatch): Promise<void>;

  /** Retire a connection: status 'disconnected' + the stored key cleared. Links stay. */
  disconnect(connectionId: string): Promise<void>;

  /** The manual "Sync now" — a forced pass, which also sweeps for remote deletions. */
  syncNow(connectionId: string): Promise<TrackerSyncPassSummary>;

  /** The connection's OPEN conflicts (Manual mode's queue). */
  conflicts(connectionId: string): Promise<TrackerConflictSummary[]>;

  /** Resolve one open conflict the user's way. Unknown/already-resolved id is a no-op. */
  resolveConflictChoice(conflictId: number, choice: TrackerConflictChoice): Promise<void>;

  /**
   * EVERY live tracker link an entity has, one per provider at most — an empty
   * array means it is not synced to any tracker.
   */
  linksForEntity(
    entityType: TrackerEntityType,
    entityId: string,
  ): Promise<TrackerEntityLinkRef[]>;

  /**
   * True when hard-deleting this entity would also remove other SYNCED entities
   * (an idea's epics/tasks, an epic's tasks) — the removal dialog says the one
   * ruling covers those children too.
   */
  hasLinkedDescendants(entityType: TrackerEntityType, entityId: string): Promise<boolean>;

  /**
   * COLLECT the local-removal ruling: the user is deleting/archiving a linked
   * entity and has said what should happen to the tracker issue ('keep' vs
   * `cancelRemote`). NOTHING is mutated here — no link is dropped and no remote
   * write is queued — because the ordinary delete/archive confirm still stands
   * behind this dialog and may be dismissed.
   *
   * The ruling is applied by the committed entity write itself (and by the
   * cascade it takes with it), so backing out of that confirm leaves the entity,
   * its link and the tracker issue exactly as they were; the unused ruling
   * expires. NEVER a remote hard delete — see the design doc's "Deletes" row.
   */
  stageUnlinkRuling(
    entityType: TrackerEntityType,
    entityId: string,
    opts: { cancelRemote: boolean },
  ): Promise<void>;

  /**
   * DISCARD a staged ruling the user has backed out of — the renderer calls it
   * when the archive/delete confirm behind the ruling dialog closes without
   * committing, and when the ruling dialog itself is dismissed.
   *
   * Without it the abandoned answer stays consumable until it expires, and the
   * NEXT removal of that same entity would spend it — cancelling a tracker
   * issue the user explicitly declined to cancel. Idempotent: clearing an
   * entity with no staged ruling is a no-op.
   */
  clearUnlinkRuling(entityType: TrackerEntityType, entityId: string): Promise<void>;

  /**
   * Apply the ruling DIRECTLY (drop the link now; `cancelRemote` also queues the
   * cancelled-group write). The board's delete path uses
   * {@link TrackerSyncFacade.stageUnlinkRuling} instead — this remains for
   * callers with no confirm dialog left to dismiss.
   *
   * `unlinked: false` means the entity had no live link (the renderer's
   * linksForEntity read was stale, or nothing was ever synced).
   */
  unlinkEntity(
    entityType: TrackerEntityType,
    entityId: string,
    opts: { cancelRemote: boolean },
  ): Promise<{ unlinked: boolean }>;
}

// ---------------------------------------------------------------------------
// Module-level injectable singleton (set once at boot via setTrackerSyncFacade)
// ---------------------------------------------------------------------------

/**
 * The tracker surface was called before main/src/index.ts injected the live
 * service. Typed (not a bare Error) so the router can map it to a distinct
 * TRPCError instead of guessing from a message.
 */
export class TrackerSyncNotInitializedError extends Error {
  constructor() {
    super(
      'TrackerSyncService has not been wired into the tracker bridge. ' +
        'Call setTrackerSyncFacade() from main/src/index.ts.',
    );
    this.name = 'TrackerSyncNotInitializedError';
  }
}

let facade: TrackerSyncFacade | null = null;

/**
 * Inject the live TrackerSyncService at boot (composition root). Idempotent —
 * calling again replaces the facade; tests install a fake per case and clear it
 * via {@link _resetTrackerSyncFacadeForTesting}.
 */
export function setTrackerSyncFacade(next: TrackerSyncFacade): void {
  facade = next;
}

/**
 * The wired facade.
 *
 * @throws {TrackerSyncNotInitializedError} when boot has not injected one yet.
 */
export function getTrackerSyncFacade(): TrackerSyncFacade {
  if (facade === null) throw new TrackerSyncNotInitializedError();
  return facade;
}

/** Test-only: clear the wired facade so a case starts from the unset state. */
export function _resetTrackerSyncFacadeForTesting(): void {
  facade = null;
}

// ---------------------------------------------------------------------------
// Change broadcast
//
// Mirrors taskChangeRouter.ts's emitter contract: a module-level EventEmitter
// exported HERE (not from the router) so the service and the tRPC subscription
// share one instance without a circular import, plus an exported channel helper
// so both sides derive the channel name the same way.
//
// Project-scoped only (no cross-project channel): the Settings > Integrations
// view is always opened for one project, so a global channel would just make
// every project's traffic cross every subscription.
// ---------------------------------------------------------------------------

export const trackerSyncEvents = new EventEmitter();

/** Build the emit channel name for a project. Exported so both sides stay in sync. */
export function trackerProjectChannel(projectId: number): string {
  return `tracker-project-${projectId}`;
}

/**
 * What changed on a connection. Deliberately a NOTIFICATION, not a payload: the
 * renderer re-reads whichever query the `kind` invalidates rather than trying to
 * patch a card from an event.
 *
 *  - 'connection' — the connection row itself (connect / settings / disconnect /
 *    an auth failure pausing it).
 *  - 'sync'       — a pass finished and persisted its log.
 *  - 'conflicts'  — conflicts were opened or resolved.
 */
export interface TrackerChangedEvent {
  projectId: number;
  connectionId: string;
  kind: 'connection' | 'sync' | 'conflicts';
}
