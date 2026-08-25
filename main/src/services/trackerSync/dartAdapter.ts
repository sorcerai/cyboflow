/**
 * DartAdapter — tracker-sync provider adapter for Dart (dartai.com). Design:
 * docs/proposals/tracker-sync-integration.md ("Provider adapter seam").
 *
 * Pure REST client: constructor-injected `FetchLike`, no sqlite, no retry
 * loops, no timers — durability (outbox, cursor, sweep) lives in the sync core,
 * not here. Every method that crosses the network throws only
 * `TrackerApiError`/`TrackerAuthError` (see errors.ts).
 *
 * Verified against Dart's published OpenAPI 3.1 spec
 * (https://app.dartai.com/api/v0/public/schema/, retrieved 2026-08-16) and, for
 * the behaviours the spec leaves open, against a LIVE Dart space on 2026-08-18.
 * Comments below say "measured" where the fact came from that live run rather
 * than from the spec — the two are not equally strong, and one of the spec's
 * silences (sub-issue placement) turned out to contradict the obvious reading.
 *
 * Three properties of that API shape almost every decision below, and none of
 * them has a Linear or Plane analogue:
 *
 * 1. DART ADDRESSES BY DISPLAY TITLE, NOT ID. `GET /config` — the ONLY
 *    discovery endpoint — returns `dartboards` and `statuses` as flat arrays of
 *    STRINGS, and `TaskCreate.dartboard`/`.status` take those same strings.
 *    Dartboard ids exist (`GET /dartboards/{id}`) but no endpoint ENUMERATES
 *    them, and a Task never carries one. So `TrackerSourceContainer.id` and
 *    `TrackerState.id` ARE the titles. A dartboard or status rename therefore
 *    invalidates a connection's persisted `source_json` selection and its
 *    `state_mapping_json` keys; nothing here can prevent that, so the failure is
 *    made loud rather than silent — see
 *    {@link DartAdapter.assertContainerExists}.
 * 2. LIST RESPONSES OMIT THE DESCRIPTION. `GET /tasks/list` returns
 *    `ConciseTask`, which drops exactly `description`, `attachments` and
 *    `taskRelationships`. The sync core three-way-merges on description and
 *    recovers lost creates through a marker embedded in it, so `listIssues`
 *    HYDRATES each row via `GET /tasks/{id}` — see {@link DartAdapter.hydrate}.
 *    `listIssueIds` (the deletion sweep) deliberately does not, since ids are
 *    on the concise shape already.
 * 3. STATUSES CARRY NO GROUPING. Dart exposes no state type/category, so
 *    {@link inferStateGroup} guesses from the name. That is a low-stakes guess
 *    BY CONSTRUCTION: `group` only SEEDS the wizard's mapping-table defaults
 *    (stateMapping.seedDefaultMapping), which the user then overrides; it never
 *    gates the sync itself.
 *
 * externalId is the bare 12-character Dart task id. Unlike Plane, no
 * compositing is needed: `/tasks/{id}` is not dartboard-scoped, so the id alone
 * addresses a task.
 *
 * A connection's source may also be a SPACE (`narrowKind: 'space'`), which Dart
 * models nowhere: it is the `"<Space>/<Board>"` title prefix, resolved to its
 * member boards from `/config` at call time — see
 * {@link DartAdapter.resolveScopeBoards}. Every scoped path below therefore
 * works over a LIST of dartboards, of which a plain board selection is the
 * one-element case.
 */

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerGroup,
  TrackerGroupSection,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerNarrowKind,
  TrackerState,
  TrackerStateGroup,
  TrackerIssue,
  TrackerUserRef,
} from '../../../../shared/types/trackerSync';
import type {
  TrackerAdapter,
  TrackerAdapterCapabilities,
  FetchLike,
  IssueDraft,
  IssueContentPatch,
  TrackerFieldOptionsRaw,
} from './adapterTypes';
import {
  TrackerApiError,
  TrackerAuthError,
  TRACKER_REQUEST_TIMEOUT_MS,
  describeTransportFailure,
} from './errors';
import { PROVIDER_ARCHIVE_CAPABILITY } from './providerCapabilities';
import { RECOVERY_MARKER_PREFIX, appendRecoveryMarker } from './recoveryMarker';

const PROVIDER: TrackerProvider = 'dart';
const API_BASE_URL = 'https://app.dartai.com/api/v0/public';
/** Dart's web UI origin — `Task.htmlUrl` is absolute, so this is only a fallback. */
const APP_ORIGIN = 'https://app.dartai.com';

const CAPABILITIES: TrackerAdapterCapabilities = {
  // Dart does not auto-close a parent when its subtasks complete, so the sync
  // core's close-parent write is the only path (same as Plane).
  nativeParentAutoClose: false,
  // Dart is cloud-only; there is no self-hosted origin to configure.
  selfHostedBaseUrl: false,
  // `TaskCreate` accepts no client-supplied id (`TaskId` is readOnly and server-
  // minted), so creates are not idempotent. Authorship is recovered from the
  // marker every create stamps into the description — see SYNC_MARKER_PREFIX
  // and {@link DartAdapter.findIssueByClientKey}.
  idempotentCreate: false,
  // Dart writes all four fields directly on `TaskUpdate` (D1/D3/D4 all green —
  // see the Phase 0 probe transcript in the field-writeback proposal) and has
  // a live workspace vocabulary for both priority and type, so nothing here is
  // unsupported.
  contentWrite: { title: true, description: true, priority: true, category: true },
  // `DELETE /tasks/{id}` trashes (probe D5: the item survives under
  // `in_trash=true`, not a hard delete) — one-way in this API (no restore
  // endpoint this adapter uses), but still 'trash', never 'delete'. Read from
  // the shared table so the outbound trigger — which gates on the capability
  // WITHOUT an adapter in hand — can never disagree with this adapter.
  archive: PROVIDER_ARCHIVE_CAPABILITY.dart,
};

/**
 * Recovery marker: the outbox row's client key, written as the final line of
 * every task this adapter creates. Dart accepts no idempotency key on create,
 * so this is the ONLY provider-visible proof that a given task is the one a
 * lost create produced — matching on parent + title cannot tell our child apart
 * from a sibling that happens to share the title.
 *
 * The marker is stripped from every description the adapter returns (see
 * {@link mapDescription}) so it never reaches a local body or a merge baseline —
 * but the key it carries is surfaced first, on `TrackerIssue.recoveryClientKey`
 * ({@link readRecoveryClientKey}), because the inbound pass needs it to
 * recognize a lost create's child before importing anything.
 *
 * Dart descriptions are markdown (not Plane's rich html), so the marker is
 * written and matched as plain text with no escaping in between.
 *
 * The literal itself lives in {@link import('./recoveryMarker')}, which the
 * OUTBOUND CONTENT WRITE also composes from when it re-appends this marker to a
 * body write-back (invariant 4 of docs/proposals/tracker-field-writeback.md) —
 * a second copy of the string here is exactly the drift that would silently
 * break {@link DartAdapter.findIssueByClientKey}'s absence proof.
 */
