/**
 * LinearAdapter unit tests.
 *
 * Drives the adapter through its injected `FetchLike` seam — no real network
 * call — so the GraphQL request shape (headers, variables, pagination) and
 * the response-mapping/error-classification logic are asserted
 * deterministically. Covers: bare-key auth + happy-path identity mapping,
 * HTTP-401 → TrackerAuthError, listGroups' project×team pairing (and the whole-
 * teams fallback), listIssues cross-page pagination with the
 * `updatedAt.gte` filter threaded through, Linear's "canceled" state type
 * mapping to the canonical "cancelled" group, createSubIssue's
 * client-key-as-id idempotency wiring, getIssue swallowing an
 * entity-not-found GraphQL error into `null`, and updateIssueState's
 * mutation shape.
 */
import { describe, it, expect } from 'vitest';
import { LinearAdapter } from './linearAdapter';
import { TrackerAuthError } from './errors';
import type { FetchLike, IssueDraft } from './adapterTypes';
import type { TrackerSourceSelection } from '../../../../shared/types/trackerSync';

interface RecordedCall {
  url: string;
  init: RequestInit;
}

interface QueuedResponse {
  status: number;
  body: unknown;
}

/** A minimal `Response` stand-in — only `status`/`json()` are ever read. */
function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Builds a `FetchLike` that answers with `responses` in order (the last
 * response repeats if more calls happen than were queued) and records every
 * call so tests can assert on the request shape.
 */
function createFetchMock(responses: QueuedResponse[]): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const queued = responses[calls.length - 1] ?? responses[responses.length - 1];
    return jsonResponse(queued.status, queued.body);
  }) as FetchLike;
  return { fetchImpl, calls };
}

function parseBody(call: RecordedCall): { query: string; variables?: Record<string, unknown> } {
  return JSON.parse(String(call.init.body)) as { query: string; variables?: Record<string, unknown> };
}

/** A GraphQL issue node shaped like Linear's `issues`/`issue` response. */
function issueNode(overrides: {
  id?: string;
  identifier?: string;
  parentId?: string | null;
  /** Linear reads priority as a FLOAT — `2` arrives as `2.0`. */
  priority?: number | null;
}): unknown {
  return {
    id: overrides.id ?? 'issue-1',
    identifier: overrides.identifier ?? 'COR-1',
    title: 'Some issue',
    description: null,
    url: 'https://linear.app/acme/issue/COR-1',
    state: { id: 'state-1' },
    assignee: null,
    estimate: null,
    parent: overrides.parentId ? { id: overrides.parentId } : null,
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    priority: overrides.priority === undefined ? 3 : overrides.priority,
    trashed: false,
  };
}

/** One page of `issues`, for the single-page reads below. */
function issuePage(nodes: unknown[]): { status: number; body: unknown } {
  return {
    status: 200,
    body: { data: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } },
  };
}

