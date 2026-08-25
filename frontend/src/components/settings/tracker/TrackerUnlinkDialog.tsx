/**
 * TrackerUnlinkDialog — the local-removal ruling from
 * docs/proposals/tracker-sync-integration.md ("Deletes"): deleting or archiving
 * a LINKED backlog entity asks what should happen to its tracker issue(s)
 * before the local delete runs. Exactly two answers, both of which drop EVERY
 * live link the entity has — an entity can be synced to more than one tracker
 * at once (one link per provider), and the ruling is deliberately GLOBAL rather
 * than per-provider: a deleted entity must not leave a live link pointing at it
 * from any tracker, so scoping the choice would just strand the others.
 *
 *   Keep in <trackers>    -> unlink only; every issue is left exactly as it is.
 *   Archive in <trackers> -> unlink AND queue the strongest non-destructive
 *                            write each provider offers: its own trash/archive
 *                            where one exists (Linear, Dart) AND the
 *                            connection's archive sync is on, and a move into
 *                            the tracker's CANCELLED group otherwise (Plane,
 *                            whose public v1 API has no archive endpoint — or
 *                            any connection whose archive sync is 'off', where
 *                            an archive row could never drain).
 *
 * We never hard-delete on the remote side, so archiving is deliberately the
 * strongest option offered. Each link arrives with `removalAction` — computed
 * server-side by the SAME `removalWriteBackAction` decision the enqueue uses —
 * so the copy and the confirm button promise exactly the action the service
 * performs, never an archive that would silently degrade to a cancelled state.
 *
 * DISCLOSURE. `links` is EVERY live link this entity has (never just one) —
 * the whole reason this dialog takes an array: the ruling below is applied to
 * all of them by `handleLocalRemoval`/`unlinkEntity`, so a dialog that named
 * only the first provider would silently trash the others' issues too.
 *
 * THIS DIALOG ONLY COLLECTS THE ANSWER. Both buttons call
 * `cyboflow.tracker.stageUnlinkRuling`, which mutates NOTHING — it records the
 * ruling in the main process — and then hand control back through `onResolved`,
 * where the caller opens the ordinary archive/delete confirm. The ruling is
 * applied by that confirm's entity write when it commits, so backing out of it
 * leaves the entity, its links and every tracker issue untouched and the unused
 * ruling simply expires. (The previous design unlinked here, up front: a user
 * who then cancelled the confirm kept the entity but had already lost the link
 * and possibly cancelled the remote issue.)
 *
 * DISMISSING CLEARS. A staged ruling is keyed by entity alone, so an abandoned
 * one would sit there consumable until it expires and could be spent by an
 * unrelated later removal. Dismissing this dialog therefore also fires
 * `cyboflow.tracker.clearUnlinkRuling` for the entity — discarding anything a
 * previous, backed-out round left staged. Fire-and-forget: the main side's TTL
 * is the backstop, and a failed clear must not trap the user in the dialog.
 *
 * `hasLinkedDescendants` says the delete will cascade into other synced entities
 * (an idea's epics/tasks, an epic's tasks); they inherit this same ruling, so
 * the copy says so before the user picks.
 *
 * Pure (no store reads) so it unit-tests with only the tRPC client mocked, and
 * mirrors the Backlog confirm dialogs' Modal/Header/Body/Footer shape.
 */
import { useEffect, useState } from 'react';
import { Link2Off, Archive } from 'lucide-react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../../ui/Modal';
import { trpc } from '../../../trpc/client';
import { providerMeta } from './trackerVocabulary';
import type {
  TrackerEntityLinkRef,
  TrackerEntityType,
} from '../../../../../shared/types/trackerSync';

/**
 * "Linear" | "Linear and Dart" | "Linear, Dart, and Plane" — the header and
 * button copy's disclosure of every tracker involved. `names` is never empty
 * here (the dialog only renders for a non-empty `links`).
 */
