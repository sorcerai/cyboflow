/**
 * trackerSync/priorityMapping — the local-priority ⇄ provider-priority
 * translation layer. Design: docs/proposals/tracker-field-writeback.md
 * ("Phase 2 — Inbound read + mapping modules", invariant 2).
 *
 * The sibling of {@link import('./stateMapping')} and deliberately the same
 * shape of module: a per-provider SEED, a persisted overlay laid over it, and
 * pure lookups in both directions. Nothing here touches sqlite or the network —
 * the caller supplies the provider's live option list and the connection's
 * stored overlay.
 *
 * TWO DIRECTIONS, AND THEY ARE NOT INVERSES OF EACH OTHER:
 *
 *   toProvider  Priority -> provider token   (7 local levels -> 4-5 provider rungs)
 *   toLocal     provider token -> Priority   (each rung -> ONE canonical level)
 *
 * The local scale has seven levels and every provider offers four or five, so
 * `toProvider` is MANY-TO-ONE (P2 and P3 both mean "medium") and cannot be
 * inverted without picking a winner. `toLocal` is that pick, stated explicitly:
 * medium comes back as P2, low as P4. Both halves are therefore persisted and
 * resolved independently — deriving one from the other would silently demote a
 * user's P3 to P2 the first time a pass ran.
 *
 * WHY COMPARISON HAPPENS IN PROVIDER SPACE (invariant 2). Because the mapping
 * is lossy, a diff taken in LOCAL space reads "P3 locally, P2 remotely" on an
 * issue nobody touched, and flaps the user's priority down on every pass. So
 * `TrackerIssue.priority` and the link baseline both carry the PROVIDER-RAW
 * token, the merge converts only the local side through `toProvider`, and the
 * conversion back through `toLocal` happens once, at the moment a remote change
 * is actually applied.
 *
 * CASE-INSENSITIVITY IS LOAD-BEARING, not politeness. Dart addresses priorities
 * by title and is MEASURED to be inconsistent about their case: `/config`
 * lists them lowercase (`critical`) while every task read returns Title case
 * (`Critical`). A case-sensitive `toLocal` would fail to resolve every single
 * Dart priority the seed came from. Tokens are therefore stored as the provider
 * spelled them (so a future write sends back something it accepts) and matched
 * with {@link providerTokensEqual} / a lowercased `toLocal` key.
 */
import type { Priority } from '../../../../shared/types/tasks';
import type { TrackerProvider } from '../../../../shared/types/trackerSync';

// ---------------------------------------------------------------------------
// Canonical rungs
// ---------------------------------------------------------------------------

/**
 * The provider-independent rungs every tracker's scale collapses onto. `unset`
 * is a rung, not the absence of one: Linear spells it `'0'` and Plane `'none'`
 * (both real, always-present values), while Dart spells it by omitting the
 * field entirely. That difference is exactly what {@link resolveToken}'s null
 * arm carries.
 */
type PriorityRung = 'urgent' | 'high' | 'medium' | 'low' | 'unset';

/**
 * OUTBOUND seed: which rung each local level means. P2/P3 share `medium` and
 * P4/P5 share `low` — the plan's default table, chosen so the round trip is
 * STABLE rather than evenly spread. An even spread would have to map some local
 * level onto a rung that maps back to a different level, which is the flap
 * invariant 2 exists to prevent.
 */
const RUNG_FOR_LOCAL: Record<Priority, PriorityRung> = {
  P0: 'urgent',
  P1: 'high',
  P2: 'medium',
  P3: 'medium',
  P4: 'low',
  P5: 'low',
  P6: 'unset',
};

/**
 * INBOUND seed: the single local level each rung comes back as — the winner of
 * the many-to-one collapse above. `unset -> P6` is the identity that keeps an
 * unprioritized remote import unprioritized locally.
 */
const LOCAL_FOR_RUNG: Record<PriorityRung, Priority> = {
  urgent: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P4',
  unset: 'P6',
};

