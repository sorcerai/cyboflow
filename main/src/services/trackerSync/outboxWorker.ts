/**
 * trackerSync/outboxWorker — the only place in the sync engine that performs a
 * remote WRITE. Design: docs/proposals/tracker-sync-integration.md
 * ("Durability & failure semantics" #1).
 *
 * writeBack.ts turns entity changes into durable `tracker_outbox` rows; this
 * module drains them against a provider adapter. The contract that makes the
 * whole thing crash-safe:
 *
 *   - A row is CLAIMED (pending -> in_flight, attempts++) before its API call,
 *     so a crash mid-flight is distinguishable from "never attempted". At boot
 *     the service calls store.requeueInFlightAsAmbiguous, and
 *     {@link processAmbiguous} reconciles those rows (point lookup by client
 *     key where the provider has idempotent creates, list-and-match where it
 *     does not) BEFORE any retry — a sub-issue can never be double-created.
 *     A LIVE drain parks lost creates in that same `ambiguous` state (see the
 *     failure taxonomy below), so the guarantee does not depend on a crash.
 *   - Only the ADAPTER CALL is wrapped in try/catch. Anything that throws
 *     AFTER a successful send (a sqlite failure while recording the outcome)
 *     propagates out of the drain with the row still `in_flight`, which is
 *     exactly right: the remote write happened, so the row must NOT be
 *     retried, and boot recovery will reconcile it.
 *   - Every successful state write stamps the written state onto the link's
 *     `baseline_json` (see {@link WriteBackBaselineStamp}), so the inbound
 *     poller diffs our own write to "no change" and never echoes it back.
 *
 *   - A claimed state write is dropped unsent when a NEWER unsettled write for
 *     the same issue exists (see {@link isSuperseded}), so a delayed retry can
 *     never regress the remote past a decision the user has already replaced.
 *
 * Failure taxonomy:
 *   - TrackerAuthError            -> connection paused, drain STOPS, and the row is
 *                                    HELD unsettled (see {@link pauseConnection}) so a
 *                                    key rotation replays it rather than losing it.
 *   - Other 4xx (not 408/429)     -> terminal failure; a malformed/forbidden write
 *                                    will never succeed on retry.
 *   - 5xx / 408 / 429 / network   -> retry, next_attempt_at = now + min(2^attempts, 32) min.
 *   - …the same, on a create the provider cannot make idempotent (Plane)
 *                                 -> `ambiguous`, NEVER a blind retry. Those errors say
 *                                    "outcome unknown", and a create that landed before
 *                                    its response was lost would be duplicated by the
 *                                    next POST — so the row waits for
 *                                    {@link processAmbiguous}'s client-key lookup.
 */
import type Database from 'better-sqlite3';
import type {
  EntityExternalLinkRow,
  TrackerConnectionRow,
  TrackerOutboxRow,
} from '../../database/models';
import type {
  TrackerIssue,
  TrackerNarrowKind,
  TrackerProvider,
  TrackerSourceSelection,
  TrackerState,
} from '../../../../shared/types/trackerSync';
import type { EntityCategory, Priority } from '../../../../shared/types/tasks';
import type { IssueContentPatch, IssueDraft, TrackerAdapter } from './adapterTypes';
import { TrackerApiError, TrackerAuthError } from './errors';
import {
  claimNextPending,
  findCreateClientKey,
  getConnection,
  listUnresolvedOutbox,
  markOrphaned,
  resolveOutbox,
  updateBaseline,
  updateConnectionSettings,
  upsertLink,
  getLinkByExternal,
} from './store';
import {
  parseJsonObject,
  readArchivedWrittenAt,
  readDesiredGroup,
  type ArchiveBaselineStamp,
  type CreateSubIssuePayload,
  type WriteBackBaselineStamp,
  type WriteBackGroup,
} from './writeBack';
import {
  pickWriteBackState,
  resolveEffectiveMapping,
  resolveStageIds,
  stageIdToWriteBackGroup,
} from './stateMapping';
import {
  joinBody,
  normalizeDescription,
  splitBody,
  type EntityWriteRouter,
} from './inboundSync';
import {
  isPriority,
  providerPriorityToken,
  seedDefaultPriorityMapping,
  providerTokensEqual,
  resolveEffectivePriorityMapping,
  type PriorityMapping,
} from './priorityMapping';
import {
  isCategory,
  providerCategoryToken,
  providerSupportsCategorySync,
  resolveEffectiveCategoryMapping,
  type CategoryMapping,
} from './categoryMapping';
import { appendRecoveryMarker } from './recoveryMarker';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface OutboxDeps {
  db: Database.Database;
  /** Build (or reuse) the provider client for a connection — decrypts the stored key. */
  adapterFor(connection: TrackerConnectionRow): TrackerAdapter;
  /**
   * The entity-write chokepoint — the SAME structural slice of TaskChangeRouter
   * the inbound pass takes. This module writes exactly one local field, on
   * exactly one occasion: aligning a body with the description the provider
   * actually stored for a create (see {@link alignLocalDescription}). Everything
   * else it touches is tracker bookkeeping, which belongs to store.ts.
   */
  router: EntityWriteRouter;
  /**
   * Current timestamp. Normalized to sqlite's `datetime('now')` shape
   * ('YYYY-MM-DD HH:MM:SS', UTC) before it is compared against or written to
   * any timestamp column, so a caller passing a JS ISO string still orders
   * correctly against the schema's own defaults.
   */
  nowIso(): string;
}

export interface OutboxReport {
  /** `update_state` / `close_parent` rows successfully written to the tracker. */
  sent: number;
  /** Issues created — mirrored children AND pushed ideas, including ones ADOPTED by ambiguous recovery. */
  created: number;
  /**
   * The `create_issue` subset of {@link created} — top-level issues created for
   * pushed local ideas. Split out so the sync log can word a pushed idea as
   * "pushed", not mislabel it a mirrored sub-issue.
   */
  pushedIdeas: number;
  /** `update_content` rows whose patch actually reached the tracker. */
  contentWritten: number;
  /**
   * `update_content` rows withheld by the pre-send divergence check: the
   * tracker's current value for a patched field no longer matches the baseline,
   * so a concurrent remote edit exists and sending would silently overwrite it.
   * The row settles unsent and the next inbound pass surfaces the conflict.
   */
  contentWithheld: number;
  /** `archive_issue` rows the provider confirmed (a 404 counts — the twin was already gone). */
  archived: number;
  /** Rows that will never be retried (4xx, unresolvable state, malformed payload). */
  failedTerminal: number;
  /** Rows re-queued with a backoff `next_attempt_at`. */
  retriesScheduled: number;
  /** Rows moved OUT of `ambiguous` (adopted as done, or returned to pending). */
  ambiguousResolved: number;
  /** Stale state writes settled unsent because a newer one supersedes them (see {@link isSuperseded}). */
  superseded: number;
  /**
   * Recovered creates whose ORIGINATING IDEA is gone or archived: the remote
   * issue exists and nothing local may point at it, so it is left orphaned in
   * the tracker and reported here for the connected view's log.
   */
  orphanedCreates: number;
  /** The connection was paused by an auth failure and the drain stopped early. */
  authPaused: boolean;
}

