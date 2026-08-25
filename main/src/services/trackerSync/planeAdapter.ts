/**
 * PlaneAdapter — tracker-sync provider adapter for plane.so (cloud + self-
 * hosted). Design: docs/proposals/tracker-sync-integration.md ("Provider
 * adapter seam").
 *
 * Pure REST client: constructor-injected `FetchLike`, no sqlite, no retry
 * loops, no timers — durability (outbox, cursor, sweep) lives in the sync
 * core, not here. Every method that crosses the network throws only
 * `TrackerApiError`/`TrackerAuthError` (see errors.ts).
 *
 * externalId is COMPOSITE: `"<projectId>/<issueId>"`. Plane's REST paths are
 * project-scoped (`/projects/{id}/issues/{id}/`), so the adapter encodes the
 * project into the opaque id it hands the sync core and parses it back out
 * on every call that takes one. `parentExternalId` on a returned `TrackerIssue`
 * always composites against the SAME project — Plane sub-issues cannot cross
 * projects.
 *
 * Verified against https://developers.plane.so (2026-07-30). A few response
 * shapes are under-documented there; see the "documented choice" comments
 * below for what this adapter assumes and why.
 *
 * Path rename: Plane Cloud's work-item endpoints (list/create/retrieve/
 * update) moved from `/issues/` to `/work-items/`, ending support for the
 * old name (https://developers.plane.so/api-reference/issue/list-issues,
 * re-verified 2026-07-30). This adapter defaults to `/work-items/` and falls
 * back to `/issues/` for older self-hosted instances that predate the rename
 * — see {@link PlaneAdapter.workItemsSegment}. The cycle-issues/module-issues
 * membership link endpoints were checked against the same docs and did NOT
 * rename; they still answer under `cycle-issues/`/`module-issues/`, so
 * {@link PlaneAdapter.filterByMembership} is untouched by this.
 */

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerSourceNarrow,
  TrackerSourceSelection,
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
import { RECOVERY_MARKER_PREFIX } from './recoveryMarker';

const PROVIDER: TrackerProvider = 'plane';
const DEFAULT_BASE_URL = 'https://api.plane.so';
/** Cloud API and cloud app UI live on separate hosts; self-hosted shares one. */
const CLOUD_APP_ORIGIN = 'https://app.plane.so';

/**
 * Plane's priority enum as RAW tokens, in the provider's own order. `'none'` is
 * a rung of the enum (the column is NOT NULL), not the absence of one — see
 * {@link PlaneAdapter.listFieldOptions}.
 */
const PLANE_PRIORITY_TOKENS: readonly string[] = ['urgent', 'high', 'medium', 'low', 'none'];

const CAPABILITIES: TrackerAdapterCapabilities = {
  nativeParentAutoClose: false,
  selfHostedBaseUrl: true,
  // Plane has no client-supplied issue id on create, so the create itself is
  // not idempotent. Authorship is recovered instead from the marker paragraph
  // every create stamps into the description — see SYNC_MARKER_PREFIX and
  // {@link PlaneAdapter.findIssueByClientKey}.
  idempotentCreate: false,
  // Plane has no issue-type field at all (category is Dart-only, per the
  // locked scope decision — no label emulation in v1).
  contentWrite: { title: true, description: true, priority: true, category: false },
  // UNPROBED: Phase 0's P1 could not run (the stored token was invalid, 403
  // "Given API token is not valid"), and Plane's public v1 API documents no
  // archive endpoint at all — so this ships as 'none' per the pre-agreed
  // fallback rather than guessing at an unverified PATCH. Revisit if Plane
  // ships one, or once P1 re-runs against a live workspace with a fresh
  // token. `archiveIssue` below throws accordingly — it must be unreachable,
  // since the outbound archive trigger gates every enqueue on this capability
  // — reading it from the SHARED table, so the trigger (which has no adapter
  // in hand) and this adapter can never disagree.
  archive: PROVIDER_ARCHIVE_CAPABILITY.plane,
};

/**
 * Recovery marker: the outbox row's client key, written as the final paragraph
 * of every sub-issue this adapter creates. Plane accepts no idempotency key on
 * create, so this is the ONLY provider-visible proof that a given issue is the
 * one a lost create produced — matching on parent + title cannot tell our child
 * apart from a sibling that happens to share the title.
 *
 * The marker is stripped from every description the adapter returns (see
 * {@link mapDescription}) so it never reaches a local body or a merge baseline
 * — but the key it carries is surfaced first, on `TrackerIssue.recoveryClientKey`
 * ({@link readRecoveryClientKey}), because the inbound pass needs it to
 * recognize a lost create's child before importing anything.
 *
 * The literal itself lives in {@link import('./recoveryMarker')}, which the
 * OUTBOUND CONTENT WRITE also composes from when it re-appends this marker to a
 * body write-back (invariant 4 of docs/proposals/tracker-field-writeback.md).
 * It appends the marker as a trailing MARKDOWN paragraph, which
 * {@link toDescriptionHtml}'s blank-line split then renders as exactly the
 * `<p>` {@link toCreateDescriptionHtml} emits — same shape, one definition.
 */