/**
 * P0-P6 in escalation order, derived from {@link RUNG_FOR_LOCAL} rather than
 * written out again: that table is a `Record<Priority, …>`, so widening the
 * union fails to compile there, and taking this list from its keys means the
 * new level cannot be missed here. The cast is the one thing `Object.keys`
 * cannot express — its keys ARE `Priority` by the table's own type.
 */
const PRIORITIES = Object.keys(RUNG_FOR_LOCAL) as Priority[];

const RUNGS = Object.keys(LOCAL_FOR_RUNG) as PriorityRung[];

/**
 * The local level that MEANS "no priority" on this provider, or null when the
 * provider has none — Dart's P6 (its unset rung is the absent field), against
 * Linear's and Plane's real `'0'` / `'none'` tokens.
 *
 * Read off the CANONICAL table, which is what makes it the provider-static
 * answer: it is by construction `seedDefaultPriorityMapping(provider, null)`'s
 * null arm (`resolveToken` returns the canonical token verbatim when there is
 * no live list), so no live-option rename and no user overlay can move it. That
 * immovability is the whole point — see {@link localPriorityForToken} and
 * outboxWorker's `writablePriorityToken`, which discriminate the two meanings of
 * a null token against exactly this.
 */
function unsetLevelFor(provider: TrackerProvider): Priority | null {
  const canonical = CANONICAL_TOKENS[provider];
  return PRIORITIES.find((priority) => canonical[RUNG_FOR_LOCAL[priority]] === null) ?? null;
}

/**
 * Each provider's own spelling of the five rungs — the CANONICAL tokens, used
 * to seed a mapping and, for Dart, to recognize the matching entry in the live
 * workspace list.
 *
 * A `null` means the provider expresses that rung as NO VALUE: only Dart's
 * `unset`, whose cleared priority comes back as an absent key (probe D2).
 * Linear's `'0'` and Plane's `'none'` are ordinary tokens and are treated as
 * such everywhere.
 *
 * Typed `Record<TrackerProvider, …>` per invariant 8: a fourth provider fails
 * to compile here rather than silently seeding an empty mapping.
 */
const CANONICAL_TOKENS: Record<TrackerProvider, Record<PriorityRung, string | null>> = {
  linear: { urgent: '1', high: '2', medium: '3', low: '4', unset: '0' },
  plane: { urgent: 'urgent', high: 'high', medium: 'medium', low: 'low', unset: 'none' },
  dart: { urgent: 'critical', high: 'high', medium: 'medium', low: 'low', unset: null },
};

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * A connection's resolved priority mapping. See the module header for why the
 * two halves are independent rather than inverses.
 *
 * `toProvider[p] === null` means "this local level has no provider token" —
 * either the rung IS the provider's absence (Dart's P6) or the token the seed
 * wanted is not in the workspace's live list. Both read the same way to a
 * caller: there is no value to send, and nothing to compare against.
 *
 * `toLocal` is keyed by the LOWERCASED token (see the module header's casing
 * note); use {@link localPriorityForToken} rather than indexing it directly.
 */