const SYNC_MARKER_PREFIX = RECOVERY_MARKER_PREFIX;

/**
 * `cyboflow-sync: <uuid>` — the shape the create paths emit, matched loosely on
 * the WHITESPACE between the prefix and the key.
 *
 * `\s*` rather than `[ \t]*` deliberately. Dart normalizes the markdown it
 * stores (MEASURED: it re-emits emphasis runs, reflows lists, and rewrites
 * dotted tokens as links), so the body that comes back is not always the body
 * that went out. A marker whose line got reflowed is still OUR marker, and the
 * UUID that follows makes a false positive vanishingly unlikely — whereas a
 * false NEGATIVE is expensive: {@link DartAdapter.findIssueByClientKey} reads
 * "no candidate carries it" as proof a create never landed, and duplicates it.
 */
const SYNC_MARKER_RE =
  /cyboflow-sync:\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * {@link SYNC_MARKER_RE} with the key captured. A SEPARATE, NON-GLOBAL copy on
 * purpose: `exec` on a /g regex carries `lastIndex` between calls, which would
 * make the read stateful across tasks.
 *
 * Kept in lockstep with SYNC_MARKER_RE: read and STRIP must agree on what a
 * marker is, or a marker loose enough to be recognized but too loose to be
 * removed would leak into a local idea body.
 */
const SYNC_MARKER_KEY_RE =
  /cyboflow-sync:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Dart's list endpoints cap out well above this; 100 keeps pages small and predictable. */
const PAGE_SIZE = 100;

/**
 * How many `GET /tasks/{id}` detail fetches may be in flight at once, on either
 * path that issues one per task: hydration ({@link DartAdapter.hydrate}) and the
 * recovery scan ({@link DartAdapter.firstMarkedTask}). Bounded because a full
 * first import of a large dartboard issues one per task (see the file header,
 * point 2) and Dart publishes no rate-limit headers to pace against — so the
 * ceiling is ours to choose rather than to discover.
 */
const HYDRATION_CONCURRENCY = 6;

/**
 * Runaway guard for the offset pager. `count` bounds every real listing, so
 * hitting this means the endpoint kept reporting more pages than it has —
 * better a named error than an unbounded loop inside the sync engine's lock.
 */
const MAX_PAGES = 500;

