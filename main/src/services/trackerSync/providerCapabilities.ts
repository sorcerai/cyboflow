/**
 * trackerSync/providerCapabilities — the per-provider facts the OUTBOUND
 * TRIGGERS need before any adapter exists.
 *
 * writeBack.ts runs inline on the entity-change broadcast and holds no adapter:
 * building one decrypts a stored key and it makes zero network calls by design
 * (see that module's header). But two of its decisions are capability
 * decisions, and getting them wrong is not a cosmetic problem:
 *
 *   - ARCHIVE. Enqueuing an `archive_issue` for a provider whose adapter would
 *     throw leaves an outbox row that can never settle, and
 *     `collectOutboxBlockers` is KIND-AGNOSTIC — an unresolved row for an
 *     issue halts the inbound batch at that issue on every pass, forever. The
 *     capability gate is what keeps that row from being written at all
 *     (docs/proposals/tracker-field-writeback.md invariant 5's reasoning,
 *     applied to a capability rather than a mode).
 *   - CATEGORY. Already answered by `categoryMapping.providerSupportsCategorySync`,
 *     which the trigger reuses rather than duplicating here.
 *
 * SINGLE DEFINITION, not a mirror: each adapter's own `CAPABILITIES.archive`
 * READS this table, so the trigger and the adapter can never disagree about a
 * provider, and a fourth provider fails to compile here (invariant 8) instead
 * of silently defaulting to "archivable".
 *
 * Only the archive half lives here. The `contentWrite` flags are per-FIELD and
 * consulted at drain time, where the adapter is in hand and the real
 * `capabilities` object is authoritative.
 */
import type { TrackerProvider } from '../../../../shared/types/trackerSync';
import type { TrackerAdapterCapabilities } from './adapterTypes';

/**
 * What each provider's `archiveIssue` actually does remotely. See
 * {@link TrackerAdapterCapabilities.archive} for what the three values mean and
 * each adapter's `CAPABILITIES` for the per-provider evidence (Linear's probe
 * L1, Dart's D5, and Plane's unprobed P1 that pins it to `'none'`).
 */
export const PROVIDER_ARCHIVE_CAPABILITY: Record<
  TrackerProvider,
  TrackerAdapterCapabilities['archive']
> = {
  linear: 'trash',
  plane: 'none',
  dart: 'trash',
};

/**
 * Can a local archive/delete reach this provider as a remote trash/archive at
 * all? False (Plane today) means the archive trigger must enqueue NOTHING —
 * the ruling path falls back to the cancelled-state write instead, which is a
 * write its adapter genuinely supports.
 */
export function providerSupportsRemoteArchive(provider: TrackerProvider): boolean {
  return PROVIDER_ARCHIVE_CAPABILITY[provider] !== 'none';
}

/**
 * What a removal ruling's "cancel it in the tracker" ACTUALLY does for one
 * link: the provider's trash/archive, or the cancelled-state fallback. The
 * single decision both {@link import('./trackerSyncService').TrackerSyncService}'s
 * enqueue and the removal dialog's disclosure consult — the dialog promising
 * one action while the enqueue performs the other was adversarial round 3's
 * finding 2. `'off'` forces the fallback because an `archive_issue` row is
 * undrainable while the archive direction is off (the claim filter excludes
 * its kind), and invariant 5 says "Sync now" must never drain a direction the
 * user declined.
 */
export function removalWriteBackAction(
  provider: TrackerProvider,
  archiveSyncMode: 'auto' | 'manual' | 'off',
): 'archive' | 'cancel' {
  return archiveSyncMode !== 'off' && providerSupportsRemoteArchive(provider)
    ? 'archive'
    : 'cancel';
}
