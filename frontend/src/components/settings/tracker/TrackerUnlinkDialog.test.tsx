/**
 * TrackerUnlinkDialog — the local-removal ruling.
 *
 * Same harness as the other tracker component tests: the real component over a
 * module mock of the tRPC client.
 *
 * Coverage: both design choices are offered and named after the provider(s) —
 * `links` carries EVERY live link the entity has, and a two-provider case
 * discloses both in the title, body and buttons rather than naming only the
 * first; each STAGES its own `cancelRemote` — and stages ONLY, never
 * `unlinkEntity`, so nothing is mutated while the delete confirm behind this
 * dialog is still dismissible — and only then hands control back; the copy
 * says so, and says the ruling covers synced children on a cascading delete;
 * dismissing rules nothing and additionally CLEARS any ruling still staged for
 * the entity (a staged ruling is keyed by entity alone, so an abandoned one
 * would stay consumable); a rejected staging keeps the dialog open and does NOT
 * let the delete through.
 */
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerEntityLinkRef } from '../../../../../shared/types/trackerSync';

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tracker: {
        stageUnlinkRuling: { mutate: vi.fn() },
        clearUnlinkRuling: { mutate: vi.fn() },
        // Present but never expected to fire — the pre-confirm unlink is exactly
        // what this design removed.
        unlinkEntity: { mutate: vi.fn() },
      },
    },
  },
}));

// Imported after the mock so vi.mock hoisting is in effect.
import { TrackerUnlinkDialog } from './TrackerUnlinkDialog';
import { trpc } from '../../../trpc/client';

const mockStage = vi.mocked(trpc.cyboflow.tracker.stageUnlinkRuling.mutate);
const mockClear = vi.mocked(trpc.cyboflow.tracker.clearUnlinkRuling.mutate);
const mockUnlink = vi.mocked(trpc.cyboflow.tracker.unlinkEntity.mutate);

const LINK: TrackerEntityLinkRef = {
  provider: 'linear',
  externalIdentifier: 'CORE-142',
  externalUrl: 'https://linear.app/acme/issue/CORE-142',
  removalAction: 'archive',
};

const DART_LINK: TrackerEntityLinkRef = {
  provider: 'dart',
  externalIdentifier: 'DART-7',
  externalUrl: 'https://app.itsdart.com/t/DART-7',
  removalAction: 'archive',
};

const onClose = vi.fn();
const onResolved = vi.fn();

function renderDialog(props: Partial<Parameters<typeof TrackerUnlinkDialog>[0]> = {}) {
  return render(
    <TrackerUnlinkDialog
      entityType="task"
      entityId="tsk_1"
      entityRef="TASK-001"
      action="delete"
      links={[LINK]}
      isOpen
      onClose={onClose}
      onResolved={onResolved}
      {...props}
    />,
  );
}

beforeEach(() => {
  mockStage.mockReset().mockResolvedValue({ ok: true });
  mockClear.mockReset().mockResolvedValue({ ok: true });
  mockUnlink.mockReset().mockResolvedValue({ unlinked: true });
  onClose.mockReset();
  onResolved.mockReset();
});