export interface DartAdapterOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  /**
   * Per-request abort budget; defaults to {@link TRACKER_REQUEST_TIMEOUT_MS}.
   * Injectable so a test can prove the abort path in milliseconds instead of
   * waiting out the real budget.
   */
  requestTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Wire shapes (only the fields this adapter reads/writes; Dart's objects carry
// more). Names are Dart's own camelCase.
// ---------------------------------------------------------------------------

interface DartPage<T> {
  count: number;
  next: string | null;
  results: T[];
}

interface DartUserWire {
  id?: string;
  name?: string | null;
  email?: string | null;
}

interface DartMeWire {
  isLoggedIn: boolean;
  user: DartUserWire;
}

/** `GET /config` — the whole discovery surface. */
interface DartConfigWire {
  dartboards: string[];
  statuses: string[];
  assignees?: DartUserWire[];
  /**
   * The workspace's task TYPES (`Task`, `Subtask`, …) and PRIORITY tokens
   * (`critical`, `high`, `medium`, `low`) — the mapping seeds behind
   * {@link DartAdapter.listFieldOptions}.
   *
   * MEASURED CASING TRAP: `/config` lists priorities in LOWERCASE while every
   * task read returns them in Title case (`Critical`). Nothing here normalizes
   * either side — the mapping modules match case-insensitively instead, so both
   * spellings stay exactly as Dart produced them.
   */
  types?: string[];
  priorities?: string[];
}

/** `ConciseTask` (list) — the same shape as `Task` minus description/attachments/relationships. */
interface DartConciseTaskWire {
  id: string;
  htmlUrl?: string | null;
  title: string;
  parentId?: string | null;
  dartboard?: string | null;
  status?: string | null;
  assignee?: string | null;
  assignees?: string[] | null;
  size?: string | number | null;
  updatedAt: string;
  /**
   * Task type and priority. BOTH OPTIONAL because Dart OMITS a null field from
   * every payload it produces — MEASURED on the create echo, the detail GET and
   * the concise list alike: an unprioritized task carries no `priority` key at
   * all rather than `priority: null`. So "absent" is the only spelling of unset
   * and {@link DartAdapter.mapIssue} reads it as such.
   *
   * The concise list carries both when set, so the inbound pass rides the
   * existing fetch and needs no extra hydration for them.
   */
  type?: string | null;
  priority?: string | null;
}

/** `Task` (detail/create/update) — adds the description the list shape omits. */
interface DartTaskWire extends DartConciseTaskWire {
  description?: string | null;
}

/** Every write and single-item read is enveloped as `{ item: ... }`. */
interface DartWrapped<T> {
  item: T;
}

// ---------------------------------------------------------------------------

export class DartAdapter implements TrackerAdapter {
  readonly provider: TrackerProvider = PROVIDER;
  readonly capabilities: TrackerAdapterCapabilities = CAPABILITIES;

  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;
  /** `GET /config` is one call serving containers, states and validation; cached per pass. */
  private configCache: DartConfigWire | null = null;
  /**
   * `GET /tasks/{id}` results, keyed by id — see
   * {@link DartAdapter.fetchTaskWire} for what may and may not go in here.
   */
  private readonly taskCache = new Map<string, DartTaskWire>();

  constructor(options: DartAdapterOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? TRACKER_REQUEST_TIMEOUT_MS;
  }

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    const me = await this.request<DartMeWire>('GET', '/me');
    // A 200 with isLoggedIn:false is Dart answering "this token resolves to no
    // session" without using a 401. Treated as an AUTH failure rather than a
    // generic one so it takes the re-connect path and pauses the connection,
    // instead of retrying a token that will never work.
    if (me.isLoggedIn !== true) {
      throw new TrackerAuthError(PROVIDER, 'token did not resolve to a logged-in Dart user', null);
    }
    const user = me.user ?? {};
    // DOCUMENTED COMPROMISE. Dart's API exposes NO workspace identity: neither
    // /me nor /config names the space a token belongs to. The account is the
    // best stable proxy available, so `workspaceId` is the user id — which
    // makes the credential-rotation guard (TrackerIdentityMismatchError) mean
    // "the replacement token must belong to the same Dart ACCOUNT". That is
    // strictly weaker than Linear's/Plane's workspace binding, and worth
    // knowing: it catches a token pasted from a different account, but cannot
    // catch the same user's token for a different space.
    const identity = user.id ?? user.email ?? null;
    if (identity === null) {
      throw new TrackerApiError(PROVIDER, '/me returned no user id or email to bind to', null);
    }
    return {
      workspaceId: identity,
      // No workspace name exists to show, so the account the token authorizes
      // stands in — it is the thing a user can actually recognize.
      workspaceName: user.email ?? user.name ?? identity,
      actorLabel: deriveActorLabel(user),
    };
  }

  /**
   * The Map step's groups: Dart SPACES, with the dartboards that belong to no
   * space listed on their own.
   *
   * Dart's API models no space at all — `/config` returns dartboard titles and
   * nothing else — but the titles carry the space in a `"<Space>/<Board>"`
   * convention that every Dart workspace observes. So a space here is the prefix
   * before the FIRST '/', derived not fetched, and the whole feature degrades
   * gracefully: a workspace that does not use the convention simply gets one
   * group per dartboard, which is exactly the pre-rev-4 source.
   *
   * A space group carries `narrowKind: 'space'` (its `containerId` is a space
   * name, which no `dartboard=` filter answers to) and a `pushContainerId`: a
   * create needs a concrete board, and the space's FIRST board in `/config`
   * order is the only non-arbitrary choice available.
   *
   * `stateScopeKey` is the constant 'workspace' for every group, space or not:
   * Dart statuses are workspace-wide, so the States step renders exactly one
   * mapping table however many groups are mapped.
   */
  async listGroups(): Promise<TrackerGroupTree> {
    const config = await this.getConfig();

    // Insertion-ordered, so both sections come out in /config order and each
    // space's first board stays its first board.
    const spaces = new Map<string, string[]>();
    const looseBoards: string[] = [];
    for (const title of config.dartboards) {
      const slash = title.indexOf('/');
      if (slash <= 0) {
        looseBoards.push(title);
        continue;
      }
      const space = title.slice(0, slash);
      const members = spaces.get(space);
      if (members === undefined) spaces.set(space, [title]);
      else members.push(title);
    }

    // Group ids are NAMESPACED because the two sections share one title
    // universe: a slash-less board titled exactly like a derived space
    // ("Engineering" beside "Engineering/Sprint") would otherwise mint two rows
    // with one id, and every wizard structure keyed on it would conflate them.
    const spaceGroups: TrackerGroup[] = [...spaces].map(([space, boards]) => ({
      id: `space:${space}`,
      name: space,
      // Dart has no short key chip, at either level.
      key: null,
      sourceLabel: `${space} · whole space`,
      selection: {
        containerId: space,
        narrowId: 'all',
        narrowKind: 'space' as const,
        pushContainerId: boards[0],
      },
      stateScopeKey: 'workspace',
    }));

    const boardGroups: TrackerGroup[] = looseBoards.map((title) => ({
      id: `board:${title}`,
      name: title,
      key: null,
      sourceLabel: title,
      selection: { containerId: title, narrowId: 'all', narrowKind: 'all' as const },
      stateScopeKey: 'workspace',
    }));

    const sections: TrackerGroupSection[] = [];
    // An empty section is omitted rather than rendered: a workspace either uses
    // the '/' convention or does not, and showing it the empty half of the other
    // model is noise in a step whose whole job is picking from a list.
    if (spaceGroups.length > 0) sections.push({ label: 'Spaces', groups: spaceGroups });
    if (boardGroups.length > 0) sections.push({ label: 'Dartboards', groups: boardGroups });
    return { sections };
  }

  async listContainers(): Promise<TrackerSourceTree> {
    const config = await this.getConfig();
    return {
      containerLabel: 'Dartboard',
      containers: config.dartboards.map((title) => ({
        // Header point 1: Dart enumerates dartboards by title only, so the
        // title is the id.
        id: title,
        name: title,
        // Dart has no short key chip and no per-dartboard open count.
        key: null,
        openIssueCount: null,
      })),
    };
  }

  async listNarrows(_containerId: string): Promise<TrackerSourceNarrow[]> {
    // Dart models views (`GET /views/{id}`) but enumerates none of them, and has
    // no cycle/module concept at all — so the whole dartboard is the only source
    // scope that can be OFFERED. The contract requires 'all' to be present, and
    // here it is the entire list.
    return [{ id: 'all', kind: 'all', name: 'Whole dartboard · all tasks', issueCount: null }];
  }

  async listStates(_selection: TrackerSourceSelection): Promise<TrackerState[]> {
    // Dart statuses are workspace-wide, not per-dartboard, so the selection is
    // not a filter here — /config is the whole list either way.
    const config = await this.getConfig();
    return config.statuses.map((title) => ({
      // Header point 1: the status title IS the write value `TaskUpdate.status`
      // takes, so it doubles as the id.
      id: title,
      name: title,
      // Dart exposes no status color.
      color: null,
      group: inferStateGroup(title),
    }));
  }

  /**
   * Dart is the one provider with LIVE field vocabularies: `/config` carries the
   * workspace's own `priorities` and `types`, both renameable by its owner and
   * both addressed BY TITLE on a write. Served off the same cached `/config`
   * every other discovery path uses, so this costs no extra request inside a
   * pass.
   *
   * A `/config` that omits either key (an older deployment) yields `null` for
   * that half — "nothing live to seed from" — and the mapping falls back to the
   * canonical token list rather than seeding an empty map.
   */
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    const config = await this.getConfig();
    return {
      priorities: config.priorities ?? null,
      categories: config.types ?? null,
    };
  }

  async listIssues(selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]> {
    const boards = await this.resolveScopeBoards(selection);
    const issues: TrackerIssue[] = [];
    // SEQUENTIAL, and no dedup. Sequential because each board's fetch already
    // fans out to HYDRATION_CONCURRENCY detail requests, so running the boards
    // in parallel would multiply the only concurrency this adapter bounds. No
    // dedup because a Dart task carries exactly one `dartboard`, so two member
    // boards can never return the same task — the union is a concatenation, and
    // each board's internal order is preserved.
    for (const board of boards) {
      issues.push(...(await this.listBoardIssues(board, sinceIso)));
    }
    return issues;
  }

  async listIssueIds(selection: TrackerSourceSelection): Promise<string[]> {
    const boards = await this.resolveScopeBoards(selection);
    const ids: string[] = [];
    for (const board of boards) {
      const concise = await this.paginate<{ id: string }>('/tasks/list', { dartboard: board });
      // Deliberately un-hydrated: the deletion sweep only needs ids, and those
      // are on the concise shape — which is also why the sweep stays cheap over
      // a whole space.
      ids.push(...concise.map((task) => task.id));
    }
    return ids;
  }

  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    const raw = await this.fetchTaskWire(externalId);
    return raw === null ? null : this.mapIssue(raw);
  }

  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    // Dart has no idempotency key on create (capabilities.idempotentCreate =
    // false), so the key is carried in the description instead: EVERY create
    // ends with the SYNC_MARKER_PREFIX line, which is what makes
    // findIssueByClientKey's "no child carries it" answer conclusive.
    clientKey: string
  ): Promise<TrackerIssue> {
    // PLACEMENT IS NOT INHERITED — MEASURED, not assumed. Dart's POST /tasks
    // documents the dartboard default as "the default dartboard", and a
    // `parentId`-only create was observed against a live space (2026-08-18) to
    // land the child on the API USER'S DEFAULT dartboard, NOT the parent's.
    // That placement is invisible to this connection: `listIssues` and
    // `listIssueIds` are both dartboard-scoped, so a mirror filed there would
    // sync outbound once and then never be seen again — remote edits would
    // never come back, and the deletion sweep would read it as out-of-scope on
    // every pass. The same measurement confirmed that naming the board
    // explicitly DOES honour the placement and still preserves `parentId`.
    const parent = await this.fetchTaskWire(parentExternalId);
    if (parent === null) {
      // Terminal (4xx): the parent is gone for good, so retrying this mirror
      // forever would just pin an outbox row that can never succeed.
      throw new TrackerApiError(
        PROVIDER,
        `parent task ${parentExternalId} no longer exists — cannot mirror a sub-issue under it`,
        404
      );
    }
    return this.postTask(
      { parentId: parentExternalId, dartboard: parent.dartboard ?? undefined },
      draft,
      clientKey
    );
  }

  /**
   * Top-level create (the PUSH direction): a task on the selection's DARTBOARD
   * with no parent. Carries the same unconditional recovery marker as
   * {@link DartAdapter.createSubIssue} — Dart still has no idempotency key, so a
   * top-level create that commits and loses its response is recovered by exactly
   * the same marker lookup ({@link DartAdapter.findIssueByClientKey}), which is
   * only conclusive because EVERY create writes the marker.
   *
   * A SPACE selection has no board of its own to file against, so the create
   * lands on `selection.pushContainerId` — see
   * {@link DartAdapter.resolveCreateBoard}.
   */
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue> {
    const board = await this.resolveCreateBoard(selection);
    return this.postTask({ dartboard: board }, draft, clientKey);
  }

  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    // `TaskUpdate` requires the id INSIDE the item as well as on the path.
    await this.request<DartWrapped<DartTaskWire>>('PUT', `/tasks/${encodeURIComponent(externalId)}`, {
      item: { id: externalId, status: stateId },
    });
    // This pass may still READ this task (the inbound merge hydrates the same
    // board the drain just wrote to), and the memoized copy now holds the state
    // we replaced — which the merge would diff against our own fresh baseline
    // and read as the remote moving backwards. See
    // {@link DartAdapter.fetchTaskWire}.
    this.taskCache.delete(externalId);
  }

  /**
   * `PUT /tasks/{id}` with ONLY the keys `patch` actually carries — an absent
   * field means "leave alone" (checked via `!== undefined`, never truthiness,
   * per {@link IssueContentPatch}'s contract), and an explicit `null` on
   * `priority`/`category` sends Dart's own clearing value (D2: a cleared
   * priority PUT returns 200 and the field comes back as an absent key on
   * every later read — Dart's own spelling of "unset", not a distinguishable
   * `null`).
   *
   * `description` is sent VERBATIM — no marker composition happens here; see
   * {@link IssueContentPatch.description} for why that responsibility sits
   * with the caller, not this adapter.
   *
   * Invalid `priority`/`category` values fail LOUD (D1/D3: a 400 with the
   * valid-value list in Dart's own error body) — no pre-flight `/config`
   * membership check, because the mapping layer upstream already refuses to
   * compose a token it does not recognize, and re-validating here would just
   * be a second, redundant `/config` round trip for the same guarantee.
   *
   * Never returns `null`: Dart's PUT response always echoes the updated item
   * (this is the echo-suppression baseline's stamp source — see
   * `TrackerAdapter.updateIssueContent`).
   */
  async updateIssueContent(externalId: string, patch: IssueContentPatch): Promise<TrackerIssue | null> {
    const item: Record<string, unknown> = { id: externalId };
    if (patch.title !== undefined) item.title = patch.title;
    if (patch.description !== undefined) item.description = patch.description;
    if (patch.priority !== undefined) item.priority = patch.priority;
    if (patch.category !== undefined) item.type = patch.category;
    const wrapped = await this.request<DartWrapped<DartTaskWire>>(
      'PUT',
      `/tasks/${encodeURIComponent(externalId)}`,
      { item }
    );
    // Same reasoning as updateIssueState: a stale memoized copy would read
    // this pass's own write as the remote moving backwards.
    this.taskCache.delete(externalId);
    return this.mapIssue(wrapped.item);
  }

  /**
   * `DELETE /tasks/{id}` — a real trash (D5: the item survives, invisible to
   * every ordinary listing, but recoverable under `in_trash=true`; there is
   * no restore endpoint this adapter uses, so it is one-way from cyboflow's
   * side). A 404 is SUCCESS (D5, second DELETE: `Task with ID … not found`) —
   * the twin was already trashed or deleted by some other path, which is
   * exactly the state this call was trying to reach.
   */
  async archiveIssue(externalId: string): Promise<void> {
    const response = await this.send('DELETE', `/tasks/${encodeURIComponent(externalId)}`);
    // Invariant 10 applies to archive too, and a 404 does not change that —
    // whatever this pass thought it knew about the task is stale either way.
    this.taskCache.delete(externalId);
    if (response.status === 404) return;
    this.assertOk(response);
  }

  /**
   * Ambiguous-create recovery (see the outbox worker): the task in scope that
   * carries `clientKey` in its {@link SYNC_MARKER_PREFIX} line, or null when
   * none carries it — which, because every create sends the marker, PROVES the
   * create never landed and a retry is safe.
   *
   * `scope.parentExternalId` narrows the search to one parent's children (a
   * mirrored `create_sub_issue`) via Dart's server-side `parent_id` filter;
   * otherwise the search is the selection's dartboard, or EVERY member board
   * when the selection is a space (a top-level `create_issue` — the outbox row
   * records no board, and `pushContainerId` may since have moved). BOTH forms
   * match on the client key alone — title is deliberately NOT a criterion,
   * because a dartboard routinely holds two tasks with the same title and
   * adopting the wrong one would silently redirect every later write-back onto
   * an unrelated task.
   *
   * COST, and why it is shaped this way. The marker lives in the description,
   * which list responses omit, so a candidate can only be judged after a detail
   * fetch. Dart does expose a `description` list filter, used FIRST as a fast
   * path; it was MEASURED to be a CONTAINS match (a bare substring of the marker
   * line matches, and a string present in no task returns zero rows), so the
   * fast path does hit in practice. The full-scan fallback is kept regardless,
   * because the cost of being wrong here is asymmetric: a miss that falls
   * through only costs time, whereas trusting an unexpectedly-narrow filter as
   * proof of absence would duplicate a create that actually landed.
   *
   * THREE THINGS BOUND THAT FALLBACK, none of which may narrow it enough to
   * MISS a landed create: `scope.updatedAfterIso` drops candidates that predate
   * the create outright (the caller supplies a deliberately generous floor —
   * see the outbox worker's recoveryScanFloor), the surviving candidates are
   * judged {@link HYDRATION_CONCURRENCY} at a time rather than one by one, and
   * every detail fetch is memoized for the rest of the pass
   * ({@link DartAdapter.fetchTaskWire}). Absent the hint the scan is the whole
   * scope, exactly as before.
   *
   * Not part of `TrackerAdapter`: the marker is stripped from every description
   * this adapter returns, so the match cannot be performed by the sync core over
   * a mapped `TrackerIssue` — it has to read the raw payload here.
   */
  async findIssueByClientKey(
    scope: {
      containerId: string | null;
      narrowKind?: TrackerNarrowKind | null;
      parentExternalId: string | null;
      /**
       * A floor on the candidates' `updatedAt`: a task this create produced
       * cannot have been touched before the create was enqueued. Optional —
       * omitting it scans the whole scope.
       */
      updatedAfterIso?: string | null;
    },
    clientKey: string
  ): Promise<TrackerIssue | null> {
    const marker = `${SYNC_MARKER_PREFIX} ${clientKey}`;
    // NEITHER ARM MAY ANSWER "EMPTY" FOR A SCOPE THAT NO LONGER RESOLVES. In
    // THIS method an empty result is not "no match" — it is read by the outbox
    // as PROOF the create never landed, which requeues a create that may
    // already have committed and duplicates it. Throwing instead leaves the row
    // `ambiguous`, which is the correct unresolved state.
    //
    // The two arms lose their scope differently. A renamed dartboard makes
    // `/tasks/list` answer 200 with zero rows (measured); that guard lives in
    // {@link DartAdapter.resolveRecoveryBoards}. The parent_id arm IS immune to
    // renames — it addresses by id — but not to a parent that was TRASHED or
    // deleted: trashing is indistinguishable from deletion over this API (see
    // {@link DartAdapter.mapIssue}), so a gone parent 404s on `GET /tasks/{id}`
    // and a `parent_id` filter naming it returns that same empty page. So the
    // parent is confirmed to exist first — one point GET, still not the /config
    // round-trip this arm has no reason to pay.
    const scopeParamSets: Record<string, string>[] = [];
    if (scope.parentExternalId !== null) {
      if ((await this.fetchTaskWire(scope.parentExternalId)) === null) {
        throw missingParentError(scope.parentExternalId);
      }
      scopeParamSets.push({ parent_id: scope.parentExternalId });
    } else if (scope.containerId !== null) {
      const boards = await this.resolveRecoveryBoards(scope.containerId, scope.narrowKind ?? null);
      scopeParamSets.push(...boards.map((board) => ({ dartboard: board })));
    }
    if (scopeParamSets.length === 0) {
      throw new TrackerApiError(
        PROVIDER,
        'client-key recovery needs either a parent task or a source dartboard'
      );
    }

    // Cheapest first ACROSS the whole scope: every board's server-side filter
    // before any board's full scan, so a space normally costs one filtered
    // listing per member board and nothing more.
    for (const scopeParams of scopeParamSets) {
      const filtered = await this.paginate<DartConciseTaskWire>('/tasks/list', {
        ...scopeParams,
        description: marker,
      });
      const viaFilter = await this.firstMarkedTask(filtered, clientKey);
      if (viaFilter !== null) return this.mapIssue(viaFilter);
    }

    // Fall back to the full scoped scan — see the COST note above. The time
    // floor rides on the LIST request rather than filtering its results, so it
    // shrinks the number of rows Dart returns, not just the number this adapter
    // then fetches details for.
    const sinceParams: Record<string, string> =
      typeof scope.updatedAfterIso === 'string' ? { updated_at_after: scope.updatedAfterIso } : {};
    for (const scopeParams of scopeParamSets) {
      const all = await this.paginate<DartConciseTaskWire>('/tasks/list', {
        ...scopeParams,
        ...sinceParams,
      });
      const viaScan = await this.firstMarkedTask(all, clientKey);
      if (viaScan !== null) return this.mapIssue(viaScan);
    }
    return null;
  }

  // ---- internals -----------------------------------------------------

  /**
   * The dartboards a selection covers: the space's member boards for
   * `narrowKind: 'space'`, otherwise the one board the selection names.
   *
   * The EMPTY space is an error, not an empty result, for exactly the reason
   * {@link DartAdapter.assertContainerExists} exists: a space is derived from
   * board titles, so renaming (or deleting) every `"<Space>/…"` board leaves the
   * connection pointing at a prefix nothing matches — and the union of zero
   * boards is an empty page, which `listIssueIds` would hand the deletion sweep
   * as "every task in this space was deleted remotely". Same hazard class, same
   * loud failure.
   */
  private async resolveScopeBoards(selection: TrackerSourceSelection): Promise<string[]> {
    if (selection.narrowKind !== 'space') {
      await this.assertContainerExists(selection.containerId);
      return [selection.containerId];
    }
    const config = await this.getConfig();
    const members = spaceMembers(config.dartboards, selection.containerId);
    if (members.length === 0) throw emptySpaceError(selection.containerId);
    return members;
  }

  /** One board's slice of {@link DartAdapter.listIssues}; the board is already validated. */
  private async listBoardIssues(board: string, sinceIso?: string): Promise<TrackerIssue[]> {
    const params: Record<string, string> = { dartboard: board };
    if (sinceIso !== undefined) {
      // MEASURED: `updated_at_after` is INCLUSIVE (a task queried at exactly its
      // own updatedAt comes back; one second later it does not), which is what
      // the adapter contract requires. The one-second widening and the exact
      // client-side re-filter below are kept anyway: they cost at most a second
      // of overlap the sync core already tolerates, and they keep the contract
      // satisfied if Dart ever tightens the bound to exclusive.
      params.updated_at_after = shiftIsoBySeconds(sinceIso, -1);
    }
    const concise = await this.paginate<DartConciseTaskWire>('/tasks/list', params);
    const scoped =
      sinceIso === undefined
        ? concise
        : concise.filter((task) => Date.parse(task.updatedAt) >= Date.parse(sinceIso));
    // Hydration, not decoration: the list shape has no description, and the sync
    // core merges on it (file header, point 2).
    const hydrated = await this.hydrate(scoped);
    return hydrated.map((task) => this.mapIssue(task));
  }

  /**
   * The board a create files against.
   *
   * A space cannot receive a task, so a space selection carries
   * `pushContainerId` (minted by {@link DartAdapter.listGroups} as the space's
   * first board). It is re-validated as a MEMBER of the space rather than
   * trusted: it was persisted at connect time and the board may since have been
   * renamed or moved out, and a create filed on a board this connection does not
   * read would sync outbound once and then be invisible to every later pass.
   *
   * The plain-board arm carries the same guard the read paths do, for the same
   * measured reason: a renamed dartboard is not an error to Dart, so an
   * unguarded create would either be filed somewhere unintended or fail with an
   * opaque 4xx that the outbox treats as terminal and DROPS the push. Failing
   * here keeps the row retryable until the source selection is repaired.
   */
  private async resolveCreateBoard(selection: TrackerSourceSelection): Promise<string> {
    const boards = await this.resolveScopeBoards(selection);
    if (selection.narrowKind !== 'space') return boards[0];
    const target = selection.pushContainerId;
    if (target === undefined) return boards[0];
    if (boards.includes(target)) return target;
    throw new TrackerApiError(
      PROVIDER,
      `dartboard "${target}" is not part of the Dart space "${selection.containerId}" — it was ` +
        'renamed, deleted or moved. Re-pick the source in Settings → Integrations.',
      null
    );
  }

  /**
   * The boards {@link DartAdapter.findIssueByClientKey} searches for a
   * container-scoped recovery. When the caller carries the selection's
   * `narrowKind` it is AUTHORITATIVE — a space and a board can share a title
   * ("Engineering" beside "Engineering/Sprint"), and guessing from the title
   * would search the wrong boards and read a committed create as never landed.
   * Only a caller with no kind at all (none exists today; the sub-issue arm is
   * parent-scoped) falls back to the title heuristic: a title in `/config` is a
   * board; a title that prefixes at least one board is a space; anything else
   * is the renamed/deleted case, which must throw rather than search nothing.
   */
  private async resolveRecoveryBoards(
    containerId: string,
    narrowKind: TrackerNarrowKind | null
  ): Promise<string[]> {
    const config = await this.getConfig();
    if (narrowKind === 'space') {
      const members = spaceMembers(config.dartboards, containerId);
      if (members.length === 0) throw emptySpaceError(containerId);
      return members;
    }
    if (narrowKind !== null) {
      if (config.dartboards.includes(containerId)) return [containerId];
      throw missingDartboardError(containerId);
    }
    if (config.dartboards.includes(containerId)) return [containerId];
    const members = spaceMembers(config.dartboards, containerId);
    if (members.length > 0) return members;
    throw missingDartboardError(containerId);
  }

  /**
   * The first candidate whose hydrated description carries `clientKey`, or null.
   *
   * Judged by PARSING the marker ({@link readRecoveryClientKey}) rather than by
   * a literal `description.includes(marker)`. The two differ exactly when Dart's
   * normalizer has touched the marker line, and this is the one place where
   * being too strict is costly: a miss here is read by the outbox as proof the
   * create never landed, so it POSTs again and duplicates a task that already
   * exists. Parsing also keeps this in step with the recovery key the adapter
   * surfaces on every mapped issue, so the two paths cannot disagree about what
   * counts as ours.
   */
  private async firstMarkedTask(
    candidates: DartConciseTaskWire[],
    clientKey: string
  ): Promise<DartTaskWire | null> {
    const wanted = clientKey.toLowerCase();
    // BATCHED, not sequential: the full-scope fallback judges every task on the
    // board one detail fetch at a time, and a true miss on a large board is the
    // whole board serially. Batches of {@link HYDRATION_CONCURRENCY} keep the
    // in-flight ceiling identical to hydration's while cutting the wall clock by
    // that factor.
    //
    // ORDER IS PRESERVED WITHIN A BATCH and the scan stops at the first batch
    // that yields a match, so the answer does not depend on which fetch settles
    // first. Correctness never rested on order anyway — the marker is unique per
    // clientKey, so at most one candidate can carry it — but a scan whose result
    // varies with network timing is not one anybody can reason about later. The
    // price is up to HYDRATION_CONCURRENCY-1 detail fetches past the match,
    // which {@link DartAdapter.fetchTaskWire}'s cache makes free to this pass's
    // later hydration.
    for (let start = 0; start < candidates.length; start += HYDRATION_CONCURRENCY) {
      const batch = candidates.slice(start, start + HYDRATION_CONCURRENCY);
      const fetched = await Promise.all(batch.map((candidate) => this.fetchTaskWire(candidate.id)));
      for (const full of fetched) {
        if (full !== null && readRecoveryClientKey(full) === wanted) return full;
      }
    }
    return null;
  }

  /**
   * Raw detail fetch; null on 404 (the task does not exist / was hard-deleted).
   *
   * MEMOIZED PER ADAPTER INSTANCE, which is per SYNC PASS — the sync core builds
   * one adapter and reuses it across processAmbiguous, drainOutbox and the
   * inbound pass, exactly as the {@link DartAdapter.getConfig} cache relies on.
   * That is the point: this is the one call the pass can genuinely repeat, since
   * a recovery scan and the same pass's hydration walk overlapping tasks.
   *
   * A 404 IS NEVER CACHED. Absence is the answer this adapter treats as proof —
   * of a create that never landed, of a trashed parent
   * ({@link DartAdapter.findIssueByClientKey}) — and trash state can change
   * under a pass. A remembered "gone" would turn one moment's absence into the
   * pass's whole truth; a remembered "present" only means the task existed a few
   * seconds earlier, which every read in a pass already assumes.
   */
  private async fetchTaskWire(taskId: string): Promise<DartTaskWire | null> {
    const cached = this.taskCache.get(taskId);
    if (cached !== undefined) return cached;
    const response = await this.send('GET', `/tasks/${encodeURIComponent(taskId)}`);
    if (response.status === 404) return null;
    this.assertOk(response);
    const wrapped = (await response.json()) as DartWrapped<DartTaskWire>;
    this.taskCache.set(taskId, wrapped.item);
    return wrapped.item;
  }

  /** The shared create POST behind both create paths. */
  private async postTask(
    placement: { dartboard?: string; parentId?: string },
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue> {
    const item: Record<string, unknown> = {
      ...placement,
      title: draft.title,
      description: toCreateDescription(draft.description, clientKey),
    };
    if (draft.stateId !== undefined) {
      item.status = draft.stateId;
    }
    if (draft.priority !== undefined) {
      item.priority = draft.priority;
    }
    if (draft.category !== undefined) {
      item.type = draft.category;
    }
    const wrapped = await this.request<DartWrapped<DartTaskWire>>('POST', '/tasks', { item });
    return this.mapIssue(wrapped.item);
  }

  /**
   * Turns concise list rows into full tasks, at most
   * {@link HYDRATION_CONCURRENCY} fetches in flight. A row whose detail fetch
   * 404s (deleted between the list and the hydrate) is DROPPED rather than
   * surfaced half-populated — a TrackerIssue with a null description that only
   * looks null because we failed to read it would merge as "the remote body was
   * cleared" and wipe the local one.
   */
  private async hydrate(concise: DartConciseTaskWire[]): Promise<DartTaskWire[]> {
    const out: DartTaskWire[] = new Array<DartTaskWire>(concise.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= concise.length) return;
        const full = await this.fetchTaskWire(concise[index].id);
        if (full !== null) out[index] = full;
      }
    };
    const lanes = Math.min(HYDRATION_CONCURRENCY, concise.length);
    await Promise.all(Array.from({ length: lanes }, () => worker()));
    // Order-preserving compaction of the 404 holes.
    return out.filter((task): task is DartTaskWire => task !== undefined);
  }

  /**
   * `GET /config` is Dart's entire discovery surface — dartboards, statuses and
   * the assignee roster in one call — so it is fetched once per adapter instance
   * and reused. Instance-scoped, exactly like PlaneAdapter's project-identifier
   * cache: the sync core builds a fresh adapter per pass, so nothing here can go
   * stale across passes.
   */
  private async getConfig(): Promise<DartConfigWire> {
    if (this.configCache !== null) return this.configCache;
    const config = await this.request<DartConfigWire>('GET', '/config');
    // EVERY key /config carries must be repeated here: this literal REPLACES the
    // response, so a key omitted from it is silently dropped for the whole pass.
    this.configCache = {
      dartboards: Array.isArray(config.dartboards) ? config.dartboards : [],
      statuses: Array.isArray(config.statuses) ? config.statuses : [],
      assignees: config.assignees,
      types: Array.isArray(config.types) ? config.types : undefined,
      priorities: Array.isArray(config.priorities) ? config.priorities : undefined,
    };
    return this.configCache;
  }

  /**
   * Fails loudly when the connection's dartboard is no longer in `/config`.
   *
   * This is the guard behind header point 1. Because the container id IS the
   * dartboard title, a rename in Dart leaves the connection
   * pointing at a name nothing answers to — and `GET /tasks/list?dartboard=<gone>`
   * returns an EMPTY PAGE rather than an error. Unguarded, that empty page reads
   * to `listIssueIds` as "every task in this dartboard was deleted remotely",
   * and the deletion sweep would act on it. A named error instead surfaces on
   * the connection and stops the pass with the links intact.
   */
  private async assertContainerExists(containerId: string): Promise<void> {
    const config = await this.getConfig();
    if (config.dartboards.includes(containerId)) return;
    throw missingDartboardError(containerId);
  }

  /**
   * Walks Dart's limit/offset pager to exhaustion.
   *
   * `count` is the AUTHORITY and is consulted first; `next` is only a fallback
   * for a response that omits `count` entirely. That ordering is load-bearing,
   * not stylistic: in `PaginatedConciseTaskList` the spec marks `count` and
   * `results` REQUIRED but `next` optional AND nullable, so a page carrying
   * `count: 250`, a hundred rows, and no `next` at all is schema-valid. Letting
   * a missing `next` win there would stop the walk two thirds short — which
   * `listIssueIds` would hand the deletion sweep as a shrunken id set, and
   * which `findIssueByClientKey` would read as a marker that is not there,
   * duplicating a create that already landed.
   */
  private async paginate<T>(
    path: string,
    extraParams: Record<string, string> = {}
  ): Promise<T[]> {
    const results: T[] = [];
    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES) {
        throw new TrackerApiError(
          PROVIDER,
          `pagination exceeded ${MAX_PAGES} pages on ${path} — refusing to loop further`,
          null
        );
      }
      const params = new URLSearchParams({
        ...extraParams,
        limit: String(PAGE_SIZE),
        offset: String(results.length),
      });
      const body = await this.request<DartPage<T>>('GET', `${path}?${params.toString()}`);
      const batch = Array.isArray(body.results) ? body.results : [];
      results.push(...batch);
      // An empty page terminates regardless of what `count` claims, so a
      // miscounted endpoint cannot spin here.
      if (batch.length === 0) break;
      if (typeof body.count === 'number') {
        if (results.length >= body.count) break;
        // `count` says there is more; an absent or null `next` does not get to
        // override it (see the doc comment). The empty-page guard above still
        // terminates a server that over-reports.
        continue;
      }
      if (body.next === null || body.next === undefined) break;
    }
    return results;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await this.send(method, path, body);
    this.assertOk(response);
    if (response.status === 204) return undefined as unknown as T;
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  /**
   * The single fetch every path in this adapter goes through.
   *
   * EVERY call carries an abort timeout (see TRACKER_REQUEST_TIMEOUT_MS): a
   * request that never settles would pin the sync engine's per-connection lock
   * for the life of the process. The abort — and any other transport-level
   * failure — surfaces as a TrackerApiError with a NULL status, which is what
   * puts it on the outbox's RETRY path rather than its terminal one: a timeout
   * says nothing about whether the write is valid.
   */
  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${API_BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new TrackerApiError(PROVIDER, describeTransportFailure(err, this.requestTimeoutMs), null);
    }
  }

  private assertOk(response: Response): void {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new TrackerAuthError(PROVIDER, `request failed (${response.status})`, response.status);
    }
    throw new TrackerApiError(PROVIDER, `request failed (${response.status})`, response.status);
  }

  private mapIssue(raw: DartTaskWire): TrackerIssue {
    return {
      externalId: raw.id,
      // Dart mints no human-readable ref (no "CORE-142" analogue anywhere in the
      // API), so the task id stands in — it is at least stable and clickable.
      identifier: raw.id,
      title: raw.title,
      description: mapDescription(raw),
      url: raw.htmlUrl ?? `${APP_ORIGIN}/t/${raw.id}`,
      // Header point 1: the status title is the state id.
      stateId: raw.status ?? '',
      assignee: mapAssignee(raw),
      estimate: mapEstimate(raw.size),
      parentExternalId: raw.parentId ?? null,
      updatedAt: raw.updatedAt,
      // Dart exposes no archive marker on a task, and needs none: trashing is
      // MEASURED to be indistinguishable from deletion over this API — a trashed
      // task 404s on `GET /tasks/{id}` and is absent from listings (including
      // under `no_defaults=true`; only an explicit `in_trash=true` reveals it).
      // So the sweep's own getIssue confirmation already classifies it as gone,
      // and there is no archived-but-present state for this field to carry.
      archivedAt: null,
      // Omit-when-null (see DartConciseTaskWire): an absent key is how Dart
      // spells "no priority" / "no type", so both collapse to null here rather
      // than being distinguished from an explicit null we will never receive.
      priority: raw.priority ?? null,
      category: raw.type ?? null,
      // Read BEFORE mapDescription strips it — every path that maps a wire task
      // (hydrated list, detail, create response, client-key recovery) goes
      // through here, so a marker-bearing task surfaces its key no matter how it
      // was fetched.
      recoveryClientKey: readRecoveryClientKey(raw),
    };
  }
}

