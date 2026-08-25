/**
 * Non-visual vocabulary for the Settings → Integrations tracker surface: the
 * per-provider copy + credential shape, the mapping-target list with its
 * state-group-seeded defaults, the sync-log marker palette, and the two shared
 * form-control class strings.
 *
 * Split from trackerShared.tsx (which holds the components) so neither file
 * mixes component and non-component exports.
 *
 * Wire shapes come from shared/types/trackerSync.ts; nothing here re-declares a
 * type that crosses the IPC boundary.
 */
import type {
  TrackerContentSyncMode,
  TrackerMappingTarget,
  TrackerProvider,
  TrackerState,
  TrackerStateGroup,
  TrackerStateMapping,
} from '../../../../../shared/types/trackerSync';
import type { EntityCategory, Priority } from '../../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** One catalog row's copy plus the credential fields its wizard Step 0 asks for. */
export interface TrackerProviderMeta {
  provider: TrackerProvider;
  name: string;
  description: string;
  /** Short text plate rendered in the row/header tile (no brand raster assets). */
  mark: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  /** Plane scopes every REST path under a workspace slug; Linear does not. */
  needsWorkspaceSlug: boolean;
  /** Plane can be self-hosted, so its origin is user-supplied (pre-filled with the cloud default). */
  defaultBaseUrl: string | null;
  /** Documentation card on Step 0 — what cyboflow reads and writes. */
  scopes: { label: string; granted: boolean }[];
  scopeFootnote: string;
  /**
   * Does this provider model a native issue TYPE the category mapping table
   * can target? Mirrors `categoryMapping.ts`'s `providerSupportsCategorySync`
   * table (main-side) — kept as its own table here, not derived from it,
   * because the wizard/connected-view bundle must not import main/src/services/*.
   * The house rule this exists for: no provider-string branches in tracker UI —
   * a caller reads this flag instead of checking `provider === 'dart'`.
   */
  supportsCategorySync: boolean;
}

export const TRACKER_PROVIDERS: readonly TrackerProviderMeta[] = [
  {
    provider: 'linear',
    name: 'Linear',
    description:
      'Map Linear projects or teams to cyboflow projects with two-way status sync.',
    mark: 'LN',
    apiKeyLabel: 'Personal API key',
    apiKeyHint: 'Linear → Settings → Security & access → Personal API keys.',
    needsWorkspaceSlug: false,
    defaultBaseUrl: null,
    scopes: [
      { label: 'read:issues', granted: true },
      { label: 'write:issues', granted: true },
    ],
    scopeFootnote: 'No access to comments, attachments, or billing.',
    supportsCategorySync: false,
  },
  {
    provider: 'plane',
    name: 'Plane',
    description:
      'Map Plane projects — cloud or self-hosted — to cyboflow projects with two-way status sync.',
    mark: 'PL',
    apiKeyLabel: 'Personal access token',
    apiKeyHint: 'Plane → Workspace settings → API tokens.',
    needsWorkspaceSlug: true,
    defaultBaseUrl: 'https://api.plane.so',
    scopes: [
      { label: 'read:issues', granted: true },
      { label: 'write:issues', granted: true },
    ],
    scopeFootnote: 'No access to comments, attachments, or billing.',
    supportsCategorySync: false,
  },
  {
    provider: 'dart',
    name: 'Dart',
    description: 'Map Dart spaces to cyboflow projects and write status back.',
    mark: 'DT',
    apiKeyLabel: 'Personal authentication token',
    apiKeyHint: 'Dart → Settings → Account → Authentication token.',
    // Dart scopes everything by the token itself and is cloud-only, so it needs
    // neither a workspace slug nor a base URL — see dartAdapter.ts.
    needsWorkspaceSlug: false,
    defaultBaseUrl: null,
    scopes: [
      { label: 'read:tasks', granted: true },
      { label: 'write:tasks', granted: true },
    ],
    scopeFootnote: 'No access to docs, comments, attachments, or billing.',
    supportsCategorySync: true,
  },
];

export function providerMeta(provider: TrackerProvider): TrackerProviderMeta {
  const meta = TRACKER_PROVIDERS.find((p) => p.provider === provider);
  // Every member of the union is in the table above; the fallback exists so the
  // return type is not needlessly optional.
  return meta ?? TRACKER_PROVIDERS[0];
}

// ---------------------------------------------------------------------------
// State mapping
// ---------------------------------------------------------------------------

/**
 * The mapping dropdown's options — cyboflow's four writable stages, opt-out,
 * and the one-way 'indev'. Listed in BOARD order (Idea → Ready → In
 * development → Done → Won't do) so the picker reads like the board does.
 *
 * 'In development' is labelled "(one way)" right in the option text because the
 * asymmetry is the whole point: picking it does not import anything, it names
 * which provider state a task entering In development is pushed to. See
 * MAPPING_TARGET_NOTE for the inline caption the picker shows once it is chosen.
 */
export const MAPPING_TARGETS: readonly { value: TrackerMappingTarget; label: string }[] = [
  { value: 'dont', label: "— Don't import" },
  { value: 'idea', label: 'Idea' },
  { value: 'ready', label: 'Ready for development' },
  { value: 'indev', label: 'In development (one way)' },
  { value: 'done', label: 'Done' },
  { value: 'wontdo', label: "Won't do" },
];