const SYNC_MARKER_PREFIX = RECOVERY_MARKER_PREFIX;

/** `cyboflow-sync: <uuid>` — the exact shape createSubIssue emits (client keys are UUIDs). */
const SYNC_MARKER_RE =
  /cyboflow-sync:[ \t]*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * {@link SYNC_MARKER_RE} with the key captured. A SEPARATE, NON-GLOBAL copy on
 * purpose: `exec` on a /g regex carries `lastIndex` between calls, which would
 * make the read stateful across issues.
 */
const SYNC_MARKER_KEY_RE =
  /cyboflow-sync:[ \t]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/** Plane's representation of "no description" — also what an empty draft body becomes. */
const EMPTY_PARAGRAPH = '<p></p>';

const KNOWN_STATE_GROUPS: ReadonlySet<string> = new Set([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled',
]);

export interface PlaneAdapterOptions {
  apiKey: string;
  workspaceSlug: string;
  /** Self-hosted instance origin; omitted = Plane cloud. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /**
   * Per-request abort budget; defaults to {@link TRACKER_REQUEST_TIMEOUT_MS}.
   * Injectable so a test can prove the abort path in milliseconds instead of
   * waiting out the real budget.
   */
  requestTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Wire shapes (only the fields this adapter reads/writes; Plane's objects
// carry more).
// ---------------------------------------------------------------------------

interface PlanePage<T> {
  results: T[];
  next_cursor: string | null;
  next_page_results: boolean;
}

interface PlaneUserWire {
  id: string;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
}

interface PlaneProjectWire {
  id: string;
  name: string;
  identifier: string;
}

interface PlaneCycleWire {
  id: string;
  name: string;
}

interface PlaneModuleWire {
  id: string;
  name: string;
}

interface PlaneStateWire {
  id: string;
  name: string;
  color: string | null;
  group: string;
}

interface PlaneIssueWire {
  id: string;
  name: string;
  sequence_id: number;
  description_html?: string | null;
  /** Not documented on every endpoint; used when present, see mapDescription. */
  description_stripped?: string | null;
  description?: string | null;
  state: string;
  assignees?: Array<string | PlaneUserWire>;
  estimate_point?: number | null;
  parent?: string | null;
  updated_at: string;
  archived_at?: string | null;
  /**
   * Plane's lowercase priority enum. The column is NOT NULL server-side and
   * `'none'` is its unset token, so a null here means the field was not
   * selected rather than "no priority" — {@link PlaneAdapter.mapIssue} passes
   * whatever arrives through RAW, inventing nothing.
   */
  priority?: string | null;
}

/** Link record returned by the cycle-issues / module-issues endpoints. */
interface PlaneMembershipLinkWire {
  issue: string;
}

/** The two names the work-item collection/detail path has answered under — see {@link PlaneAdapter.workItemsSegment}. */
type WorkItemsSegment = 'work-items' | 'issues';

// ---------------------------------------------------------------------------

export class PlaneAdapter implements TrackerAdapter {
  readonly provider: TrackerProvider = PROVIDER;
  readonly capabilities: TrackerAdapterCapabilities = CAPABILITIES;

  private readonly apiKey: string;
  private readonly workspaceSlug: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  /** projectId → project.identifier ("COR"), fetched once and reused. */
  private readonly projectIdentifierCache = new Map<string, string>();
  /**
   * Which path segment names the work-item collection/detail endpoints on
   * THIS instance. Plane Cloud renamed `/issues/` → `/work-items/` (verified
   * against https://developers.plane.so/api-reference/issue/list-issues,
   * 2026-07-30); older self-hosted deployments predate the rename and only
   * answer on `/issues/`. Starts optimistic on the current name and flips —
   * once, permanently, for the life of this adapter instance — the first
   * time a `/work-items/` 404 turns out to be a naming mismatch rather than
   * a real 404 (see {@link sendWorkItem}). Deliberately simple: no TTL, no
   * re-probing once latched, no persistence across adapter instances — a
   * fresh instance re-derives it the same way every time.
   */
  private workItemsSegment: WorkItemsSegment = 'work-items';
  private readonly requestTimeoutMs: number;

  constructor(options: PlaneAdapterOptions) {
    this.apiKey = options.apiKey;
    this.workspaceSlug = options.workspaceSlug;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? TRACKER_REQUEST_TIMEOUT_MS;
  }

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    const me = await this.request<PlaneUserWire>('GET', '/users/me/');
    // Authorization probe for the configured slug specifically — /users/me/
    // only proves the key is live, not that it can see this workspace.
    //
    // A 404 HERE HAS EXACTLY ONE MEANING and it is worth saying out loud: the
    // key is good (the call above just succeeded with it) and the path is a
    // literal workspace slug, so the only thing that can be missing is the
    // WORKSPACE. Left to `assertOk` this reached the wizard as "[plane] request
    // failed (404)", which reads like a bug in cyboflow rather than a typo in
    // the one field the user just filled in. Every other 404 in this adapter
    // keeps the generic message — they name an id the user did not type.
    const probe = await this.send('GET', `/workspaces/${this.workspaceSlug}/projects/`);
    if (probe.status === 404) {
      throw new TrackerApiError(
        PROVIDER,
        `workspace not found — check the workspace slug "${this.workspaceSlug}"`,
        404
      );
    }
    this.assertOk(probe);
    return {
      // Plane's REST API exposes no prettier workspace display name on
      // /users/me/ or /workspaces/{slug}/projects/ — the slug is all we have
      // at this seam. (Documented choice — see task notes.)
      workspaceId: this.workspaceSlug,
      workspaceName: this.workspaceSlug,
      actorLabel: deriveActorLabel(me),
    };
  }

  /**
   * The Map step's groups: one per Plane project, which is already the level
   * this adapter containers at — so a group's selection is the whole-project
   * one `listContainers` + the 'all' narrow would have produced, and
   * `stateScopeKey` is the project id because Plane states are per-project.
   */
  async listGroups(): Promise<TrackerGroupTree> {
    const projects = await this.paginateAll<PlaneProjectWire>(
      `/workspaces/${this.workspaceSlug}/projects/`
    );
    return {
      sections: [
        {
          label: 'Projects',
          groups: projects.map((project) => ({
            id: project.id,
            name: project.name,
            key: project.identifier ?? null,
            sourceLabel: `${project.name} · whole project`,
            selection: { containerId: project.id, narrowId: 'all', narrowKind: 'all' as const },
            stateScopeKey: project.id,
          })),
        },
      ],
    };
  }

  async listContainers(): Promise<TrackerSourceTree> {
    const projects = await this.paginateAll<PlaneProjectWire>(
      `/workspaces/${this.workspaceSlug}/projects/`
    );
    return {
      containerLabel: 'Project',
      containers: projects.map((project) => ({
        id: project.id,
        name: project.name,
        key: project.identifier ?? null,
        openIssueCount: null,
      })),
    };
  }

  async listNarrows(containerId: string): Promise<TrackerSourceNarrow[]> {
    const [cycles, modules] = await Promise.all([
      this.paginateAll<PlaneCycleWire>(
        `/workspaces/${this.workspaceSlug}/projects/${containerId}/cycles/`
      ),
      this.paginateAll<PlaneModuleWire>(
        `/workspaces/${this.workspaceSlug}/projects/${containerId}/modules/`
      ),
    ]);
    return [
      { id: 'all', kind: 'all', name: 'Whole project · all work items', issueCount: null },
      ...cycles.map((cycle) => ({
        id: cycle.id,
        kind: 'cycle' as const,
        name: cycle.name,
        issueCount: null,
      })),
      ...modules.map((mod) => ({
        id: mod.id,
        kind: 'module' as const,
        name: mod.name,
        issueCount: null,
      })),
    ];
  }

  async listStates(selection: TrackerSourceSelection): Promise<TrackerState[]> {
    const states = await this.paginateAll<PlaneStateWire>(
      `/workspaces/${this.workspaceSlug}/projects/${selection.containerId}/states/`
    );
    return states.map((state) => ({
      id: state.id,
      name: state.name,
      color: state.color ?? null,
      group: normalizeStateGroup(state.group),
    }));
  }

  /**
   * Plane's priority enum is FIXED by the API (a project owner configures
   * states, never priorities), so this is stated rather than fetched. The tokens
   * are the exact lowercase spellings Plane accepts and returns.
   *
   * `categories: null` — Plane models no issue type.
   */
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    return { priorities: [...PLANE_PRIORITY_TOKENS], categories: null };
  }