// ---------------------------------------------------------------------------
// Free helpers (no adapter state needed).
// ---------------------------------------------------------------------------

/**
 * Best-effort canonical group for a Dart status NAME. Dart publishes no state
 * type or category (file header, point 3), so this reads the name.
 *
 * Order is load-bearing: the cancelled probe runs before the completed one so a
 * "Won't do"/"Cancelled — done investigating" style name is not claimed by the
 * completed matcher first. An unrecognized name falls back to 'backlog' rather
 * than throwing, matching PlaneAdapter's handling of an unknown group — groups
 * only seed mapping defaults, they never gate the sync.
 */
export function inferStateGroup(name: string): TrackerStateGroup {
  const n = name.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((needle) => n.includes(needle));
  if (has('triage')) return 'triage';
  if (has('cancel', "won't", 'wont', 'reject', 'abandon', 'duplicate', 'obsolete')) {
    return 'cancelled';
  }
  if (has('done', 'complete', 'finished', 'shipped', 'closed', 'resolved')) return 'completed';
  if (has('progress', 'doing', 'started', 'active', 'review', 'blocked', 'testing')) {
    return 'started';
  }
  if (has('to-do', 'to do', 'todo', 'ready', 'open', 'new', 'up next', 'planned')) {
    return 'unstarted';
  }
  if (has('backlog', 'someday', 'icebox')) return 'backlog';
  return 'backlog';
}