/**
 * The caption shown under a picker whose target needs a qualifier — keyed by
 * target so a future one-way target does not need another branch in the view.
 * `{provider}` is substituted with the provider's display name.
 */
export const MAPPING_TARGET_NOTE: Partial<Record<TrackerMappingTarget, string>> = {
  indev: 'One way only — pushed to {provider}, never imported.',
};

/** The note for a target with the provider name filled in, or null. */
export function mappingTargetNote(
  target: TrackerMappingTarget,
  providerName: string,
): string | null {
  const note = MAPPING_TARGET_NOTE[target];
  return note === undefined ? null : note.replace('{provider}', providerName);
}

export function mappingTargetLabel(target: TrackerMappingTarget): string {
  return MAPPING_TARGETS.find((t) => t.value === target)?.label ?? target;
}

/**
 * Seed defaults keyed by the adapter's canonical state group (every provider
 * normalize onto it, so the wizard never branches on provider here).
 */
export const DEFAULT_TARGET_BY_GROUP: Record<TrackerStateGroup, TrackerMappingTarget> = {
  triage: 'dont',
  backlog: 'idea',
  unstarted: 'ready',
  started: 'ready',
  completed: 'done',
  cancelled: 'wontdo',
};

/**
 * Build the mapping table's initial value. `previous` carries a user's overrides
 * across a re-fetch of the same source, so re-entering Step 3 never silently
 * resets a hand-picked row back to its group default.
 */
export function seedStateMapping(
  states: TrackerState[],
  previous?: TrackerStateMapping,
): TrackerStateMapping {
  const seeded: TrackerStateMapping = {};
  for (const state of states) {
    seeded[state.id] = previous?.[state.id] ?? DEFAULT_TARGET_BY_GROUP[state.group];
  }
  return seeded;
}

// ---------------------------------------------------------------------------
// Field write-back cadence (migration 118) — a THREE-state cousin of the
// direction controls above. `contentSyncMode`/`archiveSyncMode` are a
// SEPARATE type (TrackerContentSyncMode) from TrackerDirectionMode precisely
// so 'off' cannot leak onto status/pull/push — see trackerSync.ts's header —
// which is also why this gets its OWN options list and label function rather
// than reusing the wizard/connected-view's local `DIRECTION_OPTIONS` /
// `directionLabel` (a binary ternary that would render 'off' as "Manual").
// ---------------------------------------------------------------------------

export const CONTENT_MODE_OPTIONS: readonly { value: TrackerContentSyncMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'manual', label: 'Manual' },
  { value: 'off', label: 'Off' },
];

export function contentModeLabel(mode: TrackerContentSyncMode): string {
  if (mode === 'auto') return 'Auto';
  if (mode === 'manual') return 'Manual';
  return 'Off';
}

// ---------------------------------------------------------------------------
// Priority / category mapping (migration 118, Phase 6) — the wizard's value
// pickers. Both tables edit only `toProvider`; `toLocal` is never sent (the
// resolver falls back to the seed's own inbound table — see
// TrackerPriorityMappingOverlay's header in shared/types/trackerSync.ts), so
// there is exactly one half to seed and re-seed here.
// ---------------------------------------------------------------------------

/** P0-P6 in escalation order — the priority mapping table's row order. */
export const PRIORITY_LEVELS: readonly Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

/** feature/bug/chore — the category mapping table's row order. */
export const ENTITY_CATEGORIES: readonly EntityCategory[] = ['feature', 'bug', 'chore'];

/**
 * The priority table's initial value. Unlike {@link seedStateMapping}, the key
 * set never varies (always exactly the seven `Priority` levels), so a `previous`
 * edit survives a re-fetch wholesale rather than key-by-key.
 */
export function seedPriorityMapping(
  defaults: Record<Priority, string | null>,
  previous?: Record<Priority, string | null>,
): Record<Priority, string | null> {
  return previous ?? { ...defaults };
}

/** Same as {@link seedPriorityMapping}, for the category table. */
export function seedCategoryMapping(
  defaults: Record<EntityCategory, string | null>,
  previous?: Record<EntityCategory, string | null>,
): Record<EntityCategory, string | null> {
  return previous ?? { ...defaults };
}

// ---------------------------------------------------------------------------
// Sync-log markers
// ---------------------------------------------------------------------------

/**
 * Colour for a `TrackerSyncLogEntry.marker`. The engine owns the glyphs; this
 * only decides the column's tone, so an unknown marker degrades to muted rather
 * than dropping the line.
 */
export function logMarkerClass(marker: string): string {
  switch (marker) {
    case '▸':
    case '✓':
      return 'text-status-success';
    case '✎':
      return 'text-status-warning';
    case '●':
      return 'text-interactive';
    default:
      return 'text-text-tertiary';
  }
}

// ---------------------------------------------------------------------------
// Form-control chrome
// ---------------------------------------------------------------------------

/** Square text input carrying the surface/border tokens the cards use. */
export const trackerInputClass =
  'w-full rounded-none border border-border-primary bg-bg-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-focus focus:outline-none';

/** Square native `<select>` — deliberately native so the option list works everywhere. */
export const trackerSelectClass =
  'rounded-none border border-border-primary bg-bg-primary px-2 py-1 text-xs text-text-primary focus:border-border-focus focus:outline-none';
