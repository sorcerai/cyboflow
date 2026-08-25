/**
 * trackerSync/categoryMapping — the entity-category ⇄ provider-type translation
 * layer. Design: docs/proposals/tracker-field-writeback.md ("Phase 2 — Inbound
 * read + mapping modules").
 *
 * Structurally the sibling of {@link import('./priorityMapping')}: a per-provider
 * seed, a persisted overlay, pure lookups. Two things make it a separate module
 * rather than a parameterization of that one.
 *
 * 1. IT IS SUPPORTED BY EXACTLY ONE PROVIDER. Dart models a native task TYPE
 *    (`Task`, `Subtask`, `Bug`, …) that can carry cyboflow's `feature|bug|chore`
 *    classification; Linear and Plane model no type at all, and label emulation
 *    is explicitly out of v1 scope. So `TrackerIssue.category` is permanently
 *    null on two of the three providers, and the merge must read that as
 *    "unsupported", never as "the category was cleared" — hence
 *    {@link providerSupportsCategorySync}, which is what gates the arm.
 *
 * 2. THERE IS NO CANONICAL VOCABULARY TO FALL BACK ON. A priority scale is a
 *    documented enum on all three providers, so priorityMapping can seed from
 *    hard-coded rungs when it has no live list. Dart's types are ENTIRELY
 *    workspace-defined — the probe workspace offers `Task / Subtask / Project /
 *    Milestone`, none of which is a category — so a mapping can only be seeded
 *    from what the workspace actually offers. With no live list, or with no
 *    matching entry in it, the seed maps that category to NOTHING rather than
 *    inventing a type Dart would reject (a bogus type 400s, probe D3).
 *
 * TITLE-IS-THE-ID, so a workspace owner renaming a type invalidates a persisted
 * mapping. Matching is case-insensitive throughout (Dart reads back Title case
 * while `/config` lists lowercase — see priorityMapping's header), and an
 * unmapped remote type resolves to "no local change" plus a sync-log line
 * asking the user to confirm the mapping.
 */
import type { EntityCategory } from '../../../../shared/types/tasks';
import type { TrackerProvider } from '../../../../shared/types/trackerSync';

// ---------------------------------------------------------------------------
// Provider support
// ---------------------------------------------------------------------------

/**
 * Which providers can carry an entity category at all. A TABLE rather than a
 * `provider === 'dart'` check, per invariant 8 and the house rule against
 * provider-string branches in generic code: adding a fourth provider fails to
 * compile here instead of silently inheriting Dart's behavior.
 */
const CATEGORY_SYNC_SUPPORTED: Record<TrackerProvider, boolean> = {
  linear: false,
  plane: false,
  dart: true,
};

/**
 * Does this provider model something an entity category can map onto?
 *
 * False means `TrackerIssue.category` is structurally null for every issue, so
 * the merge's category arm stands down entirely — a null there is the absence
 * of the CONCEPT, and diffing local `feature` against it would archive a
 * classification the tracker never knew about.
 */
export function providerSupportsCategorySync(provider: TrackerProvider): boolean {
  return CATEGORY_SYNC_SUPPORTED[provider];
}

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * A connection's resolved category mapping.
 *
 * `toProvider[c] === null` means the workspace offers no type for that
 * category — the normal state on Linear/Plane, and on any Dart workspace that
 * has not created matching types. Nothing is ever invented to fill it.
 *
 * `toLocal` is keyed by the LOWERCASED provider type title; use
 * {@link localCategoryForToken} rather than indexing it directly.
 */
export interface CategoryMapping {
  toProvider: Record<EntityCategory, string | null>;
  toLocal: Record<string, EntityCategory>;
}

/**
 * The three local categories. Derived from a `Record<EntityCategory, …>` so a
 * widened union fails to compile rather than silently dropping a member here —
 * the same construction priorityMapping's PRIORITIES uses.
 */
const CATEGORY_ORDER: Record<EntityCategory, number> = { feature: 0, bug: 1, chore: 2 };
const CATEGORIES = Object.keys(CATEGORY_ORDER) as EntityCategory[];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * Seed a fresh category mapping — the wizard's pre-fill and the sync pass's
 * default.
 *
 * `liveOptions` is
 * {@link import('../../../../shared/types/trackerSync').TrackerFieldOptions.categories}
 * for the provider: Dart's live `/config.types`, or null everywhere else.
 *
 * The seed is a case-insensitive NAME MATCH of each local category against that
 * list, and nothing more. A category with no matching type maps to null in both
 * directions; an unrecognized workspace type gets no `toLocal` entry, so it
 * lands as "no local change" instead of an invented classification. An
 * unsupported provider short-circuits to the empty mapping regardless of what
 * was passed — there is no type field for a token to name.
 */
export function seedDefaultCategoryMapping(
  provider: TrackerProvider,
  liveOptions: string[] | null,
): CategoryMapping {
  const toProvider = {} as Record<EntityCategory, string | null>;
  const toLocal: Record<string, EntityCategory> = {};
  const live = providerSupportsCategorySync(provider) ? liveOptions : null;

  for (const category of CATEGORIES) {
    // The workspace's OWN spelling is kept ('Bug', not 'bug'), so a later write
    // sends back exactly what Dart offered.
    const match = resolveType(category, live);
    toProvider[category] = match;
    if (match !== null) toLocal[match.toLowerCase()] = category;
  }

  return { toProvider, toLocal };
}