/**
 * The dartboards belonging to `space` under the `"<Space>/<Board>"` title
 * convention {@link DartAdapter.listGroups} derives spaces from. The trailing
 * '/' is part of the match, so the space "Design" never claims "DesignOps/…".
 */
function spaceMembers(dartboards: string[], space: string): string[] {
  const prefix = `${space}/`;
  return dartboards.filter((title) => title.startsWith(prefix));
}

/** The loud title-no-longer-resolves failure — see {@link DartAdapter.assertContainerExists}. */
function missingDartboardError(containerId: string): TrackerApiError {
  return new TrackerApiError(
    PROVIDER,
    `dartboard "${containerId}" no longer exists in this Dart space — it was renamed or ` +
      'deleted. Re-pick the source dartboard in Settings → Integrations.',
    null
  );
}

/**
 * The parent-scoped counterpart of {@link missingDartboardError}: the parent a
 * client-key recovery would search under is gone. Trashing is MEASURED to be
 * indistinguishable from deletion here (see {@link DartAdapter.mapIssue}), so
 * this covers both — and it must fail loud for the same reason the dartboard
 * arm does: a `parent_id` filter naming a gone parent returns an empty page the
 * outbox would read as proof the create never landed.
 */
function missingParentError(parentExternalId: string): TrackerApiError {
  return new TrackerApiError(
    PROVIDER,
    `parent task ${parentExternalId} no longer exists in this Dart space — it was trashed or ` +
      'deleted, so a lost create cannot be recovered under it.',
    null
  );
}