  async listIssues(
    selection: TrackerSourceSelection,
    sinceIso?: string
  ): Promise<TrackerIssue[]> {
    const projectId = selection.containerId;
    const raw = await this.paginateAllWorkItems<PlaneIssueWire>(
      projectId,
      // Documented choice: Plane's issue list returns bare assignee UUIDs by
      // default; `expand=assignees` (per the API's documented `expand` query
      // param) returns full user objects so assignee.name/initials can be
      // derived without an N+1 user lookup per issue.
      { expand: 'assignees' }
    );
    const scoped = await this.filterByNarrow(projectId, selection, raw);
    const identifier = await this.getProjectIdentifier(projectId);
    const mapped = scoped.map((issue) => this.mapIssue(projectId, identifier, issue));
    if (sinceIso === undefined) return mapped;
    // Plane has no reliable server-side updated-at filter, so this filters
    // client-side over the fetched scope. The bound is INCLUSIVE per the
    // adapter contract (the sync core's overlap window depends on it).
    const sinceMs = Date.parse(sinceIso);
    return mapped.filter((issue) => Date.parse(issue.updatedAt) >= sinceMs);
  }

  async listIssueIds(selection: TrackerSourceSelection): Promise<string[]> {
    const projectId = selection.containerId;
    const raw = await this.paginateAllWorkItems<{ id: string }>(
      projectId,
      // Slim response: the deletion sweep only needs ids.
      { fields: 'id' }
    );
    const scoped = await this.filterByNarrow(projectId, selection, raw);
    return scoped.map((issue) => composeId(projectId, issue.id));
  }

  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    const { projectId, issueId } = splitExternalId(externalId);
    const raw = await this.fetchIssueWire(projectId, issueId);
    if (raw === null) return null;
    const identifier = await this.getProjectIdentifier(projectId);
    return this.mapIssue(projectId, identifier, raw);
  }

  async createSubIssue(
    parentExternalId: string,
    draft: IssueDraft,
    // Plane has no idempotency key on create (capabilities.idempotentCreate
    // = false), so the key is carried in the description instead: EVERY create
    // ends with the SYNC_MARKER_PREFIX paragraph, which is what makes
    // findIssueByClientKey's "no child carries it" answer conclusive.
    clientKey: string
  ): Promise<TrackerIssue> {
    const { projectId, issueId: parentIssueId } = splitExternalId(parentExternalId);
    return this.postWorkItem(projectId, parentIssueId, draft, clientKey);
  }

  /**
   * Top-level create (the PUSH direction): a work item in the selection's
   * PROJECT with no parent. Carries the same unconditional recovery marker as
   * `createSubIssue` — Plane still has no idempotency key, so a top-level
   * create that commits and loses its response is recovered by exactly the same
   * marker lookup ({@link PlaneAdapter.findIssueByClientKey}), which is only
   * conclusive because EVERY create writes the marker.
   *
   * The narrow (cycle/module) is deliberately not applied: Plane models cycle
   * and module membership as separate link endpoints, not as a field on create,
   * so honouring it would be a second write with its own failure mode on a path
   * whose whole correctness argument rests on being one POST.
   */
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue> {
    return this.postWorkItem(selection.containerId, null, draft, clientKey);
  }

  /** The shared create POST behind both create paths; `parentIssueId` null = top-level. */
  private async postWorkItem(
    projectId: string,
    parentIssueId: string | null,
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue> {
    const body: Record<string, unknown> = {
      name: draft.title,
      description_html: toCreateDescriptionHtml(draft.description, clientKey),
    };
    if (parentIssueId !== null) {
      body.parent = parentIssueId;
    }
    if (draft.stateId !== undefined) {
      body.state = draft.stateId;
    }
    if (draft.priority !== undefined) {
      body.priority = draft.priority;
    }
    const raw = await this.requestWorkItem<PlaneIssueWire>(
      'POST',
      (segment) => `/workspaces/${this.workspaceSlug}/projects/${projectId}/${segment}/`,
      body
    );
    const identifier = await this.getProjectIdentifier(projectId);
    return this.mapIssue(projectId, identifier, raw);
  }

  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    const { projectId, issueId } = splitExternalId(externalId);
    await this.requestWorkItem(
      'PATCH',
      (segment) => `/workspaces/${this.workspaceSlug}/projects/${projectId}/${segment}/${issueId}/`,
      { state: stateId }
    );
  }

  /**
   * `PATCH` with only the keys `patch` actually carries (checked via
   * `!== undefined`, per `IssueContentPatch`'s contract). `description` goes
   * through the SAME markdown→html conversion `createIssue` uses
   * ({@link toDescriptionHtml}) — with NO separate marker-wrapping step: the
   * caller already composed the full body, marker included where one is
   * needed, so this sends exactly what it converts, unlike
   * {@link toCreateDescriptionHtml} which appends one unconditionally. `null`
   * clears the description to Plane's own empty-body shape ({@link
   * EMPTY_PARAGRAPH}), matching how an empty draft body is represented on
   * create.
   *
   * Returns the PATCH response mapped through the same {@link mapIssue} path
   * every other read uses — the echo-suppression baseline's stamp source
   * (invariant 1); Plane's stamp-from-response is what keeps the
   * plaintext-ified html round trip (this API does not preserve markdown
   * verbatim) from generating phantom edits on the next inbound pass.
   *
   * UNVERIFIED AGAINST A LIVE WORKSPACE: Phase 0's P2/P3 probes could not run
   * (the stored token was invalid — see `CAPABILITIES.archive`'s note), so
   * this is implemented from Plane's documented lowercase priority enum and
   * the existing create-path `description_html` precedent. Re-run P2/P3
   * before any Plane live smoke once a fresh token is connected.
   */
  async updateIssueContent(externalId: string, patch: IssueContentPatch): Promise<TrackerIssue | null> {
    const { projectId, issueId } = splitExternalId(externalId);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) {
      body.name = patch.title;
    }
    if (patch.description !== undefined) {
      body.description_html =
        patch.description === null ? EMPTY_PARAGRAPH : toDescriptionHtml(patch.description);
    }
    if (patch.priority !== undefined) {
      body.priority = patch.priority;
    }
    const raw = await this.requestWorkItem<PlaneIssueWire>(
      'PATCH',
      (segment) => `/workspaces/${this.workspaceSlug}/projects/${projectId}/${segment}/${issueId}/`,
      body
    );
    const identifier = await this.getProjectIdentifier(projectId);
    return this.mapIssue(projectId, identifier, raw);
  }

  /**
   * UNSUPPORTED — throws unconditionally. `capabilities.archive === 'none'`:
   * Plane's public v1 API documents no archive endpoint, and Phase 0's P1
   * probe (which would have tested `PATCH {archived_at}`) could not run
   * against a live workspace (stored token invalid). This method must be
   * unreachable in practice — the caller (Phase 5) gates every
   * `archive_issue` enqueue on the capability, so a call reaching here would
   * itself be the bug. Plane's `DELETE` (hard delete) is never called from
   * any path in this adapter, archive included — see the locked scope
   * decision that outbound archive is never a hard delete.
   */
  async archiveIssue(_externalId: string): Promise<void> {
    throw new TrackerApiError(
      PROVIDER,
      'Plane archive is unsupported: no verified archive endpoint exists in the public v1 API ' +
        '(Phase 0 probe P1 could not run — the stored token was invalid). The caller must gate on ' +
        "capabilities.archive === 'none' before ever calling this.",
      null
    );
  }

  /**
   * Ambiguous-create recovery (see the outbox worker): the issue in
   * `scope.containerId` that carries `clientKey` in its SYNC_MARKER_PREFIX
   * paragraph, or null when none carries it — which, because every create sends
   * the marker, PROVES the create never landed and a retry is safe.
   *
   * `scope.parentExternalId` narrows the search to one parent's children (a
   * mirrored `create_sub_issue`); null searches the whole project (a top-level
   * `create_issue`, which has no parent to key on). BOTH forms match on the
   * client key alone — title is deliberately NOT a criterion, because a project
   * routinely holds two issues with the same title and adopting the wrong one
   * would silently redirect every later write-back onto an unrelated issue.
   *
   * Not part of `TrackerAdapter`: the marker is stripped from every description
   * this adapter returns, so the match cannot be performed by the sync core
   * over a mapped `TrackerIssue` — it has to read the raw payload here.
   *
   * `scope.updatedAfterIso` is a COST bound on the scan, applied CLIENT-SIDE:
   * the project listing is one paginated walk either way, but a candidate older
   * than the floor is skipped before the per-candidate detail re-fetch below,
   * which is where the GETs actually accumulate. Deliberately not pushed onto
   * the request as a Plane filter — this adapter's list params are the ones its
   * live API was verified against, and a filter Plane silently ignored would
   * cost nothing, while one it honoured differently than assumed would hide a
   * landed create and duplicate it.
   */
  async findIssueByClientKey(
    scope: {
      containerId: string | null;
      parentExternalId: string | null;
      /**
       * A floor on the candidates' `updated_at`: a work item this create
       * produced cannot have been touched before the create was enqueued.
       * Optional — omitting it scans every candidate.
       */
      updatedAfterIso?: string | null;
    },
    clientKey: string
  ): Promise<TrackerIssue | null> {
    // Project-scoped by construction: a Plane sub-issue always lives in its
    // parent's project (which its composite external id carries), and a
    // top-level create lands in the selection's own project — so the project
    // issue list is the whole search space either way.
    const parent = scope.parentExternalId === null ? null : splitExternalId(scope.parentExternalId);
    const projectId = parent?.projectId ?? scope.containerId;
    if (projectId === null) {
      throw new TrackerApiError(
        PROVIDER,
        'client-key recovery needs either a parent issue or a source project'
      );
    }
    const parentIssueId = parent?.issueId ?? null;
    const raw = await this.paginateAllWorkItems<PlaneIssueWire>(
      projectId,
      // Same expansion listIssues uses, so an adopted issue maps identically to
      // one that arrived through the inbound path.
      { expand: 'assignees' }
    );
    const marker = `${SYNC_MARKER_PREFIX} ${clientKey}`;
    const floorMs =
      typeof scope.updatedAfterIso === 'string' ? Date.parse(scope.updatedAfterIso) : Number.NaN;
    for (const candidate of raw) {
      if (parentIssueId !== null && candidate.parent !== parentIssueId) continue;
      // An unparseable floor (or none) leaves every candidate in the scan — the
      // bound may only ever skip work, never decide the answer.
      if (!Number.isNaN(floorMs) && Date.parse(candidate.updated_at) < floorMs) continue;
      // Documented choice: Plane's list payload does not reliably carry any
      // description field, and the marker lives only in the description — so a
      // candidate that arrived without one is re-fetched from the detail
      // endpoint rather than treated as unmarked.
      const described = hasDescriptionPayload(candidate)
        ? candidate
        : await this.fetchIssueWire(projectId, candidate.id);
      if (described === null || !carriesSyncMarker(described, marker)) continue;
      const identifier = await this.getProjectIdentifier(projectId);
      return this.mapIssue(projectId, identifier, described);
    }
    return null;
  }

  // ---- internals -----------------------------------------------------

  /**
   * Raw detail fetch; null on 404 (the issue does not exist / is hard-deleted).
   * Routed through {@link sendWorkItem}'s fallback, so a 404 here only maps to
   * "does not exist" once BOTH `/work-items/` and `/issues/` have been tried —
   * a bare naming mismatch never surfaces as a false "not found".
   */
  private async fetchIssueWire(projectId: string, issueId: string): Promise<PlaneIssueWire | null> {
    const response = await this.sendWorkItem(
      'GET',
      (segment) =>
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/${segment}/${issueId}/?expand=assignees`
    );
    if (response.status === 404) return null;
    this.assertOk(response);
    return (await response.json()) as PlaneIssueWire;
  }

  /**
   * Narrows the already-fetched project issue list down to a cycle/module
   * membership set. Documented choice: Plane's cycle-issues/module-issues
   * endpoints return thin link records (issue id only, per the API's
   * `cycle-issues`/`module-issues` overview) rather than full issue objects,
   * so this filters the project-scoped fetch by membership instead of
   * re-mapping from the link endpoint directly — one shape to map, not two.
   *
   * Unlike the work-item collection/detail endpoints, these two paths did
   * NOT rename: re-checked against https://developers.plane.so/api-reference
   * (cycle/list-cycle-work-items, module/list-module-work-items) 2026-07-30
   * and both still answer under the literal `cycle-issues/`/`module-issues/`
   * segments used below — no {@link workItemsSegment} fallback needed here.
   */
  private async filterByNarrow<T extends { id: string }>(
    projectId: string,
    selection: TrackerSourceSelection,
    issues: T[]
  ): Promise<T[]> {
    if (selection.narrowKind === 'cycle') {
      return this.filterByMembership(
        issues,
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/cycles/${selection.narrowId}/cycle-issues/`
      );
    }
    if (selection.narrowKind === 'module') {
      return this.filterByMembership(
        issues,
        `/workspaces/${this.workspaceSlug}/projects/${projectId}/modules/${selection.narrowId}/module-issues/`
      );
    }
    // 'all' (and any narrow kind Plane never emits, e.g. Linear's 'view') —
    // the whole project scope.
    return issues;
  }

  private async filterByMembership<T extends { id: string }>(
    issues: T[],
    membershipPath: string
  ): Promise<T[]> {
    const links = await this.paginateAll<PlaneMembershipLinkWire>(membershipPath);
    const memberIds = new Set(links.map((link) => link.issue));
    return issues.filter((issue) => memberIds.has(issue.id));
  }

  private async getProjectIdentifier(projectId: string): Promise<string> {
    const cached = this.projectIdentifierCache.get(projectId);
    if (cached !== undefined) return cached;
    const project = await this.request<PlaneProjectWire>(
      'GET',
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/`
    );
    this.projectIdentifierCache.set(projectId, project.identifier);
    return project.identifier;
  }

  private mapIssue(projectId: string, identifier: string, raw: PlaneIssueWire): TrackerIssue {
    return {
      externalId: composeId(projectId, raw.id),
      identifier: `${identifier}-${raw.sequence_id}`,
      title: raw.name,
      description: mapDescription(raw),
      url: this.buildIssueUrl(projectId, raw.id),
      stateId: raw.state,
      assignee: mapAssignee(raw.assignees),
      estimate: raw.estimate_point ?? null,
      parentExternalId: raw.parent ? composeId(projectId, raw.parent) : null,
      updatedAt: raw.updated_at,
      archivedAt: raw.archived_at ?? null,
      // Passed through exactly as Plane spelled it (see PlaneIssueWire.priority):
      // 'none' is a real rung of the enum, not an absence, so it must reach the
      // mapping as a token rather than being collapsed to null here.
      priority: raw.priority ?? null,
      // ALWAYS null for Plane: it models no issue TYPE, and label emulation is
      // out of scope, so there is nothing a category could be read from.
      category: null,
      // Read BEFORE mapDescription strips it — every path that maps a wire
      // issue (list, detail, create response, client-key recovery) goes through
      // here, so a marker-bearing issue surfaces its key no matter how it was
      // fetched.
      recoveryClientKey: readRecoveryClientKey(raw),
    };
  }

  private buildIssueUrl(projectId: string, issueId: string): string {
    // Documented choice: cloud API (api.plane.so) and cloud app
    // (app.plane.so) are separate hosts, so the default base URL can't
    // double as the web origin. Self-hosted instances serve app + API from
    // the same origin, so baseUrl IS the web origin there.
    const origin = this.baseUrl === DEFAULT_BASE_URL ? CLOUD_APP_ORIGIN : this.baseUrl;
    return `${origin}/${this.workspaceSlug}/projects/${projectId}/issues/${issueId}`;
  }

  private async paginateAll<T>(
    pathFromApiV1: string,
    extraParams: Record<string, string> = {}
  ): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ per_page: '100', ...extraParams });
      if (cursor !== undefined) params.set('cursor', cursor);
      const page = await this.request<PlanePage<T>>('GET', `${pathFromApiV1}?${params.toString()}`);
      results.push(...page.results);
      if (!page.next_page_results || page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    return results;
  }

  private async request<T>(method: string, pathFromApiV1: string, body?: unknown): Promise<T> {
    const response = await this.send(method, pathFromApiV1, body);
    this.assertOk(response);
    if (response.status === 204) return undefined as unknown as T;
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Sends one request against a work-item collection/detail path, applying
   * the `/work-items/` ↔ `/issues/` compatibility fallback documented on
   * {@link workItemsSegment}: a 404 on the current segment is retried once
   * against the other segment before being treated as a real 404.
   *
   * - Fallback succeeds (not 404) → latch {@link workItemsSegment} onto that
   *   segment for every later call, and return the fallback response.
   * - Fallback also 404s → return the ORIGINAL (current-segment) response
   *   unchanged, so callers that treat 404 as "does not exist" (see
   *   `fetchIssueWire`) keep working exactly as before; nothing is latched.
   * - Already latched onto `/issues/` → no probing left to do, a 404 there
   *   is just a real 404.
   */
  private async sendWorkItem(
    method: string,
    pathBuilder: (segment: WorkItemsSegment) => string,
    body?: unknown
  ): Promise<Response> {
    const primarySegment = this.workItemsSegment;
    const primary = await this.send(method, pathBuilder(primarySegment), body);
    if (primary.status !== 404 || primarySegment === 'issues') return primary;
    const fallback = await this.send(method, pathBuilder('issues'), body);
    if (fallback.status === 404) return primary;
    this.workItemsSegment = 'issues';
    return fallback;
  }

  /** Like {@link request}, but routed through {@link sendWorkItem}'s compatibility fallback. */
  private async requestWorkItem<T>(
    method: string,
    pathBuilder: (segment: WorkItemsSegment) => string,
    body?: unknown
  ): Promise<T> {
    const response = await this.sendWorkItem(method, pathBuilder, body);
    this.assertOk(response);
    if (response.status === 204) return undefined as unknown as T;
    const text = await response.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  /** Like {@link paginateAll}, but for the work-item collection endpoint specifically (see {@link sendWorkItem}). */
  private async paginateAllWorkItems<T>(
    projectId: string,
    extraParams: Record<string, string> = {}
  ): Promise<T[]> {
    const results: T[] = [];
    let cursor: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ per_page: '100', ...extraParams });
      if (cursor !== undefined) params.set('cursor', cursor);
      const query = params.toString();
      const page = await this.requestWorkItem<PlanePage<T>>(
        'GET',
        (segment) => `/workspaces/${this.workspaceSlug}/projects/${projectId}/${segment}/?${query}`
      );
      results.push(...page.results);
      if (!page.next_page_results || page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    return results;
  }

  /**
   * The single fetch every path in this adapter goes through.
   *
   * EVERY call carries an abort timeout (see TRACKER_REQUEST_TIMEOUT_MS): a
   * request that never settles would pin the sync engine's per-connection lock
   * for the life of the process. The abort — and any other transport-level
   * failure, which used to escape this class RAW and untyped — surfaces as a
   * TrackerApiError with a NULL status, which is what puts it on the outbox's
   * RETRY path rather than its terminal one: a timeout says nothing about
   * whether the write is valid.
   */
  private async send(method: string, pathFromApiV1: string, body?: unknown): Promise<Response> {
    try {
      return await this.fetchImpl(`${this.baseUrl}/api/v1${pathFromApiV1}`, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new TrackerApiError(
        PROVIDER,
        describeTransportFailure(err, this.requestTimeoutMs),
        null
      );
    }
  }

  private assertOk(response: Response): void {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      throw new TrackerAuthError(PROVIDER, `request failed (${response.status})`, response.status);
    }
    throw new TrackerApiError(PROVIDER, `request failed (${response.status})`, response.status);
  }
}

// ---------------------------------------------------------------------------
// Free helpers (no adapter state needed).
// ---------------------------------------------------------------------------

function composeId(projectId: string, issueId: string): string {
  return `${projectId}/${issueId}`;
}

function splitExternalId(externalId: string): { projectId: string; issueId: string } {
  const separatorIndex = externalId.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex === externalId.length - 1) {
    throw new Error(`[plane] malformed composite externalId: "${externalId}"`);
  }
  return {
    projectId: externalId.slice(0, separatorIndex),
    issueId: externalId.slice(separatorIndex + 1),
  };
}

function normalizeStateGroup(group: string): TrackerStateGroup {
  // Plane's own groups (backlog/unstarted/started/completed/cancelled) map
  // straight onto ours; Plane has no 'triage' group. An unrecognized group
  // (a future Plane addition) falls back to 'backlog' rather than throwing —
  // states only seed mapping defaults, they never gate the sync itself.
  return KNOWN_STATE_GROUPS.has(group) ? (group as TrackerStateGroup) : 'backlog';
}

function deriveActorLabel(user: PlaneUserWire): string {
  if (user.display_name && user.display_name.trim().length > 0) {
    return user.display_name.trim();
  }
  const fullName = [user.first_name, user.last_name]
    .filter((part) => part !== null && part !== undefined && part.trim().length > 0)
    .join(' ')
    .trim();
  if (fullName.length > 0) return fullName;
  if (user.email && user.email.trim().length > 0) return user.email.trim();
  return 'Plane user';
}

function mapDescription(raw: PlaneIssueWire): string | null {
  // Documented choice: prefer whichever plain-text field the endpoint
  // happens to carry (Plane's list/detail responses are inconsistent about
  // exposing `description_stripped` vs a plain `description`) over the rich
  // `description_html`, falling back to a naive tag-strip of the html.
  //
  // Our own recovery marker comes off every one of them: it is sync plumbing,
  // and a body that is nothing BUT the marker is an empty description.
  const plain = raw.description_stripped ?? raw.description ?? null;
  if (plain !== null) {
    const cleaned = stripSyncMarker(plain);
    if (cleaned.length > 0) return cleaned;
  }
  if (raw.description_html) {
    const naive = stripSyncMarker(stripHtml(raw.description_html));
    if (naive.length > 0) return naive;
  }
  return null;
}

/** Drop the recovery marker (and the whitespace it leaves behind) from a description. */
function stripSyncMarker(text: string): string {
  return text.replace(SYNC_MARKER_RE, '').trim();
}

/**
 * The client key this issue's description carries, or null when it carries
 * none. Reads the RAW payload — every description this adapter RETURNS has
 * already had the marker stripped — and looks at each description field the
 * endpoint happens to expose, exactly like {@link carriesSyncMarker}.
 *
 * Lower-cased because the match is case-insensitive (Plane round-trips the html
 * we sent, but nothing here depends on that) while the outbox column holds a
 * `randomUUID()` key, which is always lower-case: the sync core compares the
 * two for exact equality.
 */
function readRecoveryClientKey(raw: PlaneIssueWire): string | null {
  for (const field of [raw.description_html, raw.description_stripped, raw.description]) {
    if (typeof field !== 'string') continue;
    const match = SYNC_MARKER_KEY_RE.exec(field);
    if (match !== null) return match[1].toLowerCase();
  }
  return null;
}

/** True when the payload carries the given `cyboflow-sync: <key>` marker. */
function carriesSyncMarker(raw: PlaneIssueWire, marker: string): boolean {
  // The marker survives escapeHtml unchanged, so the raw html matches literally.
  return [raw.description_html, raw.description_stripped, raw.description].some(
    (field) => typeof field === 'string' && field.includes(marker)
  );
}

/** False when the endpoint returned no description field at all — see findIssueByClientKey. */
function hasDescriptionPayload(raw: PlaneIssueWire): boolean {
  return (
    typeof raw.description_html === 'string' ||
    typeof raw.description_stripped === 'string' ||
    typeof raw.description === 'string'
  );
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mapAssignee(assignees: Array<string | PlaneUserWire> | undefined): TrackerUserRef | null {
  if (!assignees || assignees.length === 0) return null;
  const first = assignees[0];
  if (typeof first === 'string') {
    // Bare id, no expansion available — best effort, no display name to derive.
    return { id: first, name: first, initials: deriveInitials(first) };
  }
  const name = deriveActorLabel(first);
  return { id: first.id, name, initials: deriveInitials(name) };
}

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/**
 * Description html for a create: the draft body, then the recovery marker as
 * its own paragraph. The marker is UNCONDITIONAL — findIssueByClientKey
 * reads "no child carries it" as proof the create never landed, which only
 * holds if every create carries it, empty-bodied ones included.
 */
function toCreateDescriptionHtml(markdown: string | undefined, clientKey: string): string {
  const body = toDescriptionHtml(markdown);
  const marker = `<p>${escapeHtml(`${SYNC_MARKER_PREFIX} ${clientKey}`)}</p>`;
  return body === undefined || body === EMPTY_PARAGRAPH ? marker : `${body}${marker}`;
}

function toDescriptionHtml(markdown: string | undefined): string | undefined {
  if (markdown === undefined) return undefined;
  const trimmed = markdown.trim();
  if (trimmed.length === 0) return EMPTY_PARAGRAPH;
  const escaped = escapeHtml(trimmed);
  return escaped
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/\n/g, '<br />')}</p>`)
    .join('');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