export interface PriorityMapping {
  toProvider: Record<Priority, string | null>;
  toLocal: Record<string, Priority>;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

/**
 * The provider token a rung resolves to, given the provider's live option list.
 *
 *  - a null canonical token stays null — the rung IS the absence of a value,
 *    and no live list can contain it;
 *  - no live list (`null`, the "static scale / not discovered" case) means
 *    there is nothing to confirm against, so the canonical token stands;
 *  - otherwise the token must actually be OFFERED by the workspace, matched
 *    case-insensitively. A rung whose token has been renamed away resolves to
 *    null rather than to a value the provider would reject (Dart 400s on an
 *    unknown priority) or silently drop.
 *
 * The live list's OWN spelling wins, so a workspace that lists `Critical` gets
 * `Critical` stored rather than the canonical `critical`.
 */
function resolveToken(canonical: string | null, live: string[] | null): string | null {
  if (canonical === null) return null;
  if (live === null) return canonical;
  return live.find((token) => token.toLowerCase() === canonical.toLowerCase()) ?? null;
}

/**
 * Seed a fresh priority mapping for one provider — the wizard's pre-fill and
 * the sync pass's default.
 *
 * `liveOptions` is {@link import('../../../../shared/types/trackerSync').TrackerFieldOptions.priorities}
 * for the connection's provider: Dart's live `/config.priorities`, or `null`
 * when the caller has none in hand (Linear and Plane have fixed scales, and a
 * conflict-resolution path that resolves a mapping without an adapter in scope
 * legitimately passes null).
 *
 * Extra workspace tokens the canonical rungs do not name get NO `toLocal`
 * entry, deliberately: guessing which rung a bespoke priority belongs to would
 * apply a level the user never chose. An unmapped remote token instead resolves
 * to "no local change" and is surfaced in the pass's sync log.
 */
export function seedDefaultPriorityMapping(
  provider: TrackerProvider,
  liveOptions: string[] | null,
): PriorityMapping {
  const canonical = CANONICAL_TOKENS[provider];

  const toProvider = {} as Record<Priority, string | null>;
  for (const priority of PRIORITIES) {
    toProvider[priority] = resolveToken(canonical[RUNG_FOR_LOCAL[priority]], liveOptions);
  }

  const toLocal: Record<string, Priority> = {};
  for (const rung of RUNGS) {
    const token = resolveToken(canonical[rung], liveOptions);
    if (token !== null) toLocal[token.toLowerCase()] = LOCAL_FOR_RUNG[rung];
  }

  return { toProvider, toLocal };
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

/**
 * The persisted overlay's JSON shape (`tracker_connections.priority_mapping_json`,
 * migration 118). BOTH halves are stored because neither can be derived from
 * the other — see the module header.
 *
 * Either half may be absent, and an absent half keeps the seed's: a user who
 * only re-points P3 does not implicitly reset the inbound direction.
 */
interface PriorityMappingOverlay {
  toProvider?: Partial<Record<Priority, string | null>>;
  toLocal?: Record<string, Priority>;
}

/**
 * The mapping a sync pass actually runs on: {@link seedDefaultPriorityMapping}
 * over the CURRENT live options, overlaid by the connection's persisted
 * choices. Seeding first means a workspace that renamed a priority since the
 * wizard ran still has a sane default for the rest; overlaying second means
 * every explicit user choice wins.
 *
 * A missing / unparseable / non-object blob degrades to the seed rather than
 * throwing — the {@link import('./stateMapping').resolveEffectiveMapping}
 * contract, and for the same reason: a corrupt blob must not wedge sync. Each
 * ENTRY is validated on its own, so one bad value costs that value and not the
 * whole mapping.
 *
 * `overlayJson` is null until migration 118 adds the column; every Phase-2
 * caller passes null and gets the seed.
 *
 * AN OVERLAY TOKEN IS RE-VALIDATED AGAINST THE LIVE LIST, not restored verbatim,
 * and that is the difference between "the user chose this" and "the user chose
 * this and it still exists". The wizard persists the WHOLE seeded table, so
 * every outbound row is an overlay row: without this, a Dart priority rename
 * would be correctly dropped by the seed and then re-introduced by the overlay
 * laid on top of it, and the write would 400 — which the outbox reads as a
 * TERMINAL failure, not a mapping to confirm. A token the workspace no longer
 * offers therefore degrades to null, which the outbound path reads as "not
 * expressible" and OMITS (`writablePriorityToken`); it never clears the field.
 *
 * With no live list (`liveOptions === null`) the overlay stands verbatim: those
 * callers — the write-back triggers, the connection summary — deliberately
 * resolve offline, and having nothing to check against is not evidence of a
 * rename.
 *
 * `onStaleOverlayToken` is called once per degraded entry with the token that
 * was dropped, so a pass can surface "confirm the mapping" instead of failing
 * silently.
 */
export function resolveEffectivePriorityMapping(
  provider: TrackerProvider,
  liveOptions: string[] | null,
  overlayJson: string | null,
  onStaleOverlayToken?: (token: string) => void,
): PriorityMapping {
  const mapping = seedDefaultPriorityMapping(provider, liveOptions);
  const overlay = parseOverlay(overlayJson);
  if (overlay === null) return mapping;

  if (overlay.toProvider !== undefined) {
    for (const [priority, token] of Object.entries(overlay.toProvider)) {
      if (isPriority(priority) && (token === null || typeof token === 'string')) {
        const resolved = resolveToken(token, liveOptions);
        if (resolved === null && token !== null) onStaleOverlayToken?.(token);
        mapping.toProvider[priority] = resolved;
      }
    }
  }
  if (overlay.toLocal !== undefined) {
    for (const [token, priority] of Object.entries(overlay.toLocal)) {
      if (token.length > 0 && isPriority(priority)) mapping.toLocal[token.toLowerCase()] = priority;
    }
  }
  return mapping;
}

/** Parse the overlay blob; null when there is nothing usable to overlay. */
function parseOverlay(overlayJson: string | null): PriorityMappingOverlay | null {
  if (overlayJson === null || overlayJson.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(overlayJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  const overlay: PriorityMappingOverlay = {};
  if (isPlainObject(candidate.toProvider)) {
    overlay.toProvider = candidate.toProvider as Partial<Record<Priority, string | null>>;
  }
  if (isPlainObject(candidate.toLocal)) {
    overlay.toLocal = candidate.toLocal as Record<string, Priority>;
  }
  return overlay;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Is this a local priority level? Exported because a conflict payload stores the
 * resolved level as a bare string and the resolver has to re-narrow it (a blob
 * written by an older build, or hand-edited, may carry anything).
 */
export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/**
 * The provider token a local priority writes/compares as, or null when it has
 * none (see {@link PriorityMapping}).
 */
export function providerPriorityToken(
  mapping: PriorityMapping,
  priority: Priority,
): string | null {
  return mapping.toProvider[priority];
}

/**
 * The local priority a provider token comes back as, or null when the token is
 * UNMAPPED — a bespoke workspace priority, or one the seed's canonical name was
 * renamed away from. A null answer means "no local change"; the caller counts
 * it so the sync log can ask the user to confirm the mapping, and never guesses
 * a level.
 *
 * A null TOKEN is the provider's absence of a priority, which is a different
 * question: it resolves to the level that MEANS "no priority" on this provider
 * (Dart's P6), so the unset ⇄ P6 round trip closes. On Linear and Plane no level
 * means that — their unset is a real token — so a null token there is genuinely
 * unmappable and answers null.
 *
 * THAT LEVEL COMES FROM THE PROVIDER, NOT FROM THE EFFECTIVE MAPPING, which is
 * why this takes the provider at all. Scanning `toProvider` for the first level
 * with no token answers a different question — "which level currently has
 * nothing to send" — and every degraded or deliberately-unmapped level is also
 * an answer to it. A user who points P0 at "— Not sent" would make every unset
 * remote priority import as CRITICAL. {@link unsetLevelFor} reads the canonical
 * seed instead, which no rename and no overlay can move; it is the same
 * discrimination outboxWorker's `writablePriorityToken` makes in the outbound
 * direction, for the same reason.
 *
 * Remapping the unset level's OWN outbound token is still expressible and still
 * makes unset ⇄ level asymmetric — the accepted caveat of an overlay that edits
 * only one direction, unchanged here.
 */
export function localPriorityForToken(
  provider: TrackerProvider,
  mapping: PriorityMapping,
  token: string | null,
): Priority | null {
  if (token === null) return unsetLevelFor(provider);
  return mapping.toLocal[token.toLowerCase()] ?? null;
}

/**
 * Are two provider tokens the same value? Case-INSENSITIVE, because Dart hands
 * back the same priority as `critical` from `/config` and `Critical` from a
 * task read (module header), and a case-sensitive compare would report a change
 * on every pass. Null is only equal to null.
 *
 * Used for BOTH mapped fields — Dart addresses types by title with the same
 * casing looseness — so the category merge imports it from here rather than
 * growing a second copy.
 */
export function providerTokensEqual(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}