/** The same failure one level up: a space whose every member board is gone. */
function emptySpaceError(space: string): TrackerApiError {
  return new TrackerApiError(
    PROVIDER,
    `Dart space "${space}" no longer exists in this Dart workspace — every "${space}/…" ` +
      'dartboard was renamed or deleted. Re-pick the source in Settings → Integrations.',
    null
  );
}

function deriveActorLabel(user: DartUserWire): string {
  if (user.name && user.name.trim().length > 0) return user.name.trim();
  if (user.email && user.email.trim().length > 0) return user.email.trim();
  return 'Dart user';
}

/**
 * The description the sync core sees: Dart's markdown body with our recovery
 * marker removed. A body that is NOTHING BUT the marker is an empty description
 * — the marker is sync plumbing and must never reach a local idea body.
 */
function mapDescription(raw: DartTaskWire): string | null {
  if (typeof raw.description !== 'string') return null;
  const cleaned = stripSyncMarker(raw.description);
  return cleaned.length > 0 ? cleaned : null;
}

/** Drop the recovery marker (and the whitespace it leaves behind) from a description. */
function stripSyncMarker(text: string): string {
  return text.replace(SYNC_MARKER_RE, '').trim();
}

/**
 * The client key this task's description carries, or null when it carries none.
 * Reads the RAW payload — every description this adapter RETURNS has already had
 * the marker stripped.
 *
 * Lower-cased because the match is case-insensitive while the outbox column
 * holds a `randomUUID()` key, which is always lower-case: the sync core compares
 * the two for exact equality.
 */