describe('TrackerUnlinkDialog', () => {
  it('renders nothing when closed', () => {
    renderDialog({ isOpen: false });
    expect(screen.queryByTestId('tracker-unlink-dialog')).not.toBeInTheDocument();
  });

  it('offers exactly the two design choices, named after the provider', () => {
    renderDialog();
    expect(screen.getByTestId('tracker-unlink-keep')).toHaveTextContent('Keep in Linear');
    expect(screen.getByTestId('tracker-unlink-cancel-remote')).toHaveTextContent(
      'Archive in Linear',
    );
    // The promise the design makes: cyboflow never deletes the remote issue.
    expect(screen.getByTestId('tracker-unlink-dialog')).toHaveTextContent(
      /never deletes issues in your tracker/i,
    );
    expect(screen.getByTestId('tracker-unlink-dialog')).toHaveTextContent('CORE-142');
    // ...and the staging promise: this dialog changes nothing on its own.
    expect(screen.getByTestId('tracker-unlink-dialog')).toHaveTextContent(
      /Nothing happens until you confirm/i,
    );
  });

  it('an entity linked to TWO providers discloses both, not just the first', () => {
    // The regression this fixes: the old single-link shape let the dialog say
    // "Archive in Linear" while the ruling was applied to every live link — an
    // entity ALSO synced to Dart had its Dart task trashed undisclosed. Passing
    // the whole array makes the copy name every provider involved.
    renderDialog({ links: [LINK, DART_LINK] });

    expect(screen.getByTestId('tracker-unlink-keep')).toHaveTextContent('Keep in Linear and Dart');
    expect(screen.getByTestId('tracker-unlink-cancel-remote')).toHaveTextContent(
      'Archive in Linear and Dart',
    );
    const dialog = screen.getByTestId('tracker-unlink-dialog');
    expect(dialog).toHaveTextContent('CORE-142');
    expect(dialog).toHaveTextContent('DART-7');
  });

  it('promises "Mark cancelled", never "Archive", when every link would only cancel', () => {
    // Finding 2 of adversarial round 3: under the DEFAULT archive_sync_mode
    // 'off' (and for Plane always), the ruling's remote action is the
    // cancelled-state write — a button that says "Archive" would promise an
    // action the service does not perform.
    renderDialog({ links: [{ ...LINK, removalAction: 'cancel' }] });
    expect(screen.getByTestId('tracker-unlink-cancel-remote')).toHaveTextContent(
      'Mark cancelled in Linear',
    );
    expect(screen.getByTestId('tracker-unlink-fine-print')).toHaveTextContent(
      /marked cancelled instead/i,
    );
    expect(screen.getByTestId('tracker-unlink-fine-print')).not.toHaveTextContent(
      /trash or archive/i,
    );
  });

  it('a MIXED archive/cancel link set annotates each issue with its real outcome', () => {
    renderDialog({
      links: [LINK, { ...DART_LINK, removalAction: 'cancel' }],
    });
    expect(screen.getByTestId('tracker-unlink-cancel-remote')).toHaveTextContent(
      'Archive / mark cancelled',
    );
    const list = screen.getByTestId('tracker-unlink-issue-list');
    expect(list).toHaveTextContent('CORE-142 in Linear · moved to trash/archive');
    expect(list).toHaveTextContent('DART-7 in Dart · marked cancelled');
  });

  it('the single-link case still reads exactly as it did before the array change', () => {
    renderDialog({ links: [LINK] });
    expect(screen.getByTestId('tracker-unlink-keep')).toHaveTextContent('Keep in Linear');
    expect(screen.getByTestId('tracker-unlink-cancel-remote')).toHaveTextContent(
      'Archive in Linear',
    );
    expect(screen.getByTestId('tracker-unlink-dialog')).toHaveTextContent(
      "Deleting this task does not delete CORE-142 in Linear",
    );
  });

  it('"Keep in <provider>" STAGES without cancelling, then releases the delete', async () => {
    renderDialog();
    fireEvent.click(screen.getByTestId('tracker-unlink-keep'));

    await waitFor(() => expect(mockStage).toHaveBeenCalledTimes(1));
    expect(mockStage).toHaveBeenCalledWith({
      entityType: 'task',
      entityId: 'tsk_1',
      cancelRemote: false,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();
    // The old design's pre-confirm mutation is gone for good.
    expect(mockUnlink).not.toHaveBeenCalled();
    // Choosing is not backing out — the ruling just staged must survive.
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('"Archive in <provider>" stages the remote archive, then releases the delete', async () => {
    renderDialog({ action: 'archive', entityType: 'idea', entityId: 'ide_9' });
    fireEvent.click(screen.getByTestId('tracker-unlink-cancel-remote'));

    await waitFor(() => expect(mockStage).toHaveBeenCalledTimes(1));
    expect(mockStage).toHaveBeenCalledWith({
      entityType: 'idea',
      entityId: 'ide_9',
      cancelRemote: true,
    });
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('says the ruling covers synced children when the delete will cascade', () => {
    renderDialog({ entityType: 'idea', entityId: 'ide_9', hasLinkedDescendants: true });
    expect(screen.getByTestId('tracker-unlink-children-note')).toHaveTextContent(
      /applies to their issues too/i,
    );
  });

  it('says nothing about children on an ARCHIVE — archiving takes none with it', () => {
    renderDialog({
      action: 'archive',
      entityType: 'idea',
      entityId: 'ide_9',
      hasLinkedDescendants: true,
    });
    expect(screen.queryByTestId('tracker-unlink-children-note')).not.toBeInTheDocument();
  });

  it('dismissing rules nothing and lets no delete through', () => {
    renderDialog();
    fireEvent.click(screen.getByText('Cancel'));

    expect(mockStage).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismissing CLEARS any ruling still staged for the entity', async () => {
    // The regression: a staged ruling is keyed by entity alone and stays
    // consumable for its whole TTL, so an answer the user backed out of could be
    // spent by an unrelated later archive/delete of the same entity.
    renderDialog({ entityType: 'idea', entityId: 'ide_9' });
    fireEvent.click(screen.getByText('Cancel'));

    await waitFor(() => expect(mockClear).toHaveBeenCalledTimes(1));
    expect(mockClear).toHaveBeenCalledWith({ entityType: 'idea', entityId: 'ide_9' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on dismiss even when the clear is rejected — the TTL is the backstop', async () => {
    mockClear.mockRejectedValueOnce(new Error('main is restarting'));
    renderDialog();
    fireEvent.click(screen.getByText('Cancel'));

    // Not awaited: the dialog hands control back on the click regardless.
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mockClear).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and blocks the delete when staging fails', async () => {
    mockStage.mockRejectedValueOnce(new Error('tracker unreachable'));
    renderDialog();
    fireEvent.click(screen.getByTestId('tracker-unlink-cancel-remote'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not update Linear/i);
    expect(onResolved).not.toHaveBeenCalled();
    expect(screen.getByTestId('tracker-unlink-dialog')).toBeInTheDocument();
  });
});