function emptyReport(): OutboxReport {
  return {
    sent: 0,
    created: 0,
    pushedIdeas: 0,
    contentWritten: 0,
    contentWithheld: 0,
    archived: 0,
    failedTerminal: 0,
    retriesScheduled: 0,
    ambiguousResolved: 0,
    superseded: 0,
    orphanedCreates: 0,
    authPaused: false,
  };
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** Longest backoff between attempts, in minutes (2^attempts, clamped). */
const MAX_BACKOFF_MINUTES = 32;

/**
 * Normalize a timestamp to sqlite's `datetime('now')` shape. store.ts compares
 * `next_attempt_at <= now` as STRINGS, so a JS ISO-8601 value ('…T…Z') and a
 * schema-default value ('… …') must never be compared against each other —
 * 'T' > ' ' would make a future retry look due. Everything this module writes
 * or compares passes through here first.
 */
export function toSqliteUtc(value: string): string {
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

/** `base` + `minutes`, in the sqlite timestamp shape. */
function addMinutes(base: string, minutes: number): string {
  const normalized = base.includes('T') ? base : `${base.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return base;
  return new Date(parsed.getTime() + minutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

/**
 * Drain every eligible pending row for one connection, oldest first, until the
 * queue is empty (or an auth failure pauses the connection).
 *
 * `allowedKinds` is the DIRECTION-MODE gate (migration 094): the caller passes
 * the kinds whose direction is running this pass, and every other row is simply
 * not claimed — it stays `pending`, in order, until a pass whose filter includes
 * it comes along. Omitting the argument drains everything. An EMPTY array is a
 * legitimate "every direction is held" and drains nothing.
 *
 * The provider's state list is fetched at most ONCE per drain and shared by
 * every state write in it.
 */
export async function drainOutbox(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  allowedKinds?: readonly TrackerOutboxRow['kind'][],
): Promise<OutboxReport> {
  const report = emptyReport();
  const adapter = deps.adapterFor(connection);
  const states = new StateCache(adapter, connection);
  const fields = new FieldMappingCache(adapter, connection);

  for (;;) {
    // Re-read the connection's status before EVERY claim, not just once at the
    // top of the drain. `disconnect` is the user's stop lever, and an
    // `archive_issue` row is destructive — sending it after the user has
    // already hit disconnect (or an auth pause landed mid-drain) is exactly
    // the write they were trying to stop. The service's phase-boundary guard
    // (trackerSyncService.ts's isStillActive) only re-checks BETWEEN passes,
    // which cannot see a disconnect that lands while a single drain is
    // mid-flight and still holding the decrypted adapter across many
    // iterations — so the drain must make this check itself. A row not yet
    // claimed is left `pending`, untouched, for whatever runs next.
    if (getConnection(deps.db, connection.id)?.status !== 'active') break;
    const row = claimNextPending(deps.db, connection.id, toSqliteUtc(deps.nowIso()), allowedKinds);
    if (!row) break;
    const halted = await processRow(deps, connection, adapter, states, fields, row, report);
    if (halted) break;
  }
  return report;
}

/**
 * Handle one claimed row. Returns true when the drain must STOP (auth failure
 * -> the connection is paused and every remaining row would fail the same way).
 */
async function processRow(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  states: StateCache,
  fields: FieldMappingCache,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  if (row.kind === 'create_sub_issue') {
    return await processCreate(deps, connection, adapter, fields, row, report);
  }
  if (row.kind === 'create_issue') {
    return await processPush(deps, connection, adapter, states, fields, row, report);
  }
  if (row.kind === 'update_content') {
    return await processContentWrite(deps, connection, adapter, fields, row, report);
  }
  if (row.kind === 'archive_issue') {
    return await processArchive(deps, connection, adapter, row, report);
  }
  return await processStateWrite(deps, connection, adapter, states, row, report);
}

/**
 * WHICH KINDS CAN SUPERSEDE A CLAIMED ROW OF EACH KIND — the supersession
 * matrix, as a `Record` so a new outbox kind fails to compile here (invariant 8
 * of docs/proposals/tracker-field-writeback.md) instead of silently inheriting
 * whichever branch an if/else fell through to.
 *
 * THREE RULES, and the reasoning behind each:
 *
 *  - STATUS KINDS SUPERSEDE EACH OTHER. `update_state` and `close_parent` both
 *    move ONE issue's state, so a later row of either kind states the truth the
 *    earlier one is now wrong about — the original rule, unchanged.
 *  - CONTENT AND STATE NEVER CROSS. They are orthogonal statements about the
 *    same issue: one moves its status, the other its text. Letting either
 *    settle the other would silently drop a write nothing else will re-derive.
 *  - `archive_issue` SUPERSEDES EVERYTHING, the one legitimate cross-kind
 *    sweep, and nothing supersedes it back. Once the twin is bound for the
 *    tracker's trash, a state or content write against it is not just
 *    redundant — a backoff that let one drain AFTERWARDS would resurrect the
 *    issue into a listing.
 *
 * Creates are listed with EMPTY sets. They cannot participate either way: a
 * create carries a null `external_id`, which is the key the whole mechanism is
 * scoped by, and adopting one is how an issue GETS an external id in the first
 * place.
 */
const SUPERSEDING_KINDS: Record<
  TrackerOutboxRow['kind'],
  readonly TrackerOutboxRow['kind'][]
> = {
  update_state: ['update_state', 'close_parent', 'archive_issue'],
  close_parent: ['update_state', 'close_parent', 'archive_issue'],
  update_content: ['update_content', 'archive_issue'],
  archive_issue: ['archive_issue'],
  create_sub_issue: [],
  create_issue: [],
};

/**
 * Is this claimed row STALE — does a NEWER unsettled write that SUPERSEDES it
 * (see {@link SUPERSEDING_KINDS}) already exist for the same issue?
 *
 * THE BACKSTOP HALF of supersession, not the primary one. The ordering hazard
 * is fixed where both rows are knowable — at ENQUEUE, in
 * store.supersedeQueuedWrites, which is the only moment that can see a newer
 * write that has already LANDED and settled. This check enforces the same
 * invariant at the point of USE, for a row that never met that sweep: anything
 * queued before this behaviour existed, or by an enqueue path added later that
 * forgets to call it. Redundant on the ordinary path, and deliberately so — the
 * cost is one already-cheap query per claimed row, and the failure it prevents
 * is silent.
 *
 * Newer means a higher autoincrement `id`; unsettled means
 * pending/in_flight/ambiguous, so a row that already failed terminally cannot
 * supersede anything.
 *
 * CRASH-SAFE by the existing state machine: the decision is made on a row we
 * have just CLAIMED, under the same exclusion the send would have had. A crash
 * between this check and the settle leaves the row `in_flight`, boot recovery
 * demotes it to `ambiguous`, and {@link resolveAmbiguous} returns a non-create
 * straight to `pending` — where the next claim asks the same question again,
 * against data that is by then even fresher. Nothing is lost, nothing is sent
 * twice.
 */
function isSuperseded(
  db: Database.Database,
  connectionId: string,
  row: TrackerOutboxRow,
): boolean {
  if (row.external_id === null) return false;
  const supersedingKinds = SUPERSEDING_KINDS[row.kind];
  if (supersedingKinds.length === 0) return false;
  return listUnresolvedOutbox(db, connectionId).some(
    (other) =>
      other.id > row.id &&
      other.external_id === row.external_id &&
      supersedingKinds.includes(other.kind),
  );
}

/**
 * Settle a claimed row that a newer write has replaced. `done`, not `failed`: a
 * superseded write is not a problem, it is an instruction the user has already
 * replaced. Sending it would be the bug.
 */
function settleSuperseded(deps: OutboxDeps, row: TrackerOutboxRow, report: OutboxReport): void {
  resolveOutbox(deps.db, row.id, 'done', {
    lastError: `superseded by a newer write for the same issue`,
  });
  report.superseded += 1;
}

/** `update_state` / `close_parent`: resolve the provider state, write it, stamp the baseline. */
async function processStateWrite(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  states: StateCache,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  if (isSuperseded(deps.db, connection.id, row)) {
    settleSuperseded(deps, row, report);
    return false;
  }

  const desiredGroup = readDesiredGroup(row.payload_json);
  if (desiredGroup === null || row.external_id === null) {
    failTerminal(deps, row, report, 'malformed payload: desiredGroup / external_id missing');
    return false;
  }

  let state: TrackerState | null;
  try {
    const loaded = await states.load();
    // The mapping is passed so an explicit 'indev' pin can name the started
    // state instead of falling back to the adapter's group inference.
    state = pickWriteBackState(
      loaded,
      desiredGroup,
      resolveEffectiveMapping(loaded, connection.state_mapping_json),
    );
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err);
  }
  if (state === null) {
    failTerminal(deps, row, report, `no provider state maps to the '${desiredGroup}' group`);
    return false;
  }

  const externalId = row.external_id;
  try {
    await adapter.updateIssueState(externalId, state.id);
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err);
  }

  // Past the send: everything below is local bookkeeping, deliberately OUTSIDE
  // the catch (see the file header — a throw here must leave the row in_flight
  // for boot recovery, never schedule a retry of a write that already landed).
  resolveOutbox(deps.db, row.id, 'done');
  report.sent += 1;
  stampWriteBackBaseline(deps, connection, externalId, state.id, desiredGroup);
  return false;
}

// ---------------------------------------------------------------------------
// update_content — the CONTENT write-back
// ---------------------------------------------------------------------------

/** The entity columns a content patch is composed from. */
interface ContentEntity {
  title: string;
  body: string | null;
  priority: Priority;
  category: EntityCategory;
}

/**
 * `update_content`: compose the patch from the entity AS IT STANDS NOW, send
 * it, then stamp the link's baseline from the PROVIDER'S OWN RESPONSE.
 *
 * COMPOSED HERE, not at enqueue time (writeBack.UPDATE_CONTENT_PAYLOAD_JSON):
 * a content row can wait — 'manual' content sync is the whole point of the
 * mode — and a burst of edits collapses onto one pending row, so the tracker
 * should receive the text the entity HAS, not the text it had when the first
 * keystroke landed.
 *
 * THE PATCH IS A DIFF, not a snapshot. Only fields that actually differ from
 * the baseline are sent, because `IssueContentPatch` treats an absent field as
 * "leave alone" and sending an unchanged one would bump the remote's
 * `updatedAt` for nothing — pulling the issue back into the next inbound
 * window with no change in it.
 *
 * THE STAMP COMES FROM THE RESPONSE (invariant 1), never from what we sent.
 * Providers normalize: Dart reflows markdown, Plane round-trips a body through
 * plaintext-ified html, and both may Title-case a priority token we sent in
 * lower case. A baseline stamped with the SENT values would differ from the
 * remote's own copy on the very next inbound pass, which reads as a remote
 * edit — the echo this whole mechanism exists to suppress.
 *
 * FOUR SETTLE-WITHOUT-SENDING CASES, all `done` rather than `failed`, because
 * nothing went wrong in any of them: the row is superseded, the link is gone or
 * orphaned (the entity stopped syncing while the row waited), the entity itself
 * is gone or archived (the last thing the user said about it was "take it
 * away"), or the diff came out empty (an inbound pass already merged the change
 * this row was queued for, or the live mapping can no longer express it).
 */
async function processContentWrite(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  fields: FieldMappingCache,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  if (isSuperseded(deps.db, connection.id, row)) {
    settleSuperseded(deps, row, report);
    return false;
  }
  if (row.external_id === null || row.entity_id === null || row.entity_type === null) {
    failTerminal(deps, row, report, 'malformed row: external_id / entity_id / entity_type missing');
    return false;
  }
  const entityType = asLinkedEntityType(row.entity_type);
  if (entityType === null) {
    failTerminal(deps, row, report, `unsupported entity_type '${row.entity_type}' for a content write`);
    return false;
  }

  const externalId = row.external_id;
  const link = getLinkByExternal(deps.db, connection.id, externalId);
  if (link === null || link.orphaned_at !== null) {
    resolveOutbox(deps.db, row.id, 'done', {
      lastError: 'the entity is no longer linked to this issue',
    });
    return false;
  }

  const entity = readContentEntity(deps.db, entityType, row.entity_id);
  if (entity === null) {
    resolveOutbox(deps.db, row.id, 'done', {
      lastError: 'the entity is gone or archived — nothing left to write',
    });
    return false;
  }

  let patch: IssueContentPatch;
  let sentDescription: string | null | undefined;
  try {
    const mappings = await fields.load();
    const composed = composeContentPatch(deps.db, connection, adapter, link, entity, mappings);
    patch = composed.patch;
    sentDescription = composed.sentDescription;
  } catch (err) {
    // The field-option fetch is the only thing here that can throw, and it has
    // sent nothing — an ordinary backoff retry is safe.
    return recordAdapterFailure(deps, connection, row, report, err);
  }

  if (Object.keys(patch).length === 0) {
    resolveOutbox(deps.db, row.id, 'done', {
      lastError: 'nothing left to write — the entity already agrees with the baseline',
    });
    return false;
  }

  // THE LOST-UPDATE GUARD. The patch above was composed against the last
  // STAMPED baseline, but a tracker-side edit since that stamp is invisible
  // here: full passes drain writes BEFORE the inbound fetch, and the debounced
  // drain never fetches at all. Sending anyway would overwrite the remote edit
  // and then stamp the response as the new baseline — erasing the only evidence
  // a conflict ever existed, beyond even Manual mode's reach. So the issue is
  // re-read and every field THIS patch touches is compared against the
  // baseline: any mismatch is a concurrent remote edit, and the write is
  // withheld WITHOUT stamping. Local ≠ baseline ≠ remote then holds, which is
  // exactly the shape the next inbound pass's conflict machinery consumes
  // (auto: remote wins + convergence; manual: queued for the human). The
  // read-to-send window is still a race, but it is milliseconds where the pass
  // cadence was minutes — and none of the three providers offers a conditional
  // write to close it outright.
  let current: TrackerIssue | null;
  try {
    current = await adapter.getIssue(externalId);
  } catch (err) {
    // Nothing has been sent — an ordinary backoff retry is safe.
    return recordAdapterFailure(deps, connection, row, report, err);
  }
  if (current === null) {
    resolveOutbox(deps.db, row.id, 'done', {
      lastError: 'the issue is gone remotely — nothing to write onto',
    });
    return false;
  }
  const diverged = contentDivergence(patch, parseJsonObject(link.baseline_json), current);
  if (diverged.length > 0) {
    resolveOutbox(deps.db, row.id, 'done', {
      lastError: `withheld: concurrent tracker edit on ${diverged.join(', ')} — the next inbound pass resolves the conflict`,
    });
    report.contentWithheld += 1;
    return false;
  }

  let written: TrackerIssue | null;
  try {
    written = await adapter.updateIssueContent(externalId, patch);
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err);
  }

  // Past the send: local bookkeeping only, deliberately OUTSIDE the catch (see
  // the file header — a throw here must leave nothing that could re-send).
  resolveOutbox(deps.db, row.id, 'done');
  report.contentWritten += 1;
  const settled = written ?? (await rereadAfterBlindWrite(deps, connection, adapter, externalId));
  if (settled === null) return false;
  stampContentBaseline(deps, connection, externalId, settled, patch);
  await alignLocalDescription(deps, connection, entityType, row.entity_id, settled, sentDescription);
  return false;
}

/**
 * The post-write issue when the adapter returned nothing.
 *
 * UNREACHABLE BY THE SEAM'S OWN CONTRACT — every adapter here documents that
 * its write echoes the updated object, and `TrackerAdapter.updateIssueContent`
 * reserves `null` for a provider that genuinely returns none. So this is a LOUD
 * diagnostic first and a fallback second: without a post-write snapshot the
 * baseline cannot be stamped, and an unstamped write is precisely the echo that
 * re-opens as a phantom remote edit on the next pass.
 *
 * The re-read is swallowed on failure rather than thrown: the row is already
 * settled `done` and the remote write already landed, so there is nothing left
 * to retry and letting this abort the whole drain would punish every row behind
 * it. The cost of giving up here is one phantom conflict, which the user can
 * resolve; the cost of throwing is a stalled queue.
 */
async function rereadAfterBlindWrite(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  externalId: string,
): Promise<TrackerIssue | null> {
  console.error(
    `[trackerSync/outboxWorker] ${connection.provider} updateIssueContent returned no issue for ` +
      `${externalId}; the echo-suppression stamp needs one — falling back to a re-read`,
  );
  try {
    return await adapter.getIssue(externalId);
  } catch {
    return null;
  }
}

/**
 * The `IssueContentPatch` for one link: every synced field whose LOCAL value
 * now differs from the baseline, and nothing else.
 *
 * PROVIDER SPACE FOR THE MAPPED FIELDS (invariant 2) — the local priority and
 * category are mapped OUT and compared as tokens, case-insensitively, exactly
 * as the inbound merge compares them. A local-space comparison would send a P3
 * as `medium` and read the echo back as P2.
 *
 * AN ABSENT BASELINE KEY SENDS NOTHING (invariant 3): `undefined` means the
 * field was never synced, so there is no evidence the remote disagrees, and
 * pushing our value over a value we have never seen is the outbound face of the
 * conflict the backfill arm exists to avoid.
 *
 * CAPABILITY-GATED PER FIELD, from the adapter's own declaration rather than a
 * provider check: `category` never reaches Linear or Plane, which have no issue
 * type to put it on.
 *
 * A NULL PRIORITY TOKEN IS ONLY SENT WHERE IT MEANS SOMETHING. Dart spells "no
 * priority" by omitting the field, so `null` is a real value to write there;
 * Linear's `'0'` and Plane's `'none'` are ordinary rungs of their enums, so a
 * null token on those providers means the mapping could not express the local
 * level at all — and sending it would clear a priority the user never asked to
 * clear. That case is skipped, and the inbound pass's unmapped-value warning is
 * what tells the user their mapping needs attention.
 *
 * `sentDescription` is what the body write puts on the wire WITHOUT the
 * recovery marker — the text the response is compared against by
 * {@link alignLocalDescription}, which sees the marker-stripped description the
 * adapter returns.
 */
function composeContentPatch(
  db: Database.Database,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  link: EntityExternalLinkRow,
  entity: ContentEntity,
  mappings: FieldMappings,
): { patch: IssueContentPatch; sentDescription: string | null | undefined } {
  const baseline = parseJsonObject(link.baseline_json);
  const writable = adapter.capabilities.contentWrite;
  const patch: IssueContentPatch = {};
  let sentDescription: string | null | undefined;

  if (writable.title && typeof baseline.title === 'string' && baseline.title !== entity.title) {
    patch.title = entity.title;
  }

  if (writable.description && 'description' in baseline) {
    const remote = typeof baseline.description === 'string' ? baseline.description : null;
    const { description } = splitBody(entity.body);
    if (normalizeDescription(description) !== normalizeDescription(remote)) {
      sentDescription = description;
      patch.description = withRecoveryMarker(db, connection, link, description);
    }
  }

  if (writable.priority && 'priority' in baseline) {
    const token = writablePriorityToken(connection.provider, mappings.priority, entity.priority);
    const stored = typeof baseline.priority === 'string' ? baseline.priority : null;
    // `undefined` is "the mapping cannot express this level" — never a clear.
    if (token !== undefined && !providerTokensEqual(token, stored)) patch.priority = token;
  }

  if (
    writable.category &&
    providerSupportsCategorySync(connection.provider) &&
    'category' in baseline
  ) {
    const token = providerCategoryToken(mappings.category, entity.category);
    const stored = typeof baseline.category === 'string' ? baseline.category : null;
    // An unmapped category has no token to send, and inventing one would be a
    // 400 on Dart (probe D3) — so it is simply left alone.
    if (token !== null && !providerTokensEqual(token, stored)) patch.category = token;
  }

  return { patch, sentDescription };
}

/**
 * The fields of `patch` whose CURRENT remote value no longer matches the
 * baseline — i.e. the fields a concurrent tracker edit has moved since the
 * last stamp. Only patched fields are examined: a remote edit to a field this
 * write does not touch is not endangered by it (every provider takes partial
 * patches), and blocking on it would deadlock disjoint edits.
 *
 * Comparison semantics deliberately MIRROR {@link composeContentPatch}'s own
 * diffs — exact string for title, {@link normalizeDescription} for the
 * description, case-insensitive provider tokens for priority/category — so
 * "diverged" here means precisely "compose would have produced a different
 * patch had the baseline been current".
 */
function contentDivergence(
  patch: IssueContentPatch,
  baseline: Record<string, unknown>,
  current: TrackerIssue,
): string[] {
  const diverged: string[] = [];
  if (patch.title !== undefined) {
    const stored = typeof baseline.title === 'string' ? baseline.title : null;
    if (current.title !== stored) diverged.push('title');
  }
  if (patch.description !== undefined) {
    const stored = typeof baseline.description === 'string' ? baseline.description : null;
    if (normalizeDescription(current.description) !== normalizeDescription(stored)) {
      diverged.push('description');
    }
  }
  if (patch.priority !== undefined) {
    const stored = typeof baseline.priority === 'string' ? baseline.priority : null;
    if (!providerTokensEqual(current.priority, stored)) diverged.push('priority');
  }
  if (patch.category !== undefined) {
    const stored = typeof baseline.category === 'string' ? baseline.category : null;
    if (!providerTokensEqual(current.category, stored)) diverged.push('category');
  }
  return diverged;
}

/**
 * The body to SEND for a description write: the local description with this
 * link's `cyboflow-sync` recovery marker re-appended (invariant 4).
 *
 * WHY THE MARKER CANNOT JUST RIDE ALONG. The adapters STRIP it from every
 * description they return, so the local body has never held it — meaning a
 * write of the local text verbatim ERASES it from the remote issue. That breaks
 * `findIssueByClientKey`'s absence proof ("no candidate carries this key ⇒ the
 * create never landed") for this link forever after, and the next create whose
 * response is lost gets duplicated instead of adopted.
 *
 * The key is not on the link — it is the client key of the CREATE that minted
 * the issue, which only the outbox row records. An issue this connection
 * IMPORTED never had a marker and gets none now: `findCreateClientKey` answers
 * null and the body is sent as-is.
 *
 * A provider with idempotent creates (Linear) stamps no marker at all — its
 * client key IS the issue id — so the lookup answers null there by construction
 * and this is a no-op.
 */
function withRecoveryMarker(
  db: Database.Database,
  connection: TrackerConnectionRow,
  link: EntityExternalLinkRow,
  description: string | null,
): string | null {
  const clientKey = findCreateClientKey(db, connection.id, link.entity_type, link.entity_id);
  if (clientKey === null) return description;
  return appendRecoveryMarker(description, clientKey);
}

/**
 * Stamp our own content write onto the link's baseline (ECHO SUPPRESSION): the
 * next inbound pass sees the remote's fields equal to the baseline's and reads
 * "unchanged" instead of a remote edit.
 *
 * ONLY THE FIELDS WE WROTE, merged onto the blob. The rest of the baseline
 * belongs to the inbound half (and to the state stamp), and a wholesale replace
 * here would drop `lastWrittenGroup` and re-queue a state write we already made
 * — the `composeBaselineJson` discipline, applied from the outbound side.
 *
 * `priority`/`category` are stamped from the RESPONSE too, and that matters
 * more than it looks: Dart echoes a Title-case token for the lower-case one it
 * was sent, so stamping the sent value would leave a baseline the provider's
 * own reads disagree with (case-insensitively equal, but a mismatch the moment
 * anything compares them literally).
 */
function stampContentBaseline(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  externalId: string,
  issue: TrackerIssue,
  patch: IssueContentPatch,
): void {
  const link = getLinkByExternal(deps.db, connection.id, externalId);
  if (!link) return;
  const stamp: Record<string, unknown> = { lastWrittenAt: toSqliteUtc(deps.nowIso()) };
  if (patch.title !== undefined) stamp.title = issue.title;
  if (patch.description !== undefined) stamp.description = issue.description;
  if (patch.priority !== undefined) stamp.priority = issue.priority;
  if (patch.category !== undefined) stamp.category = issue.category;
  updateBaseline(
    deps.db,
    link.id,
    JSON.stringify({ ...parseJsonObject(link.baseline_json), ...stamp }),
  );
}

/** One entity's content columns, or null when the row is gone or archived. */
function readContentEntity(
  db: Database.Database,
  entityType: 'idea' | 'task',
  entityId: string,
): ContentEntity | null {
  const table = entityType === 'idea' ? 'ideas' : 'tasks';
  const row = db
    .prepare(`SELECT title, body, priority, category, archived_at FROM ${table} WHERE id = ?`)
    .get(entityId) as (ContentEntity & { archived_at: string | null }) | undefined;
  if (row === undefined || row.archived_at !== null) return null;
  return { title: row.title, body: row.body, priority: row.priority, category: row.category };
}

/** The two entity types a content write can address; epics are never linked. */
function asLinkedEntityType(value: string): 'idea' | 'task' | null {
  return value === 'idea' || value === 'task' ? value : null;
}

// ---------------------------------------------------------------------------
// archive_issue — the remote trash/archive
// ---------------------------------------------------------------------------

/**
 * `archive_issue`: trash the remote twin, then take the link out of sync.
 *
 * A 404 IS SUCCESS, and it is the adapters that own that (each documents how
 * its provider signals "already gone"). The state this write is trying to reach
 * is "the issue is not in anyone's listing"; a twin somebody already trashed is
 * in exactly that state, so treating it as a failure would strand the row and,
 * through the kind-agnostic inbound blocker, halt the pass at that issue.
 *
 * ALREADY-STAMPED ROWS SETTLE UNSENT. `archivedWrittenAt` on the baseline says
 * we have already told this provider to trash the issue; a second row (a
 * replayed event, a ruling that raced the listener) has nothing to add.
 *
 * ORPHANING THE LINK IS THE LAST STEP, and only after the provider CONFIRMS.
 * An orphaned link is invisible to every trigger and to the inbound merge, so
 * orphaning first would make a failed archive unretryable and silently leave
 * the twin live in the tracker. On the ruled-removal path the link is already
 * orphaned before this runs — `markOrphaned` is idempotent, and the stamp is
 * what carries the idempotence either way.
 *
 * THE CAPABILITY CHECK is a guard against an unreachable state, not a routine
 * branch: every enqueue site gates on the provider having an archive endpoint,
 * so a row that gets here for an `archive: 'none'` provider means an enqueue
 * site forgot to — which fails terminally with a diagnostic rather than calling
 * an adapter that can only throw.
 */
async function processArchive(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  if (isSuperseded(deps.db, connection.id, row)) {
    settleSuperseded(deps, row, report);
    return false;
  }
  if (row.external_id === null) {
    failTerminal(deps, row, report, 'malformed row: external_id missing');
    return false;
  }
  if (adapter.capabilities.archive === 'none') {
    failTerminal(
      deps,
      row,
      report,
      `${connection.provider} has no archive endpoint — this row should never have been enqueued`,
    );
    return false;
  }

  const externalId = row.external_id;
  const link = getLinkByExternal(deps.db, connection.id, externalId);
  if (link !== null && readArchivedWrittenAt(link) !== null) {
    resolveOutbox(deps.db, row.id, 'done', { lastError: 'already archived remotely' });
    return false;
  }

  try {
    await adapter.archiveIssue(externalId);
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err);
  }

  resolveOutbox(deps.db, row.id, 'done');
  report.archived += 1;
  if (link !== null) {
    const stamp: ArchiveBaselineStamp = { archivedWrittenAt: toSqliteUtc(deps.nowIso()) };
    updateBaseline(
      deps.db,
      link.id,
      JSON.stringify({ ...parseJsonObject(link.baseline_json), ...stamp }),
    );
    markOrphaned(deps.db, link.id);
  }
  return false;
}

/** `create_sub_issue`: create the issue, then link it. */
async function processCreate(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  fields: FieldMappingCache,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  const payload = readCreatePayload(row);
  if (payload === null || row.entity_id === null || row.client_key === null) {
    failTerminal(deps, row, report, 'malformed payload: parentExternalId / entity_id / client_key missing');
    return false;
  }

  // THE LOCAL VALUES ARE SNAPSHOTTED, THE MAPPING IS RESOLVED NOW. The payload
  // carries the task's `priority`/`category` as the decomposition saw them —
  // the same moment its title and description were captured, so the whole draft
  // speaks for one instant — while the provider TOKENS they translate to can
  // only be resolved against the workspace's live vocabulary, which exists
  // here. A row queued before those keys existed carries neither, and
  // {@link mappedDraftFields} is simply not consulted for it.
  let mapped: Pick<IssueDraft, 'priority' | 'category'> = {};
  if (payload.priority !== null && payload.category !== null) {
    try {
      mapped = mappedDraftFields(adapter, connection, await fields.load(), {
        priority: payload.priority,
        category: payload.category,
      });
    } catch (err) {
      // The field-option fetch; nothing has been sent, so a plain retry is safe.
      return recordAdapterFailure(deps, connection, row, report, err);
    }
  }

  let issue: TrackerIssue;
  try {
    issue = await adapter.createSubIssue(
      payload.parentExternalId,
      { title: payload.title, description: payload.description ?? undefined, ...mapped },
      row.client_key,
    );
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err, {
      // A create is the one write that cannot be repeated safely. Where the
      // provider has no idempotency key (Plane), an uncertain failure may well
      // have committed the child before the response was lost, so the row parks
      // as `ambiguous` and the marker lookup — not a second POST — decides.
      // Linear's client key IS the created issue's id, so a repeat is a no-op
      // there and the plain backoff retry stands.
      uncertainIsAmbiguous: !adapter.capabilities.idempotentCreate,
    });
  }

  await adoptCreatedIssue(deps, connection, row, issue, payload.parentExternalId, payload.description);
  report.created += 1;
  return false;
}

/**
 * Record a created (or recovered) sub-issue: link it, snapshot its baseline,
 * settle the outbox row, then align the local body with what the provider
 * stored. Post-send bookkeeping — never inside a catch.
 *
 * `sentDescription` is what the create actually PUT ON THE WIRE, or undefined
 * when that is unknowable (no path has that gap today: a sub-issue's draft
 * description is the payload's, on the live and the recovery path alike). See
 * {@link alignLocalDescription} for why the comparison is against the sent text
 * rather than the local body.
 */
async function adoptCreatedIssue(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  issue: TrackerIssue,
  parentExternalId: string,
  sentDescription: string | null | undefined,
): Promise<void> {
  upsertLink(deps.db, {
    connection_id: connection.id,
    entity_type: 'task',
    entity_id: row.entity_id as string,
    provider: connection.provider,
    external_id: issue.externalId,
    external_identifier: issue.identifier,
    external_url: issue.url,
    external_parent_id: parentExternalId,
    baseline_json: JSON.stringify(baselineSnapshot(issue)),
  });
  resolveOutbox(deps.db, row.id, 'done');
  await alignLocalDescription(deps, connection, 'task', row.entity_id as string, issue, sentDescription);
}

// ---------------------------------------------------------------------------
// create_issue — the PUSH direction
// ---------------------------------------------------------------------------

/** The idea columns a pushed draft is composed from. */
interface PushableIdea {
  title: string;
  body: string | null;
  stage_id: string;
  archived_at: string | null;
  /** Both columns are NOT NULL with defaults on every entity table (migs 015/059). */
  priority: Priority;
  category: EntityCategory;
}

/**
 * `create_issue`: file the idea as a TOP-LEVEL issue in the connection's source
 * container, then link it.
 *
 * THE DRAFT IS COMPOSED HERE, not at enqueue time (see
 * writeBack.CREATE_ISSUE_PAYLOAD_JSON): a push can wait a long time when
 * `push_mode` is 'manual', and the tracker should receive the idea as it stands
 * when the user asks for the sync, not as it was first typed.
 *
 * AN IDEA THAT NO LONGER EXISTS — hard-deleted, or archived while the push
 * waited — settles the row DONE with no remote write. The user's last statement
 * about that idea was "take it away", and honouring a stale intent by filing it
 * into a shared workspace is the one outcome nobody can undo from here.
 */
async function processPush(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  states: StateCache,
  fields: FieldMappingCache,
  row: TrackerOutboxRow,
  report: OutboxReport,
): Promise<boolean> {
  if (row.entity_id === null || row.client_key === null) {
    failTerminal(deps, row, report, 'malformed row: entity_id / client_key missing');
    return false;
  }
  const selection = parseSelection(connection);
  if (selection === null) {
    failTerminal(deps, row, report, 'connection has no source selected to create an issue in');
    return false;
  }

  const idea = readPushableIdea(deps.db, row.entity_id);
  if (idea === null || idea.archived_at !== null) {
    // Settled, not failed: there is nothing left to push and nothing went wrong.
    resolveOutbox(deps.db, row.id, 'done');
    return false;
  }

  let draft: IssueDraft;
  let providerStates: TrackerState[];
  try {
    providerStates = await states.load();
    draft = composePushDraft(deps, connection, adapter, idea, providerStates, await fields.load());
  } catch (err) {
    // Covers the state fetch, the field-option fetch AND the local board-stage
    // resolution; none has sent anything, so a backoff retry is safe.
    return recordAdapterFailure(deps, connection, row, report, err);
  }

  let issue: TrackerIssue;
  try {
    issue = await adapter.createIssue(selection, draft, row.client_key);
  } catch (err) {
    return recordAdapterFailure(deps, connection, row, report, err, {
      // Identical reasoning to a sub-issue create: where the provider has no
      // idempotency key (Plane) an uncertain failure may already have filed the
      // issue, so the marker lookup — not a second POST — decides.
      uncertainIsAmbiguous: !adapter.capabilities.idempotentCreate,
    });
  }

  await adoptPushedIssue(
    deps,
    connection,
    row,
    issue,
    groupOfState(providerStates, issue.stateId),
    draft.description ?? null,
  );
  report.created += 1;
  report.pushedIdeas += 1;
  return false;
}

/**
 * The draft for a pushed idea: its CURRENT title and description, with the
 * provenance footer split off (an idea that carries one is not pushed at all —
 * this is belt-and-braces so a marker can never reach a remote body), plus the
 * provider state its board stage implies.
 *
 * INITIAL STATE. The idea's stage maps to a write-back group exactly as a stage
 * MOVE would (In development → started, Done → completed, Won't do →
 * cancelled); every other stage means "filed, not started", which is the
 * `backlog` group. A workspace with no state in the resolved group leaves
 * `stateId` unset and takes the provider's own default — for a create that is a
 * reasonable answer, unlike a state WRITE where the state is the entire point.
 *
 * PRIORITY AND CATEGORY RIDE ALONG (see {@link mappedDraftFields}), and filing
 * them WITH the create rather than in a follow-up write is what keeps the
 * link's first baseline honest: the issue comes back carrying the tokens we
 * asked for, {@link baselineSnapshot} records those, and the next local change
 * to either field diffs against something real instead of against an absence.
 */
function composePushDraft(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  adapter: TrackerAdapter,
  idea: PushableIdea,
  states: TrackerState[],
  mappings: FieldMappings,
): IssueDraft {
  const stageIds = resolveStageIds(deps.db, connection.project_id);
  const group = stageIdToWriteBackGroup(idea.stage_id, stageIds) ?? 'backlog';
  const state = pickWriteBackState(
    states,
    group,
    resolveEffectiveMapping(states, connection.state_mapping_json),
  );
  const { description } = splitBody(idea.body);
  return {
    title: idea.title,
    description: description ?? undefined,
    stateId: state?.id,
    ...mappedDraftFields(adapter, connection, mappings, idea),
  };
}

/**
 * Record a pushed issue: link the idea to it, seed the baseline from the issue
 * as created, and settle the row. Post-send bookkeeping — never inside a catch.
 *
 * `group` is the group the issue ACTUALLY landed in (read back off its own
 * `stateId`, not off what we asked for), stamped as `lastWrittenGroup` so a
 * later local move to that same stage recognizes the tracker as already there
 * and queues nothing. A group outside the three write-back ones — the ordinary
 * case, a freshly-filed idea in `backlog` — stamps NOTHING, because a stale key
 * there would suppress the first genuine Done/Won't-do write-back.
 *
 * `sentDescription` is the draft description this push put on the wire, or
 * undefined on the RECOVERY path, which cannot know it: the row carries no
 * payload (the draft is composed at drain time from an idea that may have moved
 * on since), so there is nothing to compare the returned body against and the
 * alignment stands down. See {@link alignLocalDescription}.
 */
async function adoptPushedIssue(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  issue: TrackerIssue,
  group: WriteBackGroup | null,
  sentDescription: string | null | undefined,
): Promise<void> {
  const snapshot = baselineSnapshot(issue);
  upsertLink(deps.db, {
    connection_id: connection.id,
    entity_type: 'idea',
    entity_id: row.entity_id as string,
    provider: connection.provider,
    external_id: issue.externalId,
    external_identifier: issue.identifier,
    external_url: issue.url,
    external_parent_id: issue.parentExternalId,
    baseline_json: JSON.stringify(
      group === null ? snapshot : { ...snapshot, lastWrittenGroup: group },
    ),
  });
  resolveOutbox(deps.db, row.id, 'done');
  await alignLocalDescription(deps, connection, 'idea', row.entity_id as string, issue, sentDescription);
}

/**
 * AFTER A CREATE OR A BODY WRITE, MAKE THE LOCAL BODY SAY WHAT THE BASELINE SAYS.
 *
 * A provider is free to normalize the markdown it stores, and Dart MEASURABLY
 * does (dartAdapter.ts's SYNC_MARKER_RE note: it re-emits emphasis runs,
 * reflows lists and linkifies dotted tokens); Plane round-trips a body through
 * plaintext-ified html, which is lossier still. Every path that stamps a
 * baseline from a write RESPONSE therefore records the NORMALIZED text, while
 * the local entity keeps the text the user authored. Left alone the two
 * disagree from the moment of the write, and the disagreement is silent until
 * the remote description genuinely changes: inboundSync's three-way merge then
 * diffs the new remote against a baseline the local body never matched, reads
 * "both sides moved", and — in Manual mode — opens a conflict the user cannot
 * make sense of, or in Auto mode whole-field-replaces the local body with the
 * provider's mangled copy.
 *
 * Aligning here converts that latent corruption into an immediate, attributable
 * correction: one `body` write through the entity chokepoint, attributed to the
 * PROVIDER actor, visible in the entity's event log the moment it happens.
 *
 * THE COMPARISON IS AGAINST WHAT WE SENT, not against the local body. They
 * differ exactly when the user edited the entity between enqueue and drain —
 * and there the local text is NEWER than our write, so overwriting it with the
 * echo would discard a real edit. Equal-after-normalization counts as
 * agreement, because that is precisely what the merge counts as agreement (see
 * normalizeDescription): a difference it would never diff on is a local event
 * with nothing behind it. The sent text is the UN-MARKERED description — the
 * adapters strip the recovery marker from everything they return, so comparing
 * against the markered body we put on the wire would report a difference on
 * every single write.
 *
 * ORDER: strictly last, after the link and after the row is settled `done`. A
 * throw here (a deleted entity, a sqlite failure) propagates like any other
 * post-send bookkeeping failure — see the file header — and because the row is
 * already settled it can never cause the write to be re-sent. The cost of that
 * failure is the baseline divergence we have today, not a duplicate issue.
 *
 * NO OUTBOUND ECHO — but the reason CHANGED when the content trigger landed,
 * and it is no longer structural. writeBack.route now HAS a content trigger,
 * and this write does move a field it watches; what stops the loop is the
 * ACTOR FILTER: `applyChange` runs as `actor: connection.provider`, and the
 * trigger skips provider-authored events outright. The baseline diff is the
 * backstop underneath that — the very write this alignment mirrors has already
 * stamped the baseline from the same response, so even an unattributed replay
 * of this event finds the entity and the baseline in agreement and queues
 * nothing. (An entity sitting in a write-back stage can still enqueue one
 * redundant, idempotent state write off this event — bounded at one by the
 * `lastWrittenGroup` stamp the very same write records.)
 */
async function alignLocalDescription(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  entityType: 'idea' | 'task',
  entityId: string,
  issue: TrackerIssue,
  sentDescription: string | null | undefined,
): Promise<void> {
  // Unknowable (the recovery push path) or absent: nothing to compare against,
  // and a provider that returned no description at all has said nothing about
  // what it stored.
  if (sentDescription === undefined || issue.description === null) return;
  if (normalizeDescription(issue.description) === normalizeDescription(sentDescription)) return;

  const body = readEntityBody(deps.db, entityType, entityId);
  if (body === undefined) return;
  const { description: current, footer } = splitBody(body);

  // THE ENTITY MUST STILL HOLD THE TEXT WE SENT. Everything above compares the
  // RESPONSE against what went on the wire; this compares the wire against what
  // the entity says NOW, and they diverge exactly when the user edited between
  // the send and this line — a window the content path makes ordinary rather
  // than rare, since a pending-only dedupe deliberately enqueues a SUCCESSOR
  // row for an edit that lands while a write is in flight.
  //
  // Aligning there would overwrite the newer edit with the older write's echo,
  // and the damage would not stop at one field: the successor row composes its
  // patch from the body it finds, so it would faithfully push the clobbered
  // text to the tracker and make the loss permanent on both sides.
  //
  // SKIPPING IS SAFE, and is not merely the lesser evil. The alignment exists
  // to stop a baseline (stamped from the provider's normalized text) from
  // silently disagreeing with a local body nothing will ever push back — and
  // the successor row is exactly the thing that pushes it back. It sends the
  // newer text, stamps the baseline from THAT response, and runs this alignment
  // again against a body it can vouch for. The only case we give up is a
  // normalization difference on text the user has already replaced, which no
  // later diff can act on.
  if (normalizeDescription(current) !== normalizeDescription(sentDescription)) return;

  // The footer is cyboflow's half of the body and belongs to no provider —
  // preserved exactly as an inbound merge would preserve it.
  await deps.router.applyChange(connection.project_id, {
    actor: connection.provider,
    entityType,
    taskId: entityId,
    fields: { body: joinBody(issue.description, footer) },
  });
}

/** One entity's stored body, or undefined when the row is gone. */
function readEntityBody(
  db: Database.Database,
  entityType: 'idea' | 'task',
  entityId: string,
): string | null | undefined {
  const table = entityType === 'idea' ? 'ideas' : 'tasks';
  const row = db.prepare(`SELECT body FROM ${table} WHERE id = ?`).get(entityId) as
    | { body: string | null }
    | undefined;
  return row === undefined ? undefined : row.body;
}

/** An idea's pushable columns, or null when the row is gone. */
function readPushableIdea(db: Database.Database, ideaId: string): PushableIdea | null {
  const row = db
    .prepare('SELECT title, body, stage_id, archived_at, priority, category FROM ideas WHERE id = ?')
    .get(ideaId) as PushableIdea | undefined;
  return row ?? null;
}

/** The write-back group a provider state belongs to, or null when it has none. */
function groupOfState(states: TrackerState[], stateId: string): WriteBackGroup | null {
  const group = states.find((state) => state.id === stateId)?.group;
  return group === 'started' || group === 'completed' || group === 'cancelled' ? group : null;
}

// ---------------------------------------------------------------------------
// Ambiguous recovery
// ---------------------------------------------------------------------------

/**
 * What {@link resolveAmbiguous} did with a row:
 *   - `adopted`    — the write HAD landed; the row is done and its issue linked.
 *   - `orphaned`   — the write HAD landed, but the entity that asked for it is
 *                    gone or archived; the row is settled with NO link and the
 *                    stranded remote issue is reported (see {@link adoptOrOrphanPush}).
 *   - `requeued`   — the write did NOT land; the row is pending again (safe to retry).
 *   - `unresolved` — still unknown (the reconciling lookup itself failed); stays ambiguous.
 *   - `failed`     — unusable row, settled terminally.
 *   - `halted`     — auth failure: the connection is paused, the row is left
 *                    UNSETTLED, and the pass stops.
 */
export type AmbiguousOutcome =
  | 'adopted'
  | 'orphaned'
  | 'requeued'
  | 'unresolved'
  | 'failed'
  | 'halted';

/**
 * Reconcile every `ambiguous` row for a connection — writes whose outcome is
 * genuinely unknown, from either source: store.requeueInFlightAsAmbiguous
 * produces them at boot from a crash mid-flight, and a live drain parks a
 * non-idempotent create there when its call fails uncertainly. The service
 * calls this BEFORE {@link drainOutbox} so a lost create is adopted rather
 * than repeated.
 */
export async function processAmbiguous(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
): Promise<OutboxReport> {
  const report = emptyReport();
  const rows = listUnresolvedOutbox(deps.db, connection.id).filter((row) => row.state === 'ambiguous');

  for (const row of rows) {
    const outcome = await resolveAmbiguous(deps, connection, row);
    if (outcome === 'adopted') {
      report.created += 1;
      if (row.kind === 'create_issue') report.pushedIdeas += 1;
      report.ambiguousResolved += 1;
    } else if (outcome === 'orphaned') {
      report.orphanedCreates += 1;
      report.ambiguousResolved += 1;
    } else if (outcome === 'requeued') {
      report.ambiguousResolved += 1;
    } else if (outcome === 'failed') {
      report.failedTerminal += 1;
      report.ambiguousResolved += 1;
    } else if (outcome === 'halted') {
      // NOT a terminal failure: the row is deliberately left unsettled so it
      // replays once the credentials are fixed (see {@link pauseConnection}).
      report.authPaused = true;
      break;
    }
  }
  return report;
}

/**
 * Reconcile ONE ambiguous row:
 *   - `create_sub_issue` + `capabilities.idempotentCreate` (Linear): the client
 *     key IS the issue id, so a point lookup settles it — found means the create
 *     landed, missing means it never did and a retry is safe.
 *   - `create_sub_issue` without idempotent creates (Plane): ask the adapter for
 *     the child of this parent carrying the row's client key (see
 *     {@link ClientKeyRecoverableAdapter}) — same two answers, same guarantee.
 *   - EVERY OTHER KIND is idempotent by nature and goes straight back to
 *     pending, where the drain simply performs it again:
 *       · `update_state` / `close_parent` — writing a state twice is writing it
 *         once.
 *       · `update_content` — the row carries no payload at all, so the retry
 *         RE-COMPOSES from the entity as it stands and re-diffs against the
 *         baseline. If the lost write actually landed, its own inbound echo (or
 *         the re-composed diff) leaves nothing to send and the row settles with
 *         no request; if it did not, the retry is the write.
 *       · `archive_issue` — a 404 on the second attempt IS success (the twin
 *         was already trashed), which is exactly the ambiguity this state
 *         exists for, resolved by the write rather than by a lookup.
 *     Only a CREATE can be duplicated by a blind retry, which is why only
 *     creates take the lookup path below.
 *
 * A failed lookup leaves the row `ambiguous` (returning it to pending is only
 * safe once we KNOW the write did not land — otherwise a retry duplicates the
 * sub-issue), except an auth failure, which pauses the connection and halts.
 */
export async function resolveAmbiguous(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
): Promise<AmbiguousOutcome> {
  if (row.kind !== 'create_sub_issue' && row.kind !== 'create_issue') {
    requeue(deps, row);
    return 'requeued';
  }

  // A sub-issue create carries its parent in the payload; a push carries no
  // payload at all and is scoped by the connection's own source selection.
  const payload = row.kind === 'create_sub_issue' ? readCreatePayload(row) : null;
  const selection = row.kind === 'create_issue' ? parseSelection(connection) : null;
  if (row.entity_id === null || row.client_key === null) {
    resolveOutbox(deps.db, row.id, 'failed', { lastError: 'malformed row: entity_id / client_key missing' });
    return 'failed';
  }
  if (row.kind === 'create_sub_issue' && payload === null) {
    resolveOutbox(deps.db, row.id, 'failed', {
      lastError: 'malformed payload: parentExternalId missing',
    });
    return 'failed';
  }
  if (row.kind === 'create_issue' && selection === null) {
    resolveOutbox(deps.db, row.id, 'failed', {
      lastError: 'connection has no source selected to search for the created issue in',
    });
    return 'failed';
  }

  const adapter = deps.adapterFor(connection);
  const clientKey = row.client_key;
  let found: TrackerIssue | null;
  try {
    found = adapter.capabilities.idempotentCreate
      ? await adapter.getIssue(clientKey)
      : await findByClientKey(adapter, connection, clientKey, {
          // A sub-issue lives in its parent's container, so the parent both
          // scopes and constrains the search; a top-level push is scoped by the
          // selection's container with NO parent constraint. The narrow KIND
          // rides along so the adapter never has to guess what the container
          // id names — a Dart SPACE and a Dart board can share a title, and a
          // wrong guess searches the wrong boards and re-creates a committed
          // create.
          containerId: selection?.containerId ?? null,
          narrowKind: selection?.narrowKind ?? null,
          parentExternalId: payload?.parentExternalId ?? null,
          // A cost bound, not a correctness one — see {@link recoveryScanFloor}.
          updatedAfterIso: recoveryScanFloor(row),
        });
  } catch (err) {
    if (err instanceof TrackerAuthError) {
      // The row stays `ambiguous` — its outcome is still genuinely unknown, and
      // the auth failure told us nothing about it. Returning it to `pending`
      // would let a retry duplicate a create the first attempt may already have
      // committed. See {@link pauseConnection} for the same "hold, do not
      // terminalize" reasoning on the drain side.
      resolveOutbox(deps.db, row.id, 'ambiguous', { lastError: describeError(err) });
      updateConnectionSettings(deps.db, connection.id, { status: 'paused' });
      return 'halted';
    }
    // Outcome still unknown -> stay ambiguous, record why, try again next pass.
    resolveOutbox(deps.db, row.id, 'ambiguous', { lastError: describeError(err) });
    return 'unresolved';
  }

  if (found === null) {
    requeue(deps, row);
    return 'requeued';
  }

  if (payload !== null) {
    await adoptCreatedIssue(deps, connection, row, found, payload.parentExternalId, payload.description);
    return 'adopted';
  }
  return await adoptOrOrphanPush(deps, connection, row, found);
}

/**
 * Finish a RECOVERED top-level push: link the created issue back to the idea
 * that asked for it — or, when that idea is gone, settle the row and leave the
 * issue orphaned.
 *
 * WHY THE RE-READ. The remote create already committed; only its response was
 * lost. Between then and this recovery pass — which can be a whole app restart
 * later — the user may well have deleted or archived the idea, and the ordinary
 * push path treats exactly that as "there is nothing left to push"
 * ({@link processPush}). Adopting regardless would write an ACTIVE link to an
 * entity that is archived (inbound sync would then keep mutating something the
 * user retired) or to no entity at all (a permanent zombie link the poller
 * finds, fails to resolve, and skips on every pass forever).
 *
 * WHAT ORPHANING MEANS. The row settles `done` — nothing failed, and there is
 * nothing left to attempt — with the reason recorded on the row, and the count
 * surfaces in the connected view's log. We do NOT delete or cancel the remote
 * issue: this module never hard-deletes on someone else's tracker, and the
 * user's local removal never said anything about an issue they did not know had
 * been created. Discoverable and reversible by hand beats tidy and destructive.
 *
 * NO `lastWrittenGroup` STAMP on the adopt path, deliberately: reading the
 * issue's group back would cost a state-list round trip on a rare recovery, and
 * its only effect is suppressing ONE redundant (idempotent) state write the next
 * time this idea moves. The sub-issue adopt path makes the same trade.
 */
async function adoptOrOrphanPush(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  issue: TrackerIssue,
): Promise<AmbiguousOutcome> {
  const idea = row.entity_id === null ? null : readPushableIdea(deps.db, row.entity_id);
  if (idea === null || idea.archived_at !== null) {
    resolveOutbox(deps.db, row.id, 'done', {
      lastError:
        `the idea this issue was created for is ${idea === null ? 'gone' : 'archived'}; ` +
        `${issue.identifier} (${issue.url}) was left in the tracker, unlinked`,
    });
    return 'orphaned';
  }
  // `undefined`, not null: what this push sent is genuinely unknown here — see
  // {@link adoptPushedIssue}.
  await adoptPushedIssue(deps, connection, row, issue, null, undefined);
  return 'adopted';
}

/**
 * Recovery seam for a provider whose creates are NOT natively idempotent
 * (Plane): the adapter stamps the outbox row's client key into every issue it
 * creates and can therefore point at the one child of a parent that is ours.
 *
 * Deliberately not on `TrackerAdapter`: the marker carrying the key is provider
 * plumbing that the adapter strips from every description it returns (so it
 * never lands in a local body or a merge baseline), which is exactly why this
 * match cannot be done here over a mapped `TrackerIssue`.
 */
interface ClientKeyRecoverableAdapter {
  findIssueByClientKey(
    scope: {
      containerId: string | null;
      /** What `containerId` names (the selection's narrow kind), or null when only a parent scopes the search. */
      narrowKind: TrackerNarrowKind | null;
      parentExternalId: string | null;
      /**
       * A floor on the candidates' remote `updatedAt` (see
       * {@link recoveryScanFloor}) — the adapter may skip anything older
       * outright. OPTIONAL: an adapter free to ignore it still searches its
       * whole scope, which is only slower, never wrong.
       */
      updatedAfterIso?: string | null;
    },
    clientKey: string,
  ): Promise<TrackerIssue | null>;
}

/**
 * How far BEFORE the outbox row was written a landed create's `updatedAt` is
 * still believed. A whole day, deliberately: the row's `created_at` is OUR
 * clock and `updated_at` is the PROVIDER'S, and the two are related by nothing
 * stronger than both parties roughly knowing the time. Missing the real task
 * re-creates the duplicate this entire mechanism exists to prevent, whereas a
 * floor that is a day too generous just leaves a few more candidates in the
 * scan.
 */
const RECOVERY_SCAN_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * The earliest remote `updatedAt` a task created by THIS row could carry: the
 * row's own enqueue time, less {@link RECOVERY_SCAN_SKEW_MS}. A create cannot
 * have touched anything before it was queued, so everything older than this is
 * a candidate no recovery scan needs to fetch details for.
 *
 * Returns undefined for a row whose timestamp will not parse — an unbounded
 * scan is the correct fallback, since the alternative is a floor derived from a
 * value nobody can vouch for.
 */
function recoveryScanFloor(row: TrackerOutboxRow): string | undefined {
  const raw = row.created_at;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const parsed = new Date(raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return new Date(parsed.getTime() - RECOVERY_SCAN_SKEW_MS).toISOString();
}

function supportsClientKeyRecovery(
  adapter: TrackerAdapter,
): adapter is TrackerAdapter & ClientKeyRecoverableAdapter {
  const candidate = adapter as Partial<ClientKeyRecoverableAdapter>;
  return typeof candidate.findIssueByClientKey === 'function';
}

/**
 * Match the candidate issues on the row's CLIENT KEY, never on the title: a
 * container routinely holds two issues with the same title, and adopting the
 * wrong one would link the entity to an unrelated issue and point every later
 * write-back at it. Because the adapter stamps the key into every create, "none
 * carries it" means our create never landed and the retry is safe.
 *
 * `scope.parentExternalId` narrows a mirrored sub-issue to one parent's
 * children; a top-level push passes null and searches the container instead.
 * Exactly one of the two is always present, and the ADAPTER decides which it
 * needs: a sub-issue's container is implicit in its parent's external id, which
 * only the adapter may parse (`TrackerIssue.externalId` is adapter-opaque by
 * contract).
 *
 * Throws when the adapter cannot match by client key at all — "cannot look it
 * up" must NOT read as "it isn't there", or the retry would duplicate the
 * issue.
 */
async function findByClientKey(
  adapter: TrackerAdapter,
  connection: TrackerConnectionRow,
  clientKey: string,
  scope: {
    containerId: string | null;
    narrowKind: TrackerNarrowKind | null;
    parentExternalId: string | null;
    updatedAfterIso?: string | null;
  },
): Promise<TrackerIssue | null> {
  if (!supportsClientKeyRecovery(adapter)) {
    throw new TrackerApiError(
      connection.provider,
      'adapter has neither idempotent creates nor client-key recovery',
    );
  }
  return await adapter.findIssueByClientKey(scope, clientKey);
}

/**
 * Put a row back in the pending queue, eligible immediately. `lastError`
 * defaults to whatever the row already carried — a requeue is not itself a new
 * failure — and is passed explicitly when the requeue IS the response to one
 * (see {@link pauseConnection}).
 */
function requeue(deps: OutboxDeps, row: TrackerOutboxRow, lastError?: string): void {
  resolveOutbox(deps.db, row.id, 'failed', {
    lastError: lastError ?? row.last_error,
    nextAttemptAtIso: toSqliteUtc(deps.nowIso()),
  });
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/**
 * Settle a failed adapter call. Returns true when the DRAIN must stop (auth).
 * Auth failures pause the connection and HOLD the row (see
 * {@link pauseConnection}); other client errors are terminal; everything
 * else — 5xx, 408/429, a network error with no status at all — leaves the
 * outcome UNKNOWN and is re-queued with exponential backoff.
 *
 * `opts.uncertainIsAmbiguous` redirects that last arm for the one write that
 * cannot be repeated blind (a create on a provider without idempotent creates):
 * the row settles as `ambiguous` instead, so the client-key lookup runs before
 * any re-POST. That ordering holds by construction — every pass runs
 * {@link processAmbiguous} ahead of {@link drainOutbox}, and `ambiguous` is not
 * a state {@link claimNextPending} will ever claim, so the row simply cannot be
 * re-sent until the reconcile has spoken. The reconcile pass supplies its own
 * cadence, which is why no backoff is stamped here. It still counts as a
 * scheduled retry in the report: from the queue's side the write is unsettled
 * and headed back to pending if the lookup says the create never landed.
 */
function recordAdapterFailure(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  report: OutboxReport,
  err: unknown,
  opts: { uncertainIsAmbiguous?: boolean } = {},
): boolean {
  if (err instanceof TrackerAuthError) {
    pauseConnection(deps, connection, row, report, err);
    return true;
  }
  if (isTerminalApiError(err)) {
    failTerminal(deps, row, report, describeError(err));
    return false;
  }
  if (opts.uncertainIsAmbiguous) {
    resolveOutbox(deps.db, row.id, 'ambiguous', { lastError: describeError(err) });
    report.retriesScheduled += 1;
    return false;
  }
  // `attempts` was already incremented by claimNextPending, so the first
  // failure waits 2 minutes and the ceiling is MAX_BACKOFF_MINUTES.
  const delay = Math.min(2 ** row.attempts, MAX_BACKOFF_MINUTES);
  resolveOutbox(deps.db, row.id, 'failed', {
    lastError: describeError(err),
    nextAttemptAtIso: addMinutes(deps.nowIso(), delay),
  });
  report.retriesScheduled += 1;
  return false;
}

/**
 * A 4xx that is not a rate limit / timeout will fail identically forever
 * (malformed write, deleted issue, revoked scope) — retrying it just burns the
 * queue, so it settles terminally and surfaces in the connected view's log.
 */
function isTerminalApiError(err: unknown): boolean {
  if (!(err instanceof TrackerApiError)) return false;
  const status = err.status;
  if (status === null) return false;
  if (status === 408 || status === 429) return false;
  return status >= 400 && status < 500;
}

function failTerminal(deps: OutboxDeps, row: TrackerOutboxRow, report: OutboxReport, message: string): void {
  resolveOutbox(deps.db, row.id, 'failed', { lastError: message });
  report.failedTerminal += 1;
}

/**
 * A 401/403: the CREDENTIALS are wrong, the write is not. Pause the connection
 * and HOLD the row — pending, no backoff — so it replays verbatim once the user
 * rotates the key.
 *
 * TERMINALIZING IT INSTEAD LOSES REAL WORK, which is why this is not the
 * ordinary 4xx path it superficially resembles. A revoked or rotated API key is
 * routine, and it rejects EVERY queued write at once: mirrored sub-issue
 * creates, the stage moves recording that a story shipped, a user's explicit
 * "cancel this in Linear". None of those are re-derivable — writeBack only
 * enqueues on the entity EVENT, which is long past — so a terminal failure
 * silently drops the lot, and the tracker stays permanently behind with no
 * indication of what went missing.
 *
 * NO BACKOFF CHURN comes for free from the pause: `next_attempt_at` is cleared
 * (the row is eligible the instant the connection is usable again), and every
 * entry point into a drain — the tick, "Sync now", the debounced write-back
 * nudge — refuses a non-`active` connection, so nothing claims the row in the
 * meantime. The drain also stops here (this returns true), because every
 * remaining row would fail identically.
 */
function pauseConnection(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  row: TrackerOutboxRow,
  report: OutboxReport,
  err: TrackerAuthError,
): void {
  requeue(deps, row, describeError(err));
  updateConnectionSettings(deps.db, connection.id, { status: 'paused' });
  report.retriesScheduled += 1;
  report.authPaused = true;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Baseline + payload helpers
// ---------------------------------------------------------------------------

/**
 * Fetch-once-per-drain provider state list. Every state write in a drain wants
 * the same list, and both providers charge a round trip for it.
 */
class StateCache {
  private states: TrackerState[] | null = null;

  constructor(
    private readonly adapter: TrackerAdapter,
    private readonly connection: TrackerConnectionRow,
  ) {}

  async load(): Promise<TrackerState[]> {
    if (this.states !== null) return this.states;
    const selection = parseSelection(this.connection);
    if (selection === null) {
      // No source selected: nothing can map, so every state write in this
      // drain settles terminally with a clear reason.
      this.states = [];
      return this.states;
    }
    this.states = await this.adapter.listStates(selection);
    return this.states;
  }
}

/** The two mapped-field translations a content write composes through. */
interface FieldMappings {
  priority: PriorityMapping;
  category: CategoryMapping;
}

/**
 * Fetch-once-per-drain field mappings — the sibling of {@link StateCache}, and
 * for the same reason: every content write in a drain wants the same two, and
 * the option list behind them costs a round trip on the one provider that has a
 * live vocabulary (Dart's `/config`; Linear and Plane state fixed scales).
 *
 * RESOLVED AGAINST THE LIVE LIST, unlike the TRIGGER's own resolution, which
 * has no adapter and passes null. That asymmetry is deliberate and this is the
 * authoritative side: a Dart workspace that renamed a priority out from under a
 * persisted mapping resolves that level to NO TOKEN here, so the patch simply
 * omits the field instead of sending a value Dart would 400 on (probe D1) —
 * while the trigger, working from the seed, may have optimistically enqueued a
 * row for it. A row that composes to nothing settles `done`, unsent.
 */
class FieldMappingCache {
  private mappings: FieldMappings | null = null;

  constructor(
    private readonly adapter: TrackerAdapter,
    private readonly connection: TrackerConnectionRow,
  ) {}

  async load(): Promise<FieldMappings> {
    if (this.mappings !== null) return this.mappings;
    const options = await this.adapter.listFieldOptions();
    this.mappings = {
      priority: resolveEffectivePriorityMapping(
        this.connection.provider,
        options.priorities,
        this.connection.priority_mapping_json,
      ),
      category: resolveEffectiveCategoryMapping(
        this.connection.provider,
        options.categories,
        this.connection.category_mapping_json,
      ),
    };
    return this.mappings;
  }
}

/**
 * The connection's persisted source selection, or null when it is unset/corrupt.
 *
 * Reads `source_json` — the wizard's Step-1 source choice (container +
 * narrow), the same column inboundSync.parseSourceSelection reads. NOT
 * `selection_json`, which holds the Step-2 TASKS selection payload
 * (assignee/manual id lists) and never carries container/narrow ids.
 *
 * `pushContainerId` matters MOST here: it is what a Dart space group's create
 * is filed against, since the selection's own `containerId` is a space name no
 * issue can be created in. Dropping it would leave the adapter to guess a
 * board.
 */
function parseSelection(connection: TrackerConnectionRow): TrackerSourceSelection | null {
  const parsed = parseJsonObject(connection.source_json);
  const { containerId, narrowId, narrowKind, pushContainerId } = parsed;
  if (typeof containerId !== 'string' || typeof narrowId !== 'string' || typeof narrowKind !== 'string') {
    return null;
  }
  const selection = { containerId, narrowId, narrowKind } as TrackerSourceSelection;
  if (typeof pushContainerId === 'string') selection.pushContainerId = pushContainerId;
  return selection;
}

/** Typed read of a `create_sub_issue` payload, or null when it is unusable. */
function readCreatePayload(row: TrackerOutboxRow): CreateSubIssuePayload | null {
  const parsed = parseJsonObject(row.payload_json);
  const { parentExternalId, title, description, priority, category } = parsed;
  if (typeof parentExternalId !== 'string' || typeof title !== 'string') return null;
  return {
    parentExternalId,
    title,
    description: typeof description === 'string' ? description : null,
    // NARROWED, not cast: a row written by an older build carries neither key,
    // and a hand-edited one could carry anything. Either way an unusable value
    // reads as null and the draft simply omits the field.
    priority: isPriority(priority) ? priority : null,
    category: isCategory(category) ? category : null,
  };
}

/**
 * The last-synced field snapshot the conflict engine three-way-merges against.
 *
 * `priority` and `category` are emitted UNCONDITIONALLY, including as null, and
 * that is load-bearing rather than tidy. `TrackerBaseline` treats an ABSENT key
 * as "never synced" and stands the whole field down for that link (invariant 3,
 * the backfill arm) — so a create that seeded a baseline without them would
 * leave every entity it links unable to diff those fields until an inbound pass
 * happened to overlay a fresh snapshot. Worse for the OUTBOUND half: the
 * content trigger reads the same absence as "no evidence the remote disagrees"
 * and declines to enqueue, so the first local priority change after a push
 * would silently never reach the tracker.
 *
 * The values come from the issue the provider RETURNED, like every other key
 * here — the same post-normalizer stamp source invariant 1 requires.
 */
function baselineSnapshot(issue: TrackerIssue): Record<string, unknown> {
  return {
    stateId: issue.stateId,
    title: issue.title,
    description: issue.description,
    updatedAt: issue.updatedAt,
    priority: issue.priority,
    category: issue.category,
  };
}

/**
 * The provider token to WRITE for a local priority, or `undefined` when the
 * mapping cannot express it at all.
 *
 * A NULL TOKEN IS TWO DIFFERENT ANSWERS WEARING THE SAME SHAPE, and telling
 * them apart is the whole reason this exists:
 *
 *   - "this level MEANS no priority" — Dart spells an unset priority by
 *     omitting the field, so P6 legitimately maps to null and writing null is
 *     how the user's P6 reaches the tracker;
 *   - "this level has no token" — the workspace renamed the value the mapping
 *     named (Dart addresses priorities BY TITLE), or the provider's scale
 *     never had one.
 *
 * Conflating them clears a priority the user never asked to clear: an
 * unmappable P0 would go out as "unset" and DEMOTE the issue.
 *
 * THE DISCRIMINATOR IS THE CANONICAL SEED, not the effective mapping, and that
 * distinction is the entire subtlety. Asking the EFFECTIVE mapping "which level
 * means unset" (`localPriorityForToken(mapping, null)`) is unsound precisely
 * when it matters: once a rename has degraded a level to no token, that lookup
 * returns whichever null-mapped level it happens to scan first — the broken one
 * — and reports the unmappable P0 as the unset level. The seed resolved with NO
 * live list cannot be degraded, so it answers the provider-static question this
 * actually needs: does this level mean "no priority" ON THIS PROVIDER? (Dart's
 * P6 does; Linear and Plane have no such level, their unset rung being a real
 * token.)
 *
 * A user OVERLAY that deliberately points a level at null is therefore read as
 * "do not sync this level" rather than "clear it remotely" — the reading that
 * cannot destroy a value nobody asked to destroy.
 */
function writablePriorityToken(
  provider: TrackerProvider,
  mapping: PriorityMapping,
  priority: Priority,
): string | null | undefined {
  const token = providerPriorityToken(mapping, priority);
  if (token !== null) return token;
  const canonical = seedDefaultPriorityMapping(provider, null);
  return providerPriorityToken(canonical, priority) === null ? null : undefined;
}

/**
 * The MAPPED half of a create draft: the entity's local priority and category
 * translated into the provider's own tokens.
 *
 * OMITTED, NEVER GUESSED. `IssueDraft` reads an absent field as "let the
 * provider default apply", which is the honest answer whenever the mapping
 * cannot express the local value — a workspace that renamed the token away, or
 * one that models no matching type at all. Sending a token the provider does
 * not know is a 400 on Dart (probe D3) and a silent drop elsewhere, and neither
 * is better than its default.
 *
 * CATEGORY IS DOUBLE-GATED, on the adapter's declared capability AND on the
 * provider table: the capability is what the seam promises, and
 * `providerSupportsCategorySync` is what the mapping layer was seeded under.
 * They agree today (Dart only) and the redundancy is deliberate — this composes
 * a payload that goes over the wire, so it gates on both rather than trusting
 * them to stay in step.
 */
function mappedDraftFields(
  adapter: TrackerAdapter,
  connection: TrackerConnectionRow,
  mappings: FieldMappings,
  entity: { priority: Priority; category: EntityCategory },
): Pick<IssueDraft, 'priority' | 'category'> {
  const fields: Pick<IssueDraft, 'priority' | 'category'> = {};

  if (adapter.capabilities.contentWrite.priority) {
    const token = writablePriorityToken(connection.provider, mappings.priority, entity.priority);
    if (token !== undefined) fields.priority = token;
  }

  if (
    adapter.capabilities.contentWrite.category &&
    providerSupportsCategorySync(connection.provider)
  ) {
    const token = providerCategoryToken(mappings.category, entity.category);
    if (token !== null) fields.category = token;
  }

  return fields;
}

/**
 * Stamp our own write onto the link's baseline (ECHO SUPPRESSION): the next
 * inbound pass sees the tracker's state equal to the baseline's and treats it
 * as unchanged instead of a remote edit. The rest of the baseline is preserved
 * — it belongs to the inbound half.
 *
 * A missing link is not an error: `close_parent` targets an issue whose link
 * may live under a different entity, and a first write can race the link's
 * creation. The next inbound pass rebuilds the baseline either way.
 */
function stampWriteBackBaseline(
  deps: OutboxDeps,
  connection: TrackerConnectionRow,
  externalId: string,
  stateId: string,
  group: WriteBackGroup,
): void {
  const link = getLinkByExternal(deps.db, connection.id, externalId);
  if (!link) return;
  const stamp: WriteBackBaselineStamp = {
    stateId,
    lastWrittenGroup: group,
    lastWrittenAt: toSqliteUtc(deps.nowIso()),
  };
  updateBaseline(deps.db, link.id, JSON.stringify({ ...parseJsonObject(link.baseline_json), ...stamp }));
}