function readRecoveryClientKey(raw: DartTaskWire): string | null {
  if (typeof raw.description !== 'string') return null;
  const match = SYNC_MARKER_KEY_RE.exec(raw.description);
  return match === null ? null : match[1].toLowerCase();
}

/**
 * Description markdown for a create: the draft body, then the recovery marker on
 * its own trailing line. The marker is UNCONDITIONAL — findIssueByClientKey
 * reads "no candidate carries it" as proof the create never landed, which only
 * holds if every create carries it, empty-bodied ones included.
 *
 * Delegates to the shared composer the outbound content write also uses, so a
 * body write-back re-appends the marker in EXACTLY the shape a create emitted
 * it (and {@link SYNC_MARKER_RE} keeps matching it).
 */
function toCreateDescription(markdown: string | undefined, clientKey: string): string {
  return appendRecoveryMarker(markdown, clientKey);
}

/**
 * Dart's `size` is `string | integer | null` — an integer is a point value, a
 * string is a t-shirt size ("M") with no numeric meaning. Only the former can
 * become a TrackerIssue estimate; a numeric string is accepted since Dart's own
 * spec allows either encoding for the same value.
 */
function mapEstimate(size: string | number | null | undefined): number | null {
  if (typeof size === 'number') return Number.isFinite(size) ? size : null;
  if (typeof size !== 'string') return null;
  const trimmed = size.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Dart identifies assignees by MONIKER (name or email), not by id — there is no
 * user id on a task anywhere in the API — so the moniker doubles as the ref id.
 * `assignee` and `assignees` are alternates (which one a workspace uses depends
 * on whether multi-assign is enabled), so both are read.
 */
function mapAssignee(raw: DartConciseTaskWire): TrackerUserRef | null {
  const moniker =
    typeof raw.assignee === 'string' && raw.assignee.length > 0
      ? raw.assignee
      : Array.isArray(raw.assignees) && raw.assignees.length > 0
        ? raw.assignees[0]
        : null;
  if (moniker === null || moniker.length === 0) return null;
  return { id: moniker, name: moniker, initials: deriveInitials(moniker) };
}

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** ISO timestamp shifted by whole seconds — see listIssues' inclusive-bound note. */
function shiftIsoBySeconds(iso: string, deltaSeconds: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms + deltaSeconds * 1000).toISOString();
}