describe('LinearAdapter.validateCredentials', () => {
  it('resolves workspace identity and sends the bare API key (no Bearer prefix)', async () => {
    const { fetchImpl, calls } = createFetchMock([
      {
        status: 200,
        body: {
          data: {
            viewer: { id: 'u1', name: 'Jane Doe', displayName: 'jane' },
            organization: { id: 'org-1', name: 'Acme' },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'lin_api_secret', fetchImpl });

    const identity = await adapter.validateCredentials();

    expect(identity).toEqual({ workspaceId: 'org-1', workspaceName: 'Acme', actorLabel: 'jane' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.linear.app/graphql');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('lin_api_secret');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('LinearAdapter auth failures', () => {
  it('throws TrackerAuthError on an HTTP 401', async () => {
    const { fetchImpl } = createFetchMock([
      { status: 401, body: { errors: [{ message: 'Authentication required.' }] } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'revoked-key', fetchImpl });

    await expect(adapter.validateCredentials()).rejects.toBeInstanceOf(TrackerAuthError);
  });

  it('throws TrackerAuthError for an authentication-coded error on an HTTP 200', async () => {
    const { fetchImpl } = createFetchMock([
      {
        status: 200,
        body: {
          errors: [{ message: 'Invalid API key', extensions: { type: 'authentication_error' } }],
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'bad-key', fetchImpl });

    await expect(adapter.validateCredentials()).rejects.toBeInstanceOf(TrackerAuthError);
  });
});

/**
 * A `FetchLike` that answers PER OPERATION rather than per call index, keyed by
 * a substring of the query text. `listGroups` fires its two root queries
 * concurrently, so the call ORDER the other tests rely on is not stable there.
 * Each key's responses are consumed in order (the last repeats).
 */
function createQueryFetchMock(byOperation: Record<string, QueuedResponse[]>): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const consumed = new Map<string, number>();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { query } = parseBody(call);
    const key = Object.keys(byOperation).find((name) => query.includes(name));
    if (key === undefined) throw new Error(`createQueryFetchMock: unhandled operation in ${query}`);
    const responses = byOperation[key];
    const index = consumed.get(key) ?? 0;
    consumed.set(key, index + 1);
    const queued = responses[index] ?? responses[responses.length - 1];
    return jsonResponse(queued.status, queued.body);
  }) as FetchLike;
  return { fetchImpl, calls };
}

describe('LinearAdapter.listGroups', () => {
  it('pairs each project with every team it spans, and paginates the project query', async () => {
    const { fetchImpl, calls } = createQueryFetchMock({
      ListProjectsWithTeams: [
        {
          status: 200,
          body: {
            data: {
              projects: {
                nodes: [
                  {
                    id: 'proj-1',
                    name: 'Platform',
                    teams: { nodes: [{ id: 'team-core', name: 'Core', key: 'COR' }] },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
              },
            },
          },
        },
        {
          status: 200,
          body: {
            data: {
              projects: {
                nodes: [
                  {
                    id: 'proj-2',
                    name: 'Redesign',
                    teams: {
                      nodes: [
                        { id: 'team-core', name: 'Core', key: 'COR' },
                        { id: 'team-web', name: 'Web', key: 'WEB' },
                      ],
                    },
                  },
                  // A project no team owns has no addressable filter.
                  { id: 'proj-orphan', name: 'Orphan', teams: { nodes: [] } },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
      ListTeams: [
        {
          status: 200,
          body: {
            data: {
              teams: {
                nodes: [{ id: 'team-core', name: 'Core', key: 'COR' }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    });
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const { sections } = await adapter.listGroups();

    expect(sections.map((section) => section.label)).toEqual(['Projects', 'Whole teams']);
    expect(sections[0].groups).toEqual([
      {
        id: 'team-core/proj-1',
        // Single-team project: the team is not spelled into the name.
        name: 'Platform',
        key: 'COR',
        sourceLabel: 'Platform · Core',
        selection: { containerId: 'team-core', narrowId: 'proj-1', narrowKind: 'project' },
        stateScopeKey: 'team-core',
      },
      {
        id: 'team-core/proj-2',
        name: 'Redesign · Core',
        key: 'COR',
        sourceLabel: 'Redesign · Core',
        selection: { containerId: 'team-core', narrowId: 'proj-2', narrowKind: 'project' },
        stateScopeKey: 'team-core',
      },
      {
        id: 'team-web/proj-2',
        name: 'Redesign · Web',
        key: 'WEB',
        sourceLabel: 'Redesign · Web',
        selection: { containerId: 'team-web', narrowId: 'proj-2', narrowKind: 'project' },
        // Linear states are per-TEAM, so the same project maps under two scopes.
        stateScopeKey: 'team-web',
      },
    ]);
    expect(calls.filter((call) => parseBody(call).query.includes('ListProjectsWithTeams'))).toHaveLength(2);
  });

  it('offers whole teams as their own section, so an issue in no project is reachable', async () => {
    const { fetchImpl } = createQueryFetchMock({
      ListProjectsWithTeams: [
        {
          status: 200,
          body: {
            data: { projects: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          },
        },
      ],
      ListTeams: [
        {
          status: 200,
          body: {
            data: {
              teams: {
                nodes: [{ id: 'team-core', name: 'Core', key: 'COR' }],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      ],
    });
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const { sections } = await adapter.listGroups();

    expect(sections[0].groups).toEqual([]);
    expect(sections[1]).toEqual({
      label: 'Whole teams',
      groups: [
        {
          id: 'team:team-core',
          name: 'Core',
          key: 'COR',
          sourceLabel: 'Core · whole team',
          selection: { containerId: 'team-core', narrowId: 'all', narrowKind: 'all' },
          stateScopeKey: 'team-core',
        },
      ],
    });
  });
});

describe('LinearAdapter.listIssues', () => {
  it('paginates across two pages and threads the updatedAt gte filter through', async () => {
    const { fetchImpl, calls } = createFetchMock([
      {
        status: 200,
        body: {
          data: {
            issues: {
              nodes: [issueNode({ id: 'issue-1' })],
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
            },
          },
        },
      },
      {
        status: 200,
        body: {
          data: {
            issues: {
              nodes: [issueNode({ id: 'issue-2' })],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const issues = await adapter.listIssues(
      { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' },
      '2026-06-01T00:00:00.000Z'
    );

    expect(issues.map((issue) => issue.externalId)).toEqual(['issue-1', 'issue-2']);
    expect(calls).toHaveLength(2);

    const firstVariables = parseBody(calls[0]).variables ?? {};
    expect(firstVariables.after).toBeNull();
    expect(firstVariables.filter).toMatchObject({
      team: { id: { eq: 'team-1' } },
      updatedAt: { gte: '2026-06-01T00:00:00.000Z' },
    });

    const secondVariables = parseBody(calls[1]).variables ?? {};
    expect(secondVariables.after).toBe('cursor-1');
    expect(secondVariables.filter).toMatchObject({
      updatedAt: { gte: '2026-06-01T00:00:00.000Z' },
    });
  });
});

describe('LinearAdapter priority mapping', () => {
  it('normalizes the Float priority to the raw string token', async () => {
    const { fetchImpl } = createFetchMock([issuePage([issueNode({ priority: 2 })])]);
    const [issue] = await new LinearAdapter({ apiKey: 'key', fetchImpl }).listIssues({
      containerId: 'team-1',
      narrowId: 'all',
      narrowKind: 'all',
    });
    expect(issue.priority).toBe('2');
  });

  it('treats 0 as the real "No priority" VALUE, never as an absence', async () => {
    // The trap: `0` is falsy, and a `?? null` or a truthiness check would turn
    // Linear's No-priority rung into "we did not read this field", which the
    // merge would then take the never-synced arm on forever.
    const { fetchImpl } = createFetchMock([issuePage([issueNode({ priority: 0 })])]);
    const [issue] = await new LinearAdapter({ apiKey: 'key', fetchImpl }).listIssues({
      containerId: 'team-1',
      narrowId: 'all',
      narrowKind: 'all',
    });
    expect(issue.priority).toBe('0');
  });

  it('rounds a non-integral Float onto a rung the mapping knows', async () => {
    const { fetchImpl } = createFetchMock([issuePage([issueNode({ priority: 1.9999 })])]);
    const [issue] = await new LinearAdapter({ apiKey: 'key', fetchImpl }).listIssues({
      containerId: 'team-1',
      narrowId: 'all',
      narrowKind: 'all',
    });
    expect(issue.priority).toBe('2');
  });

  it('reads an absent priority as null and always reports no category', async () => {
    const { fetchImpl } = createFetchMock([issuePage([issueNode({ priority: null })])]);
    const [issue] = await new LinearAdapter({ apiKey: 'key', fetchImpl }).listIssues({
      containerId: 'team-1',
      narrowId: 'all',
      narrowKind: 'all',
    });
    expect(issue.priority).toBeNull();
    // Linear models no issue type; category is structurally null.
    expect(issue.category).toBeNull();
  });

  it('selects priority and trashed on the shared issue-node selection', async () => {
    // One selection serves list/get/create, so this pins all three at once.
    const { fetchImpl, calls } = createFetchMock([issuePage([issueNode({})])]);
    await new LinearAdapter({ apiKey: 'key', fetchImpl }).listIssues({
      containerId: 'team-1',
      narrowId: 'all',
      narrowKind: 'all',
    });
    const { query } = parseBody(calls[0]);
    expect(query).toContain('priority');
    expect(query).toContain('trashed');
  });
});

describe('LinearAdapter.listFieldOptions', () => {
  it('states its fixed five-rung scale and no categories, without a request', async () => {
    const { fetchImpl, calls } = createFetchMock([]);
    const options = await new LinearAdapter({ apiKey: 'key', fetchImpl }).listFieldOptions();
    expect(options).toEqual({ priorities: ['0', '1', '2', '3', '4'], categories: null });
    expect(calls).toHaveLength(0);
  });
});

describe('LinearAdapter.listStates', () => {
  it('maps the "canceled" workflow-state type to the canonical "cancelled" group', async () => {
    const { fetchImpl } = createFetchMock([
      {
        status: 200,
        body: {
          data: {
            team: {
              states: {
                nodes: [
                  { id: 'state-cancel', name: 'Canceled', color: '#ff0000', type: 'canceled' },
                  { id: 'state-done', name: 'Done', color: '#00ff00', type: 'completed' },
                ],
              },
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const states = await adapter.listStates({ containerId: 'team-1', narrowId: 'all', narrowKind: 'all' });

    expect(states.find((state) => state.id === 'state-cancel')?.group).toBe('cancelled');
    expect(states.find((state) => state.id === 'state-done')?.group).toBe('completed');
  });
});

describe('LinearAdapter.createSubIssue', () => {
  it('sends the client key as the created issue id, and the parent id, in the mutation variables', async () => {
    const { fetchImpl, calls } = createFetchMock([
      // 1) resolve the parent's team
      { status: 200, body: { data: { issue: { team: { id: 'team-1' } } } } },
      // 2) the issueCreate mutation
      {
        status: 200,
        body: {
          data: {
            issueCreate: {
              success: true,
              issue: issueNode({ id: 'client-key-123', identifier: 'COR-2', parentId: 'parent-1' }),
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });
    const draft: IssueDraft = { title: 'Sub issue', description: 'desc', stateId: 'state-todo' };

    const created = await adapter.createSubIssue('parent-1', draft, 'client-key-123');

    expect(created.externalId).toBe('client-key-123');
    expect(created.parentExternalId).toBe('parent-1');
    expect(calls).toHaveLength(2);

    const mutationVariables = parseBody(calls[1]).variables ?? {};
    expect(mutationVariables.input).toMatchObject({
      id: 'client-key-123',
      parentId: 'parent-1',
      teamId: 'team-1',
      title: 'Sub issue',
      description: 'desc',
      stateId: 'state-todo',
    });
  });
});

describe('LinearAdapter.createIssue', () => {
  it('files a TOP-LEVEL issue against the selection team, with no parent and the client key as its id', async () => {
    const { fetchImpl, calls } = createFetchMock([
      // ONE call: no parent to resolve a team from — the selection IS the team.
      {
        status: 200,
        body: {
          data: {
            issueCreate: {
              success: true,
              issue: issueNode({ id: 'client-key-push', identifier: 'COR-9' }),
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const created = await adapter.createIssue(
      { containerId: 'team-1', narrowId: 'cycle-3', narrowKind: 'cycle' },
      { title: 'Pushed idea', description: 'body', stateId: 'state-todo' },
      'client-key-push',
    );

    expect(created.externalId).toBe('client-key-push');
    expect(created.parentExternalId).toBeNull();
    expect(calls).toHaveLength(1);

    const input = (parseBody(calls[0]).variables ?? {}).input as Record<string, unknown>;
    expect(input).toMatchObject({
      id: 'client-key-push',
      teamId: 'team-1',
      title: 'Pushed idea',
      description: 'body',
      stateId: 'state-todo',
    });
    // No parent — that is what makes it top-level.
    expect(input.parentId).toBeUndefined();
  });

  it('throws when issueCreate reports failure', async () => {
    const { fetchImpl } = createFetchMock([
      { status: 200, body: { data: { issueCreate: { success: false, issue: null } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(
      adapter.createIssue(
        { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' },
        { title: 'Pushed idea' },
        'client-key-push',
      ),
    ).rejects.toThrow(/issueCreate reported failure/);
  });
});

describe('LinearAdapter.getIssue', () => {
  it('returns null on an entity-not-found GraphQL error instead of throwing', async () => {
    const { fetchImpl } = createFetchMock([
      {
        status: 200,
        body: {
          data: null,
          errors: [{ message: 'Entity not found: Issue', extensions: { type: 'not_found' } }],
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(adapter.getIssue('missing-id')).resolves.toBeNull();
  });
});

describe('LinearAdapter.updateIssueState', () => {
  it('posts the issueUpdate mutation with the external id and target state id', async () => {
    const { fetchImpl, calls } = createFetchMock([
      { status: 200, body: { data: { issueUpdate: { success: true } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await adapter.updateIssueState('issue-99', 'state-done');

    expect(calls).toHaveLength(1);
    const body = parseBody(calls[0]);
    expect(body.query).toContain('mutation UpdateIssueState');
    expect(body.variables).toEqual({ id: 'issue-99', input: { stateId: 'state-done' } });
  });
});

describe('LinearAdapter.updateIssueContent', () => {
  it('sends only the patched keys, converts the priority TOKEN to an Int, and returns the mapped post-write issue', async () => {
    const { fetchImpl, calls } = createFetchMock([
      {
        status: 200,
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: issueNode({ id: 'issue-99', identifier: 'COR-5', priority: 1 }),
            },
          },
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    const issue = await adapter.updateIssueContent('issue-99', { title: 'New title', priority: '1' });

    expect(calls).toHaveLength(1);
    const body = parseBody(calls[0]);
    expect(body.query).toContain('mutation UpdateIssueContent');
    // The full issue node is selected — this write is the echo-suppression
    // baseline's stamp source, and only the response carries it.
    expect(body.query).toContain('trashed');
    expect(body.variables).toEqual({ id: 'issue-99', input: { title: 'New title', priority: 1 } });
    expect(issue?.priority).toBe('1');
  });

  it('converts the "0" (No priority) token to the Int 0, never dropping it', async () => {
    const { fetchImpl, calls } = createFetchMock([
      { status: 200, body: { data: { issueUpdate: { success: true, issue: issueNode({ priority: 0 }) } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await adapter.updateIssueContent('issue-1', { priority: '0' });

    const body = parseBody(calls[0]);
    expect((body.variables?.input as Record<string, unknown>).priority).toBe(0);
  });

  it('leaves an unpatched field out of the mutation input entirely', async () => {
    const { fetchImpl, calls } = createFetchMock([
      { status: 200, body: { data: { issueUpdate: { success: true, issue: issueNode({}) } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await adapter.updateIssueContent('issue-1', { description: 'new body' });

    const body = parseBody(calls[0]);
    expect(body.variables?.input).toEqual({ description: 'new body' });
  });

  it('passes description straight through with no marker composition (Linear never writes one)', async () => {
    const { fetchImpl, calls } = createFetchMock([
      { status: 200, body: { data: { issueUpdate: { success: true, issue: issueNode({}) } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await adapter.updateIssueContent('issue-1', { description: 'plain markdown body' });

    const body = parseBody(calls[0]);
    expect((body.variables?.input as Record<string, unknown>).description).toBe('plain markdown body');
  });

  it('throws when issueUpdate reports failure or returns no issue', async () => {
    const { fetchImpl } = createFetchMock([
      { status: 200, body: { data: { issueUpdate: { success: false, issue: null } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(adapter.updateIssueContent('issue-1', { title: 'x' })).rejects.toThrow(
      /issueUpdate reported failure/,
    );
  });
});

describe('LinearAdapter.archiveIssue', () => {
  it('uses issueArchive(trash: true), never issueUpdate({ trashed: true })', async () => {
    const { fetchImpl, calls } = createFetchMock([
      { status: 200, body: { data: { issueArchive: { success: true } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await adapter.archiveIssue('issue-1');

    expect(calls).toHaveLength(1);
    const body = parseBody(calls[0]);
    expect(body.query).toContain('issueArchive');
    expect(body.query).toContain('trash: true');
    expect(body.query).not.toContain('issueUpdate');
    expect(body.variables).toEqual({ id: 'issue-1' });
  });

  it('tolerates an entity-not-found error as success — the twin was already trashed/deleted', async () => {
    const { fetchImpl } = createFetchMock([
      {
        status: 200,
        body: {
          data: null,
          errors: [{ message: 'Entity not found: Issue', extensions: { type: 'not_found' } }],
        },
      },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(adapter.archiveIssue('missing-id')).resolves.toBeUndefined();
  });

  it('throws TrackerAuthError on an HTTP 401', async () => {
    const { fetchImpl } = createFetchMock([{ status: 401, body: { errors: [] } }]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(adapter.archiveIssue('issue-1')).rejects.toBeInstanceOf(TrackerAuthError);
  });

  it('throws when issueArchive reports failure', async () => {
    const { fetchImpl } = createFetchMock([
      { status: 200, body: { data: { issueArchive: { success: false } } } },
    ]);
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(adapter.archiveIssue('issue-1')).rejects.toThrow(/issueArchive reported failure/);
  });
});

describe('LinearAdapter creates — draft priority', () => {
  it('converts IssueDraft.priority to Int on both createSubIssue and createIssue', async () => {
    const { fetchImpl: subFetch, calls: subCalls } = createFetchMock([
      { status: 200, body: { data: { issue: { team: { id: 'team-1' } } } } },
      { status: 200, body: { data: { issueCreate: { success: true, issue: issueNode({}) } } } },
    ]);
    await new LinearAdapter({ apiKey: 'key', fetchImpl: subFetch }).createSubIssue(
      'parent-1',
      { title: 'Sub', priority: '2' },
      'client-key-1',
    );
    expect((parseBody(subCalls[1]).variables?.input as Record<string, unknown>).priority).toBe(2);

    const { fetchImpl: topFetch, calls: topCalls } = createFetchMock([
      { status: 200, body: { data: { issueCreate: { success: true, issue: issueNode({}) } } } },
    ]);
    await new LinearAdapter({ apiKey: 'key', fetchImpl: topFetch }).createIssue(
      { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' },
      { title: 'Top', priority: '4' },
      'client-key-2',
    );
    expect((parseBody(topCalls[0]).variables?.input as Record<string, unknown>).priority).toBe(4);
  });

  it('leaves priority undefined on the input when the draft omits it', async () => {
    const { fetchImpl, calls } = createFetchMock([
      { status: 200, body: { data: { issueCreate: { success: true, issue: issueNode({}) } } } },
    ]);
    await new LinearAdapter({ apiKey: 'key', fetchImpl }).createIssue(
      { containerId: 'team-1', narrowId: 'all', narrowKind: 'all' },
      { title: 'No priority set' },
      'client-key-3',
    );
    const input = parseBody(calls[0]).variables?.input as Record<string, unknown>;
    expect(input.priority).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Request timeouts
// ---------------------------------------------------------------------------

/**
 * A fetch that never settles on its own and resolves only when the request's
 * abort signal fires — i.e. what a hung socket looks like from here. `reason`
 * is what Node's `AbortSignal.timeout` aborts with (a `TimeoutError`
 * DOMException), so the rejection this produces is the real one.
 */
function hangingFetch(): { fetchImpl: FetchLike; signals: Array<AbortSignal | undefined> } {
  const signals: Array<AbortSignal | undefined> = [];
  const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    signals.push(signal ?? undefined);
    return new Promise<Response>((_resolve, reject) => {
      if (signal === undefined || signal === null) return;
      signal.addEventListener('abort', () => {
        reject((signal as AbortSignal).reason as Error);
      });
    });
  }) as FetchLike;
  return { fetchImpl, signals };
}

describe('LinearAdapter request timeouts', () => {
  it('aborts a hung request and reports it as a RETRYABLE transport failure', async () => {
    // Without this the request never returns, and the sync engine's
    // per-connection lock is held for the life of the process — the connection
    // simply stops syncing, silently and permanently.
    const { fetchImpl, signals } = hangingFetch();
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl, requestTimeoutMs: 5 });

    await expect(adapter.validateCredentials()).rejects.toMatchObject({
      // Status NULL is the load-bearing part: outboxWorker only terminalizes a
      // 4xx, so a null-status failure takes the backoff-retry path. A timeout
      // says nothing about whether the write was valid.
      name: 'TrackerApiError',
      status: null,
      message: '[linear] request timed out after 5ms',
    });
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('carries an abort signal on every request path, not just the first', async () => {
    const { fetchImpl, signals } = hangingFetch();
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl, requestTimeoutMs: 5 });

    const selection: TrackerSourceSelection = {
      containerId: 'team-1',
      narrowId: 'all',
      narrowKind: 'all',
    };
    await expect(adapter.listIssues(selection)).rejects.toThrow('timed out');
    await expect(adapter.getIssue('issue-1')).rejects.toThrow('timed out');
    await expect(adapter.updateIssueState('issue-1', 'state-done')).rejects.toThrow('timed out');

    expect(signals).toHaveLength(3);
    for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('still reports an ordinary network failure as itself', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as FetchLike;
    const adapter = new LinearAdapter({ apiKey: 'key', fetchImpl });

    await expect(adapter.validateCredentials()).rejects.toMatchObject({
      name: 'TrackerApiError',
      status: null,
      message: '[linear] network request failed: ECONNREFUSED',
    });
  });
});