function joinNames(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

interface TrackerUnlinkDialogProps {
  /** The entity the user is about to remove locally. */
  entityType: TrackerEntityType;
  entityId: string;
  /** Display ref of that entity ("TASK-001"), for the header. */
  entityRef: string;
  /** What happens once the ruling lands — only the copy differs. */
  action: 'delete' | 'archive';
  /**
   * EVERY live link this entity has, as read by `tracker.linksForEntity` on
   * the delete intent — never just one, since the ruling applies to all of
   * them. Non-empty: the caller only renders this dialog once the query comes
   * back with at least one link.
   */
  links: TrackerEntityLinkRef[];
  /**
   * The delete will also remove synced CHILDREN (`tracker.hasLinkedDescendants`).
   * Only ever true for an idea/epic delete; the ruling covers them too.
   */
  hasLinkedDescendants?: boolean;
  isOpen: boolean;
  /** Dismissed without a ruling — the caller aborts the delete/archive too. */
  onClose: () => void;
  /** The ruling is recorded; the caller opens its ordinary confirm dialog. */
  onResolved: () => void;
}

export function TrackerUnlinkDialog({
  entityType,
  entityId,
  entityRef,
  action,
  links,
  hasLinkedDescendants = false,
  isOpen,
  onClose,
  onResolved,
}: TrackerUnlinkDialogProps): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setSubmitting(false);
    setError(null);
  }, [isOpen, entityId]);

  // Single-link case reads exactly as before (`joinedProviders` degenerates to
  // that one name) — the array only changes rendering once there is more than
  // one tracker to disclose.
  const providerNames = links.map((l) => providerMeta(l.provider).name);
  const joinedProviders = joinNames(providerNames);
  const multiple = links.length > 1;
  const entityLabel = entityType === 'idea' ? 'idea' : entityType === 'epic' ? 'epic' : 'task';
  const actionLabel = action === 'archive' ? 'Archiving' : 'Deleting';
  // What the ruling ACTUALLY does per link, decided server-side by the same
  // logic that enqueues it (removalWriteBackAction): the provider's
  // trash/archive, or the cancelled-state fallback when it has no archive OR
  // the connection's archive sync is off. The copy below is built from this so
  // the dialog never promises an archive the service will not perform.
  const anyArchives = links.some((l) => l.removalAction === 'archive');
  const anyCancels = links.some((l) => l.removalAction === 'cancel');
  const confirmLabel = !anyArchives
    ? `Mark cancelled in ${joinedProviders}`
    : anyCancels
      ? 'Archive / mark cancelled'
      : `Archive in ${joinedProviders}`;
  // Children only ever go with a DELETE — archiving an idea leaves its epics and
  // tasks on the board, so the ruling has nothing to inherit it.
  const rulesChildren = action === 'delete' && hasLinkedDescendants;

  /**
   * Dismissed without ruling. Discard whatever this entity may still have
   * staged before handing control back — see "DISMISSING CLEARS" above. The
   * clear is not awaited (and its failure is swallowed): the dialog must close
   * on the click, and the main side's TTL covers a clear that never lands.
   */
  const dismiss = (): void => {
    void trpc.cyboflow.tracker.clearUnlinkRuling
      .mutate({ entityType, entityId })
      .catch(() => undefined);
    onClose();
  };

  const rule = async (cancelRemote: boolean): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await trpc.cyboflow.tracker.stageUnlinkRuling.mutate({ entityType, entityId, cancelRemote });
      onResolved();
    } catch (err: unknown) {
      // Never fall through to the delete on a failed ruling: the user asked for
      // something to happen in the tracker, and silently skipping it is the one
      // outcome neither button offered.
      setError(
        err instanceof Error
          ? `Could not update ${joinedProviders}: ${err.message}`
          : `Could not update ${joinedProviders}.`,
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={dismiss} size="sm" showCloseButton={false}>
      <ModalHeader title={`${entityRef} is linked to ${joinedProviders}`} onClose={dismiss} />
      <ModalBody className="space-y-3">
        <div className="flex flex-col gap-2" data-testid="tracker-unlink-dialog">
          {multiple ? (
            <>
              <p className="text-sm text-text-secondary">
                {actionLabel} this {entityLabel} does not delete any of its linked issues —
                cyboflow never deletes issues in your tracker. Choose what happens to them:
              </p>
              <ul
                className="list-disc space-y-0.5 pl-4 text-sm text-text-secondary"
                data-testid="tracker-unlink-issue-list"
              >
                {links.map((l) => (
                  <li key={l.provider}>
                    <span className="font-semibold text-text-primary">
                      {l.externalIdentifier ?? 'the linked issue'}
                    </span>{' '}
                    in {providerMeta(l.provider).name} ·{' '}
                    {l.removalAction === 'archive' ? 'moved to trash/archive' : 'marked cancelled'}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-text-secondary">
              {actionLabel} this {entityLabel} does not delete{' '}
              <span className="font-semibold text-text-primary">
                {links[0].externalIdentifier ?? 'the linked issue'}
              </span>{' '}
              in {providerNames[0]} — cyboflow never deletes issues in your tracker. Choose what
              happens to it:
            </p>
          )}
          {rulesChildren && (
            <p className="text-xs text-text-tertiary" data-testid="tracker-unlink-children-note">
              This {entityLabel}&apos;s synced sub-items are deleted with it, and your choice
              applies to their issues too.
            </p>
          )}
          <p className="text-xs text-text-tertiary" data-testid="tracker-unlink-fine-print">
            {!anyCancels &&
              `Archiving moves ${multiple ? 'each issue' : 'the issue'} to ${
                multiple ? 'its tracker' : providerNames[0]
              }'s trash or archive. `}
            {!anyArchives &&
              `${joinedProviders} ${multiple ? 'are' : 'is'} not archived from here — archive
              sync is off for the connection, or the tracker has no archive — so the
              ${multiple ? 'issues are' : 'issue is'} marked cancelled instead. `}
            {anyArchives &&
              anyCancels &&
              `Issues marked above move to their tracker's trash or archive; the others are
              marked cancelled (archive sync off, or no archive support). `}
            Either way the {entityLabel} stops syncing with {joinedProviders}, and nothing
            happens until you confirm the {action} on the next step.
          </p>
          {error && (
            <p className="text-xs text-status-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void rule(false)}
          disabled={submitting}
          data-testid="tracker-unlink-keep"
          className="inline-flex items-center gap-1 rounded-button border border-border-primary bg-bg-primary px-3 py-1.5 text-sm font-medium text-text-primary hover:bg-bg-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Link2Off className="h-3.5 w-3.5" />
          Keep in {joinedProviders}
        </button>
        <button
          type="button"
          onClick={() => void rule(true)}
          disabled={submitting}
          data-testid="tracker-unlink-cancel-remote"
          className="inline-flex items-center gap-1 rounded-button bg-interactive px-3 py-1.5 text-sm font-medium text-text-on-interactive hover:bg-interactive-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Archive className="h-3.5 w-3.5" />
          {confirmLabel}
        </button>
      </ModalFooter>
    </Modal>
  );
}
