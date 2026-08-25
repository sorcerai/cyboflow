/**
 * LinearAdapter — the Linear implementation of the `TrackerAdapter` seam.
 * Design: docs/proposals/tracker-sync-integration.md ("Provider adapter
 * seam" + "Durability & failure semantics").
 *
 * Pure GraphQL API client: constructor-injected `FetchLike`, no sqlite, no
 * retries or timers of its own — the sync core owns durability (outbox,
 * cursor, sweep) and depends on these methods behaving as documented on
 * `TrackerAdapter`.
 *
 * Two Linear-specific wrinkles this file has to absorb:
 *  - Personal API keys go BARE in `Authorization` (no "Bearer" prefix — that
 *    prefix is OAuth2-only).
 *  - Linear reports GraphQL errors both as an HTTP 400/401 status AND as an
 *    `errors[]` array on an HTTP 200 partial-success response. Every request
 *    path below checks both; auth failures (HTTP 401, or an error whose
 *    `extensions.type`/`extensions.code` mentions "auth") throw
 *    `TrackerAuthError`, everything else throws `TrackerApiError` carrying
 *    the HTTP status.
 */

import type {
  TrackerProvider,
  TrackerWorkspaceIdentity,
  TrackerGroup,
  TrackerGroupSection,
  TrackerGroupTree,
  TrackerSourceTree,
  TrackerSourceContainer,
  TrackerSourceNarrow,
  TrackerSourceSelection,
  TrackerState,
  TrackerStateGroup,
  TrackerIssue,
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

const LINEAR_API_URL = 'https://api.linear.app/graphql';

// ---------------------------------------------------------------------------
// GraphQL envelope shapes
// ---------------------------------------------------------------------------

interface LinearGraphQLErrorExtensions {
  type?: string;
  code?: string;
}

interface LinearGraphQLError {
  message: string;
  extensions?: LinearGraphQLErrorExtensions;
}

interface LinearGraphQLResponse<T> {
  data?: T | null;
  errors?: LinearGraphQLError[];
}

interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface LinearConnection<TNode> {
  nodes: TNode[];
  pageInfo: LinearPageInfo;
}

function emptyConnection<TNode>(): LinearConnection<TNode> {
  return { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
}

// ---------------------------------------------------------------------------
// Node/response shapes for the specific queries this adapter issues
// ---------------------------------------------------------------------------

interface LinearTeamNode {
  id: string;
  name: string;
  key: string;
}

interface LinearProjectNode {
  id: string;
  name: string;
}

/** A workspace-root project node, carrying the teams it spans (the Map step). */
interface LinearProjectWithTeamsNode extends LinearProjectNode {
  teams: { nodes: LinearTeamNode[] };
}

interface LinearCycleNode {
  id: string;
  number: number;
  name: string | null;
}

interface LinearWorkflowStateNode {
  id: string;
  name: string;
  color: string | null;
  type: string;
}

interface LinearUserNode {
  id: string;
  name: string;
  displayName: string;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  state: { id: string };
  assignee: LinearUserNode | null;
  estimate: number | null;
  parent: { id: string } | null;
  updatedAt: string;
  archivedAt: string | null;
  /**
   * Linear reads priority as a FLOAT (`2` arrives as `2.0`) even though the
   * write side takes an Int and the scale has exactly five rungs. Normalized to
   * the raw string token at {@link mapIssueNode}; `0` is Linear's real "No
   * priority" rung, NOT an absence.
   */
  priority: number | null;
  /**
   * Set by `issueArchive(trash: true)` alongside `archivedAt` (probe L1).
   * Selected here so the archive write-back's response stamp has it without a
   * second selection edit; nothing reads it yet — `archivedAt` is what inbound
   * classifies an archived issue on.
   */
  trashed: boolean | null;
}

interface ValidateCredentialsResponse {
  viewer: { id: string; name: string; displayName: string | null };
  organization: { id: string; name: string };
}

interface ListTeamsResponse {
  teams: LinearConnection<LinearTeamNode>;
}

interface ListProjectsWithTeamsResponse {
  projects: LinearConnection<LinearProjectWithTeamsNode>;
}

interface ListTeamProjectsResponse {
  team: { projects: LinearConnection<LinearProjectNode> } | null;
}

interface ListTeamCyclesResponse {
  team: { cycles: LinearConnection<LinearCycleNode> } | null;
}

interface ListTeamStatesResponse {
  team: { states: { nodes: LinearWorkflowStateNode[] } } | null;
}

interface ListIssuesResponse {
  issues: LinearConnection<LinearIssueNode>;
}

interface ListIssueIdsResponse {
  issues: LinearConnection<{ id: string }>;
}

interface GetIssueResponse {
  issue: LinearIssueNode | null;
}

interface GetIssueTeamResponse {
  issue: { team: { id: string } } | null;
}

interface CreateIssueResponse {
  issueCreate: { success: boolean; issue: LinearIssueNode | null };
}

interface UpdateIssueStateResponse {
  issueUpdate: { success: boolean };
}

interface UpdateIssueContentResponse {
  issueUpdate: { success: boolean; issue: LinearIssueNode | null };
}

interface ArchiveIssueResponse {
  issueArchive: { success: boolean };
}

interface LinearIdEqFilter {
  eq: string;
}

interface LinearIssueFilter {
  team: { id: LinearIdEqFilter };
  project?: { id: LinearIdEqFilter };
  cycle?: { id: LinearIdEqFilter };
  updatedAt?: { gte: string };
}

interface LinearIssueCreateInput {
  id: string;
  teamId: string;
  /** Omitted on a top-level create (`createIssue`); set on a mirrored sub-issue. */
  parentId?: string;
  title: string;
  description?: string;
  stateId?: string;
  /** `IssueDraft.priority`, converted to Linear's Int scale — see {@link toLinearPriorityInt}. */
  priority?: number | null;
}

/** `IssueUpdateInput`, restricted to the fields `updateIssueContent` writes. */
interface LinearIssueUpdateInput {
  title?: string;
  /**
   * Linear takes markdown directly (no rich-format conversion, unlike Plane),
   * so this is `IssueContentPatch.description` passed straight through —
   * Linear never writes a recovery marker in the first place
   * (`capabilities.idempotentCreate` is true, so there is nothing for a
   * content write to preserve), which is why there is no marker-composition
   * step here at all, symmetric with `createIssue`/`createSubIssue` below.
   */
  description?: string | null;
  /** `IssueContentPatch.priority`, converted to Linear's Int scale — see {@link toLinearPriorityInt}. */
  priority?: number | null;
}

// ---------------------------------------------------------------------------
// Query/mutation text. The issue node field selection is shared across the
// three operations that return a full issue (listIssues, getIssue,
// createSubIssue) so they never drift out of sync with each other.
// ---------------------------------------------------------------------------

const ISSUE_NODE_FIELDS = `
    id
    identifier
    title
    description
    url
    state {
      id
    }
    assignee {
      id
      name
      displayName
    }
    estimate
    parent {
      id
    }
    updatedAt
    archivedAt
    priority
    trashed
`;

const VALIDATE_CREDENTIALS_QUERY = `
  query ValidateCredentials {
    viewer {
      id
      name
      displayName
    }
    organization {
      id
      name
    }
  }
`;

const LIST_TEAMS_QUERY = `
  query ListTeams($after: String) {
    teams(first: 100, after: $after) {
      nodes {
        id
        name
        key
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Projects at the WORKSPACE root, each with the teams it spans — the Map step's
 * source. A root query rather than the per-team one below because the Map step
 * wants every project in one pass, and Linear's `Project.teams` is what turns a
 * project into the (project × team) pairs the engine's team+project issue
 * filter can actually address. `teams(first: 50)` is unpaginated by design: a
 * project spanning more than fifty teams is not a mapping unit anyone will pick
 * from a list, and the whole-teams section below covers it.
 */
const LIST_PROJECTS_WITH_TEAMS_QUERY = `
  query ListProjectsWithTeams($after: String) {
    projects(first: 100, after: $after) {
      nodes {
        id
        name
        teams(first: 50) {
          nodes {
            id
            name
            key
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const LIST_TEAM_PROJECTS_QUERY = `
  query ListTeamProjects($teamId: String!, $after: String) {
    team(id: $teamId) {
      projects(first: 100, after: $after) {
        nodes {
          id
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const LIST_TEAM_CYCLES_QUERY = `
  query ListTeamCycles($teamId: String!, $after: String) {
    team(id: $teamId) {
      cycles(first: 100, after: $after) {
        nodes {
          id
          number
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const LIST_TEAM_STATES_QUERY = `
  query ListTeamStates($teamId: String!) {
    team(id: $teamId) {
      states(first: 100) {
        nodes {
          id
          name
          color
          type
        }
      }
    }
  }
`;

const LIST_ISSUES_QUERY = `
  query ListIssues($filter: IssueFilter, $after: String) {
    issues(filter: $filter, first: 100, after: $after, includeArchived: true) {
      nodes {
${ISSUE_NODE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const LIST_ISSUE_IDS_QUERY = `
  query ListIssueIds($filter: IssueFilter, $after: String) {
    issues(filter: $filter, first: 100, after: $after, includeArchived: true) {
      nodes {
        id
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const GET_ISSUE_QUERY = `
  query GetIssue($id: String!) {
    issue(id: $id) {
${ISSUE_NODE_FIELDS}
    }
  }
`;

const GET_ISSUE_TEAM_QUERY = `
  query GetIssueTeam($id: String!) {
    issue(id: $id) {
      team {
        id
      }
    }
  }
`;

/** Shared by createSubIssue and createIssue — the placement lives in the input. */
const CREATE_ISSUE_MUTATION = `
  mutation CreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
${ISSUE_NODE_FIELDS}
      }
    }
  }
`;

const UPDATE_ISSUE_STATE_MUTATION = `
  mutation UpdateIssueState($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
    }
  }
`;

/**
 * The `updateIssueContent` write. A SEPARATE mutation from
 * `UPDATE_ISSUE_STATE_MUTATION` rather than a shared one selecting
 * `issue { ...ISSUE_NODE_FIELDS }` unconditionally: the state write never
 * needs the echoed issue back (it returns void), so paying for the full
 * selection on every state move would be pure waste. This one DOES need it —
 * per invariant 1, the caller stamps the baseline from exactly these
 * (post-normalizer) values, and `issueUpdate` is the only route to them.
 */
const UPDATE_ISSUE_CONTENT_MUTATION = `
  mutation UpdateIssueContent($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
      issue {
${ISSUE_NODE_FIELDS}
      }
    }
  }
`;

/**
 * `issueArchive(trash: true)` — the ONLY route probe L1 found that actually
 * archives: `issueUpdate({ trashed: true })` is REJECTED outright ("invalid
 * trashed state"), so `issueUpdate` must never be used for this. `success`
 * is all this needs to select — `archiveIssue` returns void, and the probe
 * confirmed a direct `issue(id)` lookup still resolves post-archive if a
 * caller ever needs the echoed state (nothing here does).
 */
const ARCHIVE_ISSUE_MUTATION = `
  mutation ArchiveIssue($id: String!) {
    issueArchive(id: $id, trash: true) {
      success
    }
  }
`;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Linear's five priority rungs as RAW tokens, in the provider's own order
 * (`'0'` No priority, `'1'` Urgent … `'4'` Low). Fixed by the provider, so the
 * adapter states them instead of discovering them — see
 * {@link LinearAdapter.listFieldOptions}.
 */
const LINEAR_PRIORITY_TOKENS: readonly string[] = ['0', '1', '2', '3', '4'];

/** Linear `WorkflowState.type` → cyboflow's canonical `TrackerStateGroup`. */
const STATE_TYPE_TO_GROUP: Record<string, TrackerStateGroup> = {
  triage: 'triage',
  backlog: 'backlog',
  unstarted: 'unstarted',
  started: 'started',
  completed: 'completed',
  canceled: 'cancelled',
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Linear's own error taxonomy isn't published as a stable enum; the
 * `extensions.type`/`extensions.code` values observed in practice are
 * lowercase snake_case strings like `authentication_error`. We match
 * defensively on substring rather than an exact value so a provider-side
 * rename doesn't silently stop us from recognizing an auth failure.
 */
function isAuthError(errors: LinearGraphQLError[]): boolean {
  return errors.some((error) => {
    const marker = `${error.extensions?.type ?? ''} ${error.extensions?.code ?? ''}`.toLowerCase();
    return marker.includes('auth');
  });
}

/** Same defensive-substring approach for the "entity not found" case `getIssue` needs to swallow. */
function isEntityNotFoundError(errors: LinearGraphQLError[]): boolean {
  return errors.some((error) => {
    const marker = `${error.extensions?.type ?? ''} ${error.extensions?.code ?? ''}`.toLowerCase();
    return marker.includes('not_found') || error.message.toLowerCase().includes('entity not found');
  });
}

function authMessage(errors: LinearGraphQLError[], status: number): string {
  if (errors.length > 0) {
    return errors.map((error) => error.message).join('; ');
  }
  return `authentication failed (HTTP ${status})`;
}

function httpOk(status: number): boolean {
  return status >= 200 && status < 300;
}

/** Two-letter avatar initials; Linear has no dedicated initials field so every caller derives one. */
function deriveInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return '?';
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Linear's Float priority as the raw string token the rest of the engine
 * compares on ('0'..'4').
 *
 * ROUNDED, not truncated or formatted: `String(2.0)` is already `'2'`, but a
 * value that ever arrives as `1.9999` would stringify to something no mapping
 * knows, and the scale is integral by definition. `0` maps to `'0'` — Linear's
 * "No priority" rung is a VALUE, not an absence, so it must never fall into the
 * null branch. Null survives only if the field was not selected at all.
 */
function mapPriority(value: number | null): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : null;
}

/**
 * The write-side inverse of {@link mapPriority}: a provider-raw token
 * (`'0'..'4'`, already mapped by the caller — see `IssueDraft.priority` /
 * `IssueContentPatch.priority`) to the Int Linear's mutations take.
 * `undefined` (field not present in the draft/patch) stays `undefined` so the
 * caller's "leave alone" / "provider default" intent survives into the
 * GraphQL variables unchanged; `null` passes through as-is (Linear's
 * `IssueUpdateInput.priority`/`IssueCreateInput.priority` are nullable Ints)
 * even though in practice the priority mapping never actually produces `null`
 * for this provider — `'0'` (No priority) is Linear's real unset rung, per
 * `TrackerIssue.priority`'s doc comment.
 */
function toLinearPriorityInt(token: string | null | undefined): number | null | undefined {
  if (token === undefined || token === null) return token;
  return Number(token);
}

function mapIssueNode(node: LinearIssueNode): TrackerIssue {
  return {
    externalId: node.id,
    identifier: node.identifier,
    title: node.title,
    description: node.description && node.description.length > 0 ? node.description : null,
    url: node.url,
    stateId: node.state.id,
    assignee: node.assignee
      ? {
          id: node.assignee.id,
          name: node.assignee.name,
          initials: deriveInitials(node.assignee.displayName || node.assignee.name),
        }
      : null,
    estimate: node.estimate,
    parentExternalId: node.parent?.id ?? null,
    updatedAt: node.updatedAt,
    archivedAt: node.archivedAt,
    priority: mapPriority(node.priority),
    // ALWAYS null for Linear: it models no issue TYPE, and label emulation is
    // out of scope, so there is nothing a category could be read from.
    category: null,
    // ALWAYS null for Linear, and stated explicitly rather than left off: this
    // adapter has `capabilities.idempotentCreate`, so the outbox's client key IS
    // the created issue's id. A lost create is recovered by external id (a
    // point lookup), no marker is ever written into a body, and there is
    // therefore nothing to surface here. See TrackerIssue.recoveryClientKey.
    recoveryClientKey: null,
  };
}

function buildIssueFilter(selection: TrackerSourceSelection, sinceIso?: string): LinearIssueFilter {
  const filter: LinearIssueFilter = { team: { id: { eq: selection.containerId } } };
  if (selection.narrowKind === 'project') {
    filter.project = { id: { eq: selection.narrowId } };
  } else if (selection.narrowKind === 'cycle') {
    filter.cycle = { id: { eq: selection.narrowId } };
  }
  // 'all' (and 'view'/'module', which listNarrows never produces for Linear)
  // fall through to the team-only filter.
  if (sinceIso) {
    filter.updatedAt = { gte: sinceIso };
  }
  return filter;
}

async function paginateConnection<TNode>(
  fetchPage: (after: string | null) => Promise<LinearConnection<TNode>>
): Promise<TNode[]> {
  const collected: TNode[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await fetchPage(after);
    collected.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) {
      break;
    }
    after = page.pageInfo.endCursor;
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface LinearAdapterOptions {
  apiKey: string;
  /** Injected at construction so adapter tests never touch the network. */
  fetchImpl?: FetchLike;
  /**
   * Per-request abort budget; defaults to {@link TRACKER_REQUEST_TIMEOUT_MS}.
   * Injectable so a test can prove the abort path in milliseconds instead of
   * waiting out the real budget.
   */
  requestTimeoutMs?: number;
}

export class LinearAdapter implements TrackerAdapter {
  readonly provider: TrackerProvider = 'linear';
  readonly capabilities: TrackerAdapterCapabilities = {
    nativeParentAutoClose: true,
    selfHostedBaseUrl: false,
    idempotentCreate: true,
    // Linear has no issue-type field at all (category is Dart-only, per the
    // locked scope decision — no label emulation in v1).
    contentWrite: { title: true, description: true, priority: true, category: false },
    // `issueArchive(trash: true)` — probe L1 confirmed it sets `archivedAt`
    // and `trashed`, is restorable (visible under `includeArchived: true`,
    // and by direct id lookup), and is exactly the milder-than-delete
    // operation the locked scope decision requires. Read from the shared
    // table so the outbound trigger — which gates on the capability WITHOUT
    // an adapter in hand — can never disagree with this adapter.
    archive: PROVIDER_ARCHIVE_CAPABILITY.linear,
  };

  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly requestTimeoutMs: number;

  constructor(options: LinearAdapterOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? TRACKER_REQUEST_TIMEOUT_MS;
  }

  async validateCredentials(): Promise<TrackerWorkspaceIdentity> {
    const data = await this.request<ValidateCredentialsResponse>(VALIDATE_CREDENTIALS_QUERY);
    return {
      workspaceId: data.organization.id,
      workspaceName: data.organization.name,
      actorLabel: data.viewer.displayName ?? data.viewer.name,
    };
  }

  /**
   * The Map step's groups: Linear PROJECTS first, whole TEAMS as a fallback
   * section.
   *
   * A project is emitted once per team it spans, not once per project, because
   * the selection a group carries has to be one the engine can already filter
   * on: `{team, project}` is exactly `buildIssueFilter`'s existing narrow, so no
   * engine change is needed and a project spanning two teams cannot land its
   * two teams' issues under one state mapping (Linear workflow states are
   * per-team — hence `stateScopeKey` = the team id).
   *
   * The "Whole teams" section is not redundant: many workspaces do not use
   * projects at all, and an issue in NO project is only reachable through a team
   * group.
   */
  async listGroups(): Promise<TrackerGroupTree> {
    const [projects, teams] = await Promise.all([
      paginateConnection<LinearProjectWithTeamsNode>((after) =>
        this.request<ListProjectsWithTeamsResponse>(LIST_PROJECTS_WITH_TEAMS_QUERY, { after }).then(
          (data) => data.projects
        )
      ),
      paginateConnection<LinearTeamNode>((after) =>
        this.request<ListTeamsResponse>(LIST_TEAMS_QUERY, { after }).then((data) => data.teams)
      ),
    ]);

    const projectGroups: TrackerGroup[] = [];
    for (const project of projects) {
      const projectTeams = project.teams?.nodes ?? [];
      // A project with no team has no addressable issue filter — it is skipped
      // rather than guessed at; its issues stay reachable via a team group.
      for (const team of projectTeams) {
        const sourceLabel = `${project.name} · ${team.name}`;
        projectGroups.push({
          id: `${team.id}/${project.id}`,
          // The team only disambiguates where it has to: a single-team project
          // reads as itself, which is how the workspace names it.
          name: projectTeams.length === 1 ? project.name : sourceLabel,
          key: team.key,
          sourceLabel,
          selection: { containerId: team.id, narrowId: project.id, narrowKind: 'project' },
          stateScopeKey: team.id,
        });
      }
    }

    const teamGroups: TrackerGroup[] = teams.map((team) => ({
      id: `team:${team.id}`,
      name: team.name,
      key: team.key,
      sourceLabel: `${team.name} · whole team`,
      selection: { containerId: team.id, narrowId: 'all', narrowKind: 'all' },
      stateScopeKey: team.id,
    }));

    const sections: TrackerGroupSection[] = [
      { label: 'Projects', groups: projectGroups },
      { label: 'Whole teams', groups: teamGroups },
    ];
    return { sections };
  }

  async listContainers(): Promise<TrackerSourceTree> {
    const nodes = await paginateConnection<LinearTeamNode>((after) =>
      this.request<ListTeamsResponse>(LIST_TEAMS_QUERY, { after }).then((data) => data.teams)
    );
    const containers: TrackerSourceContainer[] = nodes.map((node) => ({
      id: node.id,
      name: node.name,
      key: node.key,
      // The exact open-issue count requires a separate expensive query per
      // team; skipped for v1 per the design doc.
      openIssueCount: null,
    }));
    return { containerLabel: 'Team', containers };
  }

  async listNarrows(containerId: string): Promise<TrackerSourceNarrow[]> {
    const [projects, cycles] = await Promise.all([
      paginateConnection<LinearProjectNode>((after) =>
        this.request<ListTeamProjectsResponse>(LIST_TEAM_PROJECTS_QUERY, { teamId: containerId, after }).then(
          (data) => data.team?.projects ?? emptyConnection<LinearProjectNode>()
        )
      ),
      paginateConnection<LinearCycleNode>((after) =>
        this.request<ListTeamCyclesResponse>(LIST_TEAM_CYCLES_QUERY, { teamId: containerId, after }).then(
          (data) => data.team?.cycles ?? emptyConnection<LinearCycleNode>()
        )
      ),
    ]);

    const narrows: TrackerSourceNarrow[] = [
      { id: 'all', kind: 'all', name: 'Whole team · all open issues', issueCount: null },
      ...projects.map((project) => ({
        id: project.id,
        kind: 'project' as const,
        name: project.name,
        issueCount: null,
      })),
      ...cycles.map((cycle) => ({
        id: cycle.id,
        kind: 'cycle' as const,
        name: cycle.name ? `Cycle ${cycle.number} · ${cycle.name}` : `Cycle ${cycle.number}`,
        issueCount: null,
      })),
    ];
    // Linear custom views are deliberately out of v1 scope (design doc "V2").
    return narrows;
  }

  async listStates(selection: TrackerSourceSelection): Promise<TrackerState[]> {
    const data = await this.request<ListTeamStatesResponse>(LIST_TEAM_STATES_QUERY, {
      teamId: selection.containerId,
    });
    const nodes = data.team?.states.nodes ?? [];
    return nodes.map((node) => ({
      id: node.id,
      name: node.name,
      color: node.color,
      group: STATE_TYPE_TO_GROUP[node.type] ?? 'backlog',
    }));
  }

  /**
   * Linear's priority scale is FIXED and workspace-independent (Urgent / High /
   * Medium / Low / No priority), so this is stated rather than fetched — there is
   * no query behind it and nothing a workspace owner can rename. The tokens are
   * the RAW `'0'..'4'` values the engine compares on; the human labels are a UI
   * concern and are attached where the picker is rendered, not here.
   *
   * `categories: null` — Linear models no issue type at all.
   */
  async listFieldOptions(): Promise<TrackerFieldOptionsRaw> {
    return { priorities: [...LINEAR_PRIORITY_TOKENS], categories: null };
  }

  async listIssues(selection: TrackerSourceSelection, sinceIso?: string): Promise<TrackerIssue[]> {
    const filter = buildIssueFilter(selection, sinceIso);
    const nodes = await paginateConnection<LinearIssueNode>((after) =>
      this.request<ListIssuesResponse>(LIST_ISSUES_QUERY, { filter, after }).then((data) => data.issues)
    );
    return nodes.map(mapIssueNode);
  }

  async listIssueIds(selection: TrackerSourceSelection): Promise<string[]> {
    const filter = buildIssueFilter(selection);
    const nodes = await paginateConnection<{ id: string }>((after) =>
      this.request<ListIssueIdsResponse>(LIST_ISSUE_IDS_QUERY, { filter, after }).then((data) => data.issues)
    );
    return nodes.map((node) => node.id);
  }

  async getIssue(externalId: string): Promise<TrackerIssue | null> {
    const { data, errors, status } = await this.execute<GetIssueResponse>(GET_ISSUE_QUERY, { id: externalId });
    if (status === 401 || isAuthError(errors)) {
      throw new TrackerAuthError('linear', authMessage(errors, status), status);
    }
    if (isEntityNotFoundError(errors)) {
      return null;
    }
    if (errors.length > 0) {
      throw new TrackerApiError('linear', errors.map((error) => error.message).join('; '), status);
    }
    if (!httpOk(status)) {
      throw new TrackerApiError('linear', `unexpected HTTP status ${status}`, status);
    }
    const issue = data?.issue ?? null;
    return issue ? mapIssueNode(issue) : null;
  }

  async createSubIssue(parentExternalId: string, draft: IssueDraft, clientKey: string): Promise<TrackerIssue> {
    const { data, errors, status } = await this.execute<GetIssueTeamResponse>(GET_ISSUE_TEAM_QUERY, {
      id: parentExternalId,
    });
    if (status === 401 || isAuthError(errors)) {
      throw new TrackerAuthError('linear', authMessage(errors, status), status);
    }
    if (isEntityNotFoundError(errors) || !data?.issue) {
      throw new TrackerApiError('linear', `parent issue not found: ${parentExternalId}`, status);
    }
    if (errors.length > 0) {
      throw new TrackerApiError('linear', errors.map((error) => error.message).join('; '), status);
    }
    if (!httpOk(status)) {
      throw new TrackerApiError('linear', `unexpected HTTP status ${status}`, status);
    }

    const input: LinearIssueCreateInput = {
      // The client-supplied id IS the idempotency mechanism: outbox recovery
      // is a getIssue(clientKey) lookup after a lost response/crash.
      id: clientKey,
      teamId: data.issue.team.id,
      parentId: parentExternalId,
      title: draft.title,
      description: draft.description,
      stateId: draft.stateId,
      priority: toLinearPriorityInt(draft.priority),
    };
    return this.issueCreate(input);
  }

  /**
   * Top-level create (the PUSH direction). No parent lookup is needed — a
   * Linear issue is filed against a TEAM, which is exactly what the source
   * selection's `containerId` is — so this is the create mutation and nothing
   * else. The client-supplied id keeps it idempotent, same as the sub-issue
   * path: a repeat POST with the same id is a no-op rather than a second issue.
   */
  async createIssue(
    selection: TrackerSourceSelection,
    draft: IssueDraft,
    clientKey: string
  ): Promise<TrackerIssue> {
    return this.issueCreate({
      id: clientKey,
      teamId: selection.containerId,
      title: draft.title,
      description: draft.description,
      stateId: draft.stateId,
      priority: toLinearPriorityInt(draft.priority),
    });
  }

  /** The shared `issueCreate` call + failure check behind both create paths. */
  private async issueCreate(input: LinearIssueCreateInput): Promise<TrackerIssue> {
    const created = await this.request<CreateIssueResponse>(CREATE_ISSUE_MUTATION, { input });
    if (!created.issueCreate.success || !created.issueCreate.issue) {
      throw new TrackerApiError('linear', 'issueCreate reported failure', null);
    }
    return mapIssueNode(created.issueCreate.issue);
  }

  async updateIssueState(externalId: string, stateId: string): Promise<void> {
    const data = await this.request<UpdateIssueStateResponse>(UPDATE_ISSUE_STATE_MUTATION, {
      id: externalId,
      input: { stateId },
    });
    if (!data.issueUpdate.success) {
      throw new TrackerApiError('linear', `issueUpdate reported failure for ${externalId}`, null);
    }
  }

  /**
   * One generalized `issueUpdate` carrying only the keys `patch` actually
   * sets (checked via `!== undefined`, per `IssueContentPatch`'s contract),
   * selecting the full issue node back — the echo-suppression baseline's
   * stamp source (invariant 1).
   *
   * `category` is never mapped onto anything: Linear has no issue-type
   * field, `capabilities.contentWrite.category` says so, and the caller is
   * the one that must never populate it for this provider.
   */
  async updateIssueContent(externalId: string, patch: IssueContentPatch): Promise<TrackerIssue | null> {
    const input: LinearIssueUpdateInput = {};
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.description !== undefined) input.description = patch.description;
    if (patch.priority !== undefined) input.priority = toLinearPriorityInt(patch.priority);
    const data = await this.request<UpdateIssueContentResponse>(UPDATE_ISSUE_CONTENT_MUTATION, {
      id: externalId,
      input,
    });
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new TrackerApiError('linear', `issueUpdate reported failure for ${externalId}`, null);
    }
    return mapIssueNode(data.issueUpdate.issue);
  }

  /**
   * `issueArchive(trash: true)` — the L1-winning route (see
   * `ARCHIVE_ISSUE_MUTATION`; `issueUpdate({ trashed: true })` is rejected
   * and must never be used). An "entity not found"-class GraphQL error is
   * treated as SUCCESS — the twin was already trashed/deleted by some other
   * path — mirroring the 404-is-success rule the REST adapters apply to
   * their own not-found status; every other error still propagates.
   */
  async archiveIssue(externalId: string): Promise<void> {
    const { data, errors, status } = await this.execute<ArchiveIssueResponse>(ARCHIVE_ISSUE_MUTATION, {
      id: externalId,
    });
    if (status === 401 || isAuthError(errors)) {
      throw new TrackerAuthError('linear', authMessage(errors, status), status);
    }
    if (isEntityNotFoundError(errors)) {
      return;
    }
    if (errors.length > 0) {
      throw new TrackerApiError('linear', errors.map((error) => error.message).join('; '), status);
    }
    if (!httpOk(status)) {
      throw new TrackerApiError('linear', `unexpected HTTP status ${status}`, status);
    }
    if (!data?.issueArchive.success) {
      throw new TrackerApiError('linear', `issueArchive reported failure for ${externalId}`, null);
    }
  }

  /**
   * Low-level POST + JSON parse; never throws on GraphQL-level errors — callers
   * decide.
   *
   * EVERY call carries an abort timeout (see TRACKER_REQUEST_TIMEOUT_MS): a
   * request that never settles would pin the sync engine's per-connection lock
   * for the life of the process. The abort surfaces as an ordinary
   * TrackerApiError with a NULL status, which is what puts it on the outbox's
   * RETRY path rather than its terminal one — a timeout says nothing about
   * whether the write is valid.
   */
  private async execute<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<{ data: T | null; errors: LinearGraphQLError[]; status: number }> {
    let httpResponse: Response;
    try {
      httpResponse = await this.fetchImpl(LINEAR_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Personal API keys go BARE — no "Bearer" prefix (that's OAuth2-only).
          Authorization: this.apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      throw new TrackerApiError(
        'linear',
        describeTransportFailure(err, this.requestTimeoutMs),
        null
      );
    }

    let body: LinearGraphQLResponse<T>;
    try {
      body = (await httpResponse.json()) as LinearGraphQLResponse<T>;
    } catch (err) {
      throw new TrackerApiError('linear', `invalid JSON response: ${errorMessage(err)}`, httpResponse.status);
    }

    return { data: body.data ?? null, errors: body.errors ?? [], status: httpResponse.status };
  }

  /** Standard request path: throws typed errors, asserts `data` is present. */
  private async request<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const { data, errors, status } = await this.execute<T>(query, variables);
    if (status === 401 || isAuthError(errors)) {
      throw new TrackerAuthError('linear', authMessage(errors, status), status);
    }
    if (errors.length > 0) {
      throw new TrackerApiError('linear', errors.map((error) => error.message).join('; '), status);
    }
    if (!httpOk(status)) {
      throw new TrackerApiError('linear', `unexpected HTTP status ${status}`, status);
    }
    if (data === null) {
      throw new TrackerApiError('linear', 'empty response body', status);
    }
    return data;
  }
}