/**
 * The workspace's own spelling of a type title, or null when it offers none.
 *
 * With no live list there is nothing to confirm against and nothing to fall back
 * on either — unlike a priority scale there is no canonical vocabulary here
 * (module header, point 2) — so an unconfirmable title is simply not mapped.
 */
function resolveType(title: string, live: string[] | null): string | null {
  return live?.find((type) => type.toLowerCase() === title.toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

/**
 * The persisted overlay's JSON shape
 * (`tracker_connections.category_mapping_json`, migration 118). Both halves are
 * stored for the reason priorityMapping's header gives: `toProvider` is not
 * invertible in general, so the inbound direction is its own stored decision.
 */
interface CategoryMappingOverlay {
  toProvider?: Partial<Record<EntityCategory, string | null>>;
  toLocal?: Record<string, EntityCategory>;
}

/**
 * The mapping a sync pass actually runs on: {@link seedDefaultCategoryMapping}
 * over the CURRENT live types, overlaid by the connection's persisted choices.
 *
 * A missing / unparseable / non-object blob degrades to the seed, and each
 * entry is validated on its own — the
 * {@link import('./stateMapping').resolveEffectiveMapping} contract: a corrupt
 * blob must not wedge sync, and one bad value must not cost the whole mapping.
 *
 * `overlayJson` is null until migration 118 adds the column; every Phase-2
 * caller passes null and gets the seed.
 *
 * OVERLAY TITLES ARE RE-VALIDATED against the live type list whenever there is
 * one, for the reason priorityMapping's twin gives: TITLE-IS-THE-ID here, the
 * wizard persists the whole table, and a title the workspace renamed away would
 * otherwise be re-introduced over a seed that correctly dropped it — a type Dart
 * 400s on (probe D3), which the outbox reads as a terminal failure. A stale
 * title degrades to null, i.e. the field is OMITTED from the write rather than
 * cleared. With no live list (`liveOptions === null`) there is nothing to check
 * against and the overlay stands verbatim.
 *
 * `onStaleOverlayToken` is called once per degraded entry with the dropped
 * title, so a pass can surface "confirm the mapping".
 */
export function resolveEffectiveCategoryMapping(
  provider: TrackerProvider,
  liveOptions: string[] | null,
  overlayJson: string | null,
  onStaleOverlayToken?: (token: string) => void,
): CategoryMapping {
  const mapping = seedDefaultCategoryMapping(provider, liveOptions);
  // An overlay cannot re-enable a field the provider does not have: it would
  // only produce a mapping the adapter has no way to read or write.
  if (!providerSupportsCategorySync(provider)) return mapping;

  const overlay = parseOverlay(overlayJson);
  if (overlay === null) return mapping;

  if (overlay.toProvider !== undefined) {
    for (const [category, token] of Object.entries(overlay.toProvider)) {
      if (isCategory(category) && (token === null || typeof token === 'string')) {
        const resolved =
          token === null || liveOptions === null ? token : resolveType(token, liveOptions);
        if (resolved === null && token !== null) onStaleOverlayToken?.(token);
        mapping.toProvider[category] = resolved;
      }
    }
  }
  if (overlay.toLocal !== undefined) {
    for (const [token, category] of Object.entries(overlay.toLocal)) {
      if (token.length > 0 && isCategory(category)) mapping.toLocal[token.toLowerCase()] = category;
    }
  }
  return mapping;
}

/** Parse the overlay blob; null when there is nothing usable to overlay. */
function parseOverlay(overlayJson: string | null): CategoryMappingOverlay | null {
  if (overlayJson === null || overlayJson.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(overlayJson);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const overlay: CategoryMappingOverlay = {};
  if (isPlainObject(parsed.toProvider)) {
    overlay.toProvider = parsed.toProvider as Partial<Record<EntityCategory, string | null>>;
  }
  if (isPlainObject(parsed.toLocal)) {
    overlay.toLocal = parsed.toLocal as Record<string, EntityCategory>;
  }
  return overlay;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this a local entity category? Exported for the same reason
 * {@link import('./priorityMapping').isPriority} is: a conflict payload stores
 * the resolved category as a bare string and the resolver must re-narrow it.
 */
export function isCategory(value: unknown): value is EntityCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** The provider type a local category writes/compares as, or null when it has none. */
export function providerCategoryToken(
  mapping: CategoryMapping,
  category: EntityCategory,
): string | null {
  return mapping.toProvider[category];
}

/**
 * The local category a provider type comes back as, or null when the type is
 * UNMAPPED. A null answer means "no local change"; the caller counts it for the
 * sync log rather than guessing a classification.
 *
 * A null TOKEN also answers null, and deliberately does NOT get priorityMapping's
 * unset ⇄ P6 treatment: `category` is NOT NULL locally, so there is no "no
 * category" state to round-trip to, and on Linear/Plane a null token is the
 * absence of the whole concept.
 */
export function localCategoryForToken(
  mapping: CategoryMapping,
  token: string | null,
): EntityCategory | null {
  if (token === null) return null;
  return mapping.toLocal[token.toLowerCase()] ?? null;
}
