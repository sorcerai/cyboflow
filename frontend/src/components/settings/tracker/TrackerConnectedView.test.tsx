/**
 * TrackerConnectedView — manage-surface tests.
 *
 * Same harness as IntegrationsSettings.test.tsx: the real component over a
 * module mock of the tRPC client.
 *
 * Coverage: each settings row sends the MINIMAL patch for its own field (never
 * a whole-connection write); mirroring is hidden while two-way is off; the log
 * renders the summary's entries verbatim; "Sync now" swaps in the pass's log;
 * the conflicts card appears for Manual mode / a non-zero count and its two
 * buttons resolve with the right choice; Disconnect confirms inline first; the
 * push-target note appears only when this mapping is not the pusher; and the
 * "Project mappings" card lists sibling mappings (project names, Pushes chip,
 * current-row highlight), arms a new push target, and removes a mapping —
 * closing the view when the removed row is the one being viewed.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  TrackerConflictSummary,
  TrackerConnectionSummary,
} from '../../../../../shared/types/trackerSync';

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tracker: {
        conflicts: { query: vi.fn() },
        mappings: { query: vi.fn() },
        setPushTarget: { mutate: vi.fn() },
        updateSettings: { mutate: vi.fn() },
        syncNow: { mutate: vi.fn() },
        resolveConflict: { mutate: vi.fn() },
        disconnect: { mutate: vi.fn() },
        updateCredentials: { mutate: vi.fn() },
      },
    },
  },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerConnectedView } from './TrackerConnectedView';
import { trpc } from '../../../trpc/client';

const mockConflicts = vi.mocked(trpc.cyboflow.tracker.conflicts.query);
const mockMappings = vi.mocked(trpc.cyboflow.tracker.mappings.query);
const mockSetPushTarget = vi.mocked(trpc.cyboflow.tracker.setPushTarget.mutate);
const mockUpdate = vi.mocked(trpc.cyboflow.tracker.updateSettings.mutate);
const mockSyncNow = vi.mocked(trpc.cyboflow.tracker.syncNow.mutate);
const mockResolve = vi.mocked(trpc.cyboflow.tracker.resolveConflict.mutate);
const mockDisconnect = vi.mocked(trpc.cyboflow.tracker.disconnect.mutate);
const mockUpdateCredentials = vi.mocked(trpc.cyboflow.tracker.updateCredentials.mutate);

const onClose = vi.fn();
const onChanged = vi.fn();
const onAddMapping = vi.fn();

// Deliberately unrelated to any `sourceLabel` used below, so a row's project
// name and its source label never collide as substrings of one another.
const PROJECT_NAMES: Record<number, string> = { 7: 'Core Product', 9: 'Marketing Site' };
const projectName = (id: number): string => PROJECT_NAMES[id] ?? `Project ${id}`;

function makeConnection(
  overrides: Partial<TrackerConnectionSummary> = {},
): TrackerConnectionSummary {
  return {
    id: 'conn-1',
    projectId: 7,
    provider: 'linear',
    status: 'active',
    workspaceName: 'Acme',
    actorLabel: 'J. Kesteva',
    baseUrl: null,
    sourceLabel: 'Core · Current cycle',
    sourceScope: { containerId: 'team-1', narrowId: 'cycle-12', narrowKind: 'cycle' },
    selectionMode: 'all',
    statusSyncMode: 'auto',
    pullMode: 'auto',
    pushMode: 'auto',
    contentSyncMode: 'off',
    archiveSyncMode: 'off',
    priorityMapping: {
      toProvider: { P0: '1', P1: '2', P2: '3', P3: '3', P4: '4', P5: '4', P6: '0' },
      toLocal: { '0': 'P6', '1': 'P0', '2': 'P1', '3': 'P2', '4': 'P4' },
    },
    categoryMapping: { toProvider: { feature: null, bug: null, chore: null }, toLocal: {} },
    mirrorSubissues: true,
    conflictMode: 'auto',
    pushTarget: true,
    stateMapping: { triage: 'dont', backlog: 'idea', todo: 'ready', done: 'done' },
    lastSyncAt: '2026-07-30T10:00:00.000Z',
    lastSyncLog: [
      { marker: '▸', line: 'GET /issues' },
      { marker: '✓', line: 'created 12 ideas' },
    ],
    linkedCount: 12,
    openConflictCount: 0,
    ...overrides,
  };
}

const CONFLICT: TrackerConflictSummary = {
  id: 41,
  connectionId: 'conn-1',
  kind: 'field_conflict',
  field: 'title',
  localValue: 'Token budget alerts',
  remoteValue: 'Budget alerts for tokens',
  entityRef: 'IDEA-004',
  entityTitle: 'Token budget alerts',
  createdAt: '2026-07-30T10:00:00.000Z',
};

function renderView(connection = makeConnection()): void {
  render(
    <TrackerConnectedView
      isOpen
      connection={connection}
      onClose={onClose}
      onChanged={onChanged}
      projectName={projectName}
      onAddMapping={onAddMapping}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConflicts.mockResolvedValue([]);
  mockMappings.mockResolvedValue([makeConnection()]);
  mockSetPushTarget.mockResolvedValue({ ok: true });
  mockUpdate.mockResolvedValue({ ok: true });
  mockResolve.mockResolvedValue({ ok: true });
  mockDisconnect.mockResolvedValue({ ok: true });
  mockUpdateCredentials.mockResolvedValue({
    workspaceId: 'ws-1',
    workspaceName: 'Acme',
    actorLabel: 'J. Kesteva',
  });
  mockSyncNow.mockResolvedValue({
    connectionId: 'conn-1',
    ran: true,
    swept: false,
    paused: false,
    entries: [{ marker: '✓', line: 'sync complete · next in 5m' }],
    error: null,
  });
});

describe('TrackerConnectedView — sync settings', () => {
  it('writes only the changed direction row back through updateSettings', async () => {
    renderView();

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Push to Linear' })).getByRole('button', {
        name: 'Manual',
      }),
    );
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ connectionId: 'conn-1', pushMode: 'manual' }),
    );

    // Mirroring + conflict rows are always visible, regardless of direction.
    expect(screen.getByRole('switch', { name: 'Mirror task breakdowns' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Conflict mode' })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('changes each direction row independently through updateSettings', async () => {
    renderView();

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Sync task status' })).getByRole('button', {
        name: 'Manual',
      }),
    );
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        statusSyncMode: 'manual',
      }),
    );

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Pull from Linear' })).getByRole('button', {
        name: 'Manual',
      }),
    );
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ connectionId: 'conn-1', pullMode: 'manual' }),
    );
  });

  it('patches mirroring and conflict mode independently', async () => {
    renderView();

    fireEvent.click(screen.getByRole('switch', { name: 'Mirror task breakdowns' }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        mirrorSubissues: false,
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Manual review' }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ connectionId: 'conn-1', conflictMode: 'manual' }),
    );
  });

  it('patches the two field write-back modes independently, all three states available', async () => {
    renderView();

    const contentGroup = screen.getByRole('group', { name: 'Sync task fields' });
    // Three states, unlike the binary direction rows above.
    expect(within(contentGroup).getAllByRole('button')).toHaveLength(3);
    expect(within(contentGroup).getByRole('button', { name: 'Off' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(within(contentGroup).getByRole('button', { name: 'Auto' }));
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({ connectionId: 'conn-1', contentSyncMode: 'auto' }),
    );

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Archive in Linear' })).getByRole('button', {
        name: 'Manual',
      }),
    );
    await waitFor(() =>
      expect(mockUpdate).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        archiveSyncMode: 'manual',
      }),
    );
  });

  it('renders the priority/category mapping counts read-only, category gated by provider support', async () => {
    renderView(
      makeConnection({
        priorityMapping: {
          toProvider: { P0: '1', P1: '2', P2: null, P3: null, P4: null, P5: null, P6: '0' },
          toLocal: {},
        },
      }),
    );

    expect(screen.getByText('3 of 7 priorities mapped')).toBeInTheDocument();
    // Linear has no category concept — no row, no editor.
    expect(screen.queryByText(/categories mapped/)).not.toBeInTheDocument();
    // Settles the mappings-card fetch fired on mount before the test returns.
    await screen.findAllByTestId('tracker-mapping-row');
  });

  it('shows the category count only for a provider with an issue type', async () => {
    renderView(
      makeConnection({
        provider: 'dart',
        categoryMapping: { toProvider: { feature: null, bug: 'Bug', chore: null }, toLocal: {} },
      }),
    );

    expect(screen.getByText('1 of 3 categories mapped')).toBeInTheDocument();
    await screen.findAllByTestId('tracker-mapping-row');
  });
});

describe('TrackerConnectedView — push target', () => {
  it('shows the muted note when this mapping does not push', async () => {
    renderView(makeConnection({ pushTarget: false }));

    expect(
      screen.getByText('New ideas push · off — another mapping for this project pushes'),
    ).toBeInTheDocument();
    // Settles the mappings-card fetch fired on mount before the test returns.
    await screen.findAllByTestId('tracker-mapping-row');
  });

  it('hides the note when this mapping is the pusher', async () => {
    renderView(makeConnection({ pushTarget: true }));

    expect(
      screen.queryByText('New ideas push · off — another mapping for this project pushes'),
    ).not.toBeInTheDocument();
    await screen.findAllByTestId('tracker-mapping-row');
  });
});

describe('TrackerConnectedView — sync log', () => {
  it('renders the summary log verbatim and replaces it with the Sync now result', async () => {
    renderView();

    expect(screen.getByText('GET /issues')).toBeInTheDocument();
    expect(screen.getByText('created 12 ideas')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));

    expect(await screen.findByText('sync complete · next in 5m')).toBeInTheDocument();
    expect(mockSyncNow).toHaveBeenCalledWith({ connectionId: 'conn-1' });
    expect(screen.queryByText('GET /issues')).not.toBeInTheDocument();
  });
});

describe('TrackerConnectedView — conflicts', () => {
  it('stays hidden while auto-resolution has nothing open', async () => {
    renderView();

    expect(screen.queryByTestId('tracker-conflicts-card')).not.toBeInTheDocument();
    expect(mockConflicts).not.toHaveBeenCalled();
    await screen.findAllByTestId('tracker-mapping-row');
  });

  it('lists open conflicts and resolves per side', async () => {
    mockConflicts.mockResolvedValue([CONFLICT]);
    renderView(makeConnection({ conflictMode: 'manual', openConflictCount: 1 }));

    expect(await screen.findByTestId('tracker-conflicts-card')).toBeInTheDocument();
    expect(mockConflicts).toHaveBeenCalledWith({ connectionId: 'conn-1' });
    expect(screen.getByText('Budget alerts for tokens')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Accept theirs' }));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({ conflictId: 41, choice: 'remote' }),
    );
    // The resolved row leaves the list without waiting for a refetch.
    await waitFor(() =>
      expect(screen.getByText('Nothing is waiting on a decision.')).toBeInTheDocument(),
    );
  });

  it('surfaces a non-zero count even in auto mode', async () => {
    mockConflicts.mockResolvedValue([CONFLICT]);
    renderView(makeConnection({ openConflictCount: 1 }));

    expect(await screen.findByTestId('tracker-conflicts-card')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept ours' }));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({ conflictId: 41, choice: 'local' }),
    );
  });
});

describe('TrackerConnectedView — paused reconnect', () => {
  it('hides the banner while the connection is active', async () => {
    renderView();
    expect(screen.queryByTestId('tracker-reconnect-banner')).not.toBeInTheDocument();
    await screen.findAllByTestId('tracker-mapping-row');
  });

  it('shows the banner and submits the typed key when paused', async () => {
    renderView(makeConnection({ status: 'paused' }));

    expect(screen.getByTestId('tracker-reconnect-banner')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Reconnect' });
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText('New Personal API key'), {
      target: { value: 'lin_new_key' },
    });
    expect(button).toBeEnabled();

    fireEvent.click(button);
    await waitFor(() =>
      expect(mockUpdateCredentials).toHaveBeenCalledWith({
        connectionId: 'conn-1',
        apiKey: 'lin_new_key',
      }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    // The key is cleared after a successful reconnect.
    await waitFor(() =>
      expect(screen.getByLabelText('New Personal API key')).toHaveValue(''),
    );
  });

  it('shows the failure inline and leaves the key in place', async () => {
    mockUpdateCredentials.mockRejectedValue(new Error('That key belongs to another workspace.'));
    renderView(makeConnection({ status: 'paused' }));

    fireEvent.change(screen.getByLabelText('New Personal API key'), {
      target: { value: 'lin_wrong_workspace' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'That key belongs to another workspace.',
    );
    expect(screen.getByLabelText('New Personal API key')).toHaveValue('lin_wrong_workspace');
  });

  it('disables the button while the request is in flight', async () => {
    let resolveUpdate: (identity: { workspaceId: string; workspaceName: string; actorLabel: string }) => void =
      () => {};
    mockUpdateCredentials.mockReturnValue(
      new Promise((resolve) => {
        resolveUpdate = resolve;
      }),
    );
    renderView(makeConnection({ status: 'paused' }));

    fireEvent.change(screen.getByLabelText('New Personal API key'), {
      target: { value: 'lin_new_key' },
    });
    const button = screen.getByRole('button', { name: /Reconnect/ });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeDisabled());

    resolveUpdate({ workspaceId: 'ws-1', workspaceName: 'Acme', actorLabel: 'J. Kesteva' });
    await waitFor(() => expect(mockUpdateCredentials).toHaveBeenCalledTimes(1));
  });
});

describe('TrackerConnectedView — disconnect', () => {
  it('confirms inline before disconnecting', async () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(screen.getByText('Disconnect? Existing links stay.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledWith({ connectionId: 'conn-1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});

describe('TrackerConnectedView — project mappings', () => {
  const SIBLING: TrackerConnectionSummary = makeConnection({
    id: 'conn-2',
    projectId: 9,
    status: 'paused',
    pushTarget: false,
    linkedCount: 3,
    sourceLabel: 'Growth · Sprint 4',
  });

  it('lists sibling rows with project names and a Pushes chip, highlighting the current row', async () => {
    mockMappings.mockResolvedValue([makeConnection(), SIBLING]);
    renderView();

    const rows = await screen.findAllByTestId('tracker-mapping-row');
    expect(rows).toHaveLength(2);
    const [currentRow, siblingRow] = rows;

    expect(within(currentRow).getByText('Core Product')).toBeInTheDocument();
    expect(within(currentRow).getByText('Pushes')).toBeInTheDocument();
    expect(within(currentRow).getByText('viewing')).toBeInTheDocument();
    expect(within(currentRow).getByText('Connected')).toBeInTheDocument();
    expect(within(currentRow).getByText('12 linked')).toBeInTheDocument();

    expect(within(siblingRow).getByText('Marketing Site')).toBeInTheDocument();
    expect(within(siblingRow).queryByText('Pushes')).not.toBeInTheDocument();
    expect(within(siblingRow).queryByText('viewing')).not.toBeInTheDocument();
    expect(within(siblingRow).getByText('Paused')).toBeInTheDocument();
    expect(within(siblingRow).getByText('3 linked')).toBeInTheDocument();
  });

  it('arms a sibling as the push target and refetches', async () => {
    mockMappings.mockResolvedValue([makeConnection(), SIBLING]);
    renderView();

    const rows = await screen.findAllByTestId('tracker-mapping-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Make push target' }));

    await waitFor(() =>
      expect(mockSetPushTarget).toHaveBeenCalledWith({ connectionId: 'conn-2' }),
    );
    await waitFor(() => expect(mockMappings).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();

    // The current row already pushes, so it never offers the button.
    expect(within(rows[0]).queryByRole('button', { name: 'Make push target' })).not.toBeInTheDocument();
  });

  it('removes a sibling mapping, keeping the view open', async () => {
    mockMappings.mockResolvedValue([makeConnection(), SIBLING]);
    renderView();

    const rows = await screen.findAllByTestId('tracker-mapping-row');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Remove' }));
    expect(mockDisconnect).not.toHaveBeenCalled();
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledWith({ connectionId: 'conn-2' }));
    await waitFor(() => expect(mockMappings).toHaveBeenCalledTimes(2));
    expect(onChanged).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('removes the current mapping and closes the view', async () => {
    mockMappings.mockResolvedValue([makeConnection(), SIBLING]);
    renderView();

    const rows = await screen.findAllByTestId('tracker-mapping-row');
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Remove' }));
    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(mockDisconnect).toHaveBeenCalledWith({ connectionId: 'conn-1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onChanged).toHaveBeenCalled();
  });

  it('calls onAddMapping from the card header button', async () => {
    renderView();
    await screen.findAllByTestId('tracker-mapping-row');

    fireEvent.click(screen.getByTestId('tracker-add-mapping'));
    expect(onAddMapping).toHaveBeenCalledTimes(1);
  });

  it('labels a PAUSED pusher honestly — it pushes only when reconnected', async () => {
    // A paused row holds the flag but enqueues nothing (write-back skips on
    // status first), so a green "Pushes" would claim a sync that is not happening.
    mockMappings.mockResolvedValue([
      makeConnection({ id: 'conn-paused', status: 'paused', pushTarget: true }),
    ]);
    renderView(makeConnection({ id: 'conn-paused', status: 'paused', pushTarget: true }));

    const rows = await screen.findAllByTestId('tracker-mapping-row');
    expect(within(rows[0]).getByText('Pushes when reconnected')).toBeInTheDocument();
    expect(within(rows[0]).queryByText('Pushes')).not.toBeInTheDocument();
  });

  it('never offers Make push target on a paused row while an ACTIVE same-project sibling exists', async () => {
    // The server refuses that swap (it would silently drop every idea filed
    // until the paused row reconnects), so the button is not offered either.
    mockMappings.mockResolvedValue([
      makeConnection(), // active, same project, the working pusher
      makeConnection({
        id: 'conn-paused-sib',
        status: 'paused',
        pushTarget: false,
        sourceLabel: 'Growth · Sprint 4',
      }),
    ]);
    renderView();

    const rows = await screen.findAllByTestId('tracker-mapping-row');
    expect(
      within(rows[1]).queryByRole('button', { name: 'Make push target' }),
    ).not.toBeInTheDocument();
    // A paused sibling in a DIFFERENT project keeps the affordance (SIBLING
    // above, projectId 9) — covered by the arming test.
  });
});
