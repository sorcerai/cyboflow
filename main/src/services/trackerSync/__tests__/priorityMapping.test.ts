/**
 * Unit tests for main/src/services/trackerSync/priorityMapping.ts — the local
 * P0-P6 <-> provider-priority translation layer.
 *
 * Pure functions over pure inputs: no DB, no adapter, no network. The live
 * option list is passed in exactly as `listFieldOptions()` would return it.
 *
 * Covers:
 *   - the seeded default table for all three providers, both directions;
 *   - the LOSSY collapse (P2/P3 -> medium, P4/P5 -> low) and the single
 *     canonical level each rung comes back as;
 *   - the P6 <-> unset round trip, and how it differs between a provider whose
 *     unset is a token (Linear '0', Plane 'none') and one whose unset is an
 *     absent value (Dart null);
 *   - Dart seeding from the LIVE /config list, including a workspace whose
 *     tokens are Title-cased, one that renamed a rung away, and extra bespoke
 *     tokens that must get no inbound mapping at all;
 *   - the persisted overlay: each half honored independently, unknown keys and
 *     bad values ignored, corrupt/absent JSON falling back to the seed;
 *   - case-insensitive lookup and token comparison (the measured Dart
 *     lowercase-config / Title-case-read split).
 */
import { describe, it, expect } from 'vitest';
import type { Priority } from '../../../../../shared/types/tasks';
import {
  isPriority,
  localPriorityForToken,
  providerPriorityToken,
  providerTokensEqual,
  resolveEffectivePriorityMapping,
  seedDefaultPriorityMapping,
} from '../priorityMapping';

/** The Dart probe workspace's real /config.priorities list (lowercase). */
const DART_CONFIG_PRIORITIES = ['critical', 'high', 'medium', 'low'];

const ALL: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];

/** The whole outbound table as a plain object, for one-shot comparison. */
function outbound(mapping: { toProvider: Record<Priority, string | null> }): Record<string, string | null> {
  return Object.fromEntries(ALL.map((p) => [p, mapping.toProvider[p]]));
}

describe('seedDefaultPriorityMapping — outbound table', () => {
  it('seeds Linear onto its numeric scale, collapsing P2/P3 and P4/P5', () => {
    const mapping = seedDefaultPriorityMapping('linear', null);
    expect(outbound(mapping)).toEqual({
      P0: '1',
      P1: '2',
      P2: '3',
      P3: '3',
      P4: '4',
      P5: '4',
      P6: '0',
    });
  });

  it('seeds Plane onto its lowercase enum', () => {
    const mapping = seedDefaultPriorityMapping('plane', null);
    expect(outbound(mapping)).toEqual({
      P0: 'urgent',
      P1: 'high',
      P2: 'medium',
      P3: 'medium',
      P4: 'low',
      P5: 'low',
      P6: 'none',
    });
  });

  it("seeds Dart's P6 onto NOTHING — its unset is an absent field, not a token", () => {
    const mapping = seedDefaultPriorityMapping('dart', DART_CONFIG_PRIORITIES);
    expect(outbound(mapping)).toEqual({
      P0: 'critical',
      P1: 'high',
      P2: 'medium',
      P3: 'medium',
      P4: 'low',
      P5: 'low',
      P6: null,
    });
  });
});

describe('seedDefaultPriorityMapping — inbound table', () => {
  it('brings every Linear rung back to its ONE canonical level', () => {
    const mapping = seedDefaultPriorityMapping('linear', null);
    expect(localPriorityForToken('linear', mapping, '1')).toBe('P0');
    expect(localPriorityForToken('linear', mapping, '2')).toBe('P1');
    expect(localPriorityForToken('linear', mapping, '3')).toBe('P2');
    expect(localPriorityForToken('linear', mapping, '4')).toBe('P4');
    expect(localPriorityForToken('linear', mapping, '0')).toBe('P6');
  });

  it('brings every Plane rung back to its ONE canonical level', () => {
    const mapping = seedDefaultPriorityMapping('plane', null);
    expect(localPriorityForToken('plane', mapping, 'urgent')).toBe('P0');
    expect(localPriorityForToken('plane', mapping, 'high')).toBe('P1');
    expect(localPriorityForToken('plane', mapping, 'medium')).toBe('P2');
    expect(localPriorityForToken('plane', mapping, 'low')).toBe('P4');
    expect(localPriorityForToken('plane', mapping, 'none')).toBe('P6');
  });

  it('answers null for a token the mapping does not name', () => {
    // A bespoke workspace priority. Guessing a level here would apply a
    // priority the user never chose, so the caller is told "no local meaning"
    // and reports it instead.
    const mapping = seedDefaultPriorityMapping('dart', [...DART_CONFIG_PRIORITIES, 'Blocker']);
    expect(localPriorityForToken('dart', mapping, 'Blocker')).toBeNull();
  });
});

describe('the P6 <-> unset round trip', () => {
  it('closes on Dart: P6 writes nothing, and nothing reads back as P6', () => {
    const mapping = seedDefaultPriorityMapping('dart', DART_CONFIG_PRIORITIES);
    expect(providerPriorityToken(mapping, 'P6')).toBeNull();
    expect(localPriorityForToken('dart', mapping, null)).toBe('P6');
  });

  it('closes on Linear/Plane through their unset TOKEN instead', () => {
    const linear = seedDefaultPriorityMapping('linear', null);
    expect(providerPriorityToken(linear, 'P6')).toBe('0');
    expect(localPriorityForToken('linear', linear, '0')).toBe('P6');
    // A null token is not something Linear ever sends (priority is always a
    // rung), and no local level maps out to "nothing", so it has no answer.
    expect(localPriorityForToken('linear', linear, null)).toBeNull();

    const plane = seedDefaultPriorityMapping('plane', null);
    expect(providerPriorityToken(plane, 'P6')).toBe('none');
    expect(localPriorityForToken('plane', plane, 'none')).toBe('P6');
    expect(localPriorityForToken('plane', plane, null)).toBeNull();
  });

  it('round-trips every level back to itself or to its rung-mate', () => {
    // The stability property the default table was chosen for: a level either
    // survives the round trip, or lands on the level that OWNS its rung —
    // never on a third one, which is what would make a pass oscillate.
    const mapping = seedDefaultPriorityMapping('plane', null);
    for (const level of ALL) {
      const back = localPriorityForToken('plane', mapping, providerPriorityToken(mapping, level));
      expect(back).not.toBeNull();
      // Applying the mapping twice is the same as applying it once.
      const again = localPriorityForToken(
        'plane',
        mapping,
        providerPriorityToken(mapping, back as Priority),
      );
      expect(again).toBe(back);
    }
  });

  it('resolves the unset token against the SEED, not the overlay-degraded table', () => {
    // The regression: a user who sends nothing for P0 (and, here, for most of
    // the scale) used to make every unset remote priority import as CRITICAL,
    // because the lookup scanned the effective table for the first level with
    // no outbound token. Dart's unset level is P6 by construction and no
    // overlay can move it.
    const mapping = resolveEffectivePriorityMapping(
      'dart',
      DART_CONFIG_PRIORITIES,
      JSON.stringify({ toProvider: { P0: null, P1: null, P3: null } }),
    );
    expect(providerPriorityToken(mapping, 'P0')).toBeNull();
    expect(localPriorityForToken('dart', mapping, null)).toBe('P6');
  });

  it('still has no unset level on Linear/Plane, whatever the overlay clears', () => {
    // Their unset is a real token ('0' / 'none'), so a null token remains
    // genuinely unmappable rather than becoming whichever level was cleared.
    const overlay = JSON.stringify({ toProvider: { P0: null, P6: null } });
    const linear = resolveEffectivePriorityMapping('linear', null, overlay);
    expect(localPriorityForToken('linear', linear, null)).toBeNull();
    const plane = resolveEffectivePriorityMapping('plane', null, overlay);
    expect(localPriorityForToken('plane', plane, null)).toBeNull();
  });
});

describe('Dart seeds from the LIVE workspace list', () => {
  it("keeps the workspace's own casing and still matches reads case-insensitively", () => {
    // MEASURED: /config lists priorities lowercase while task reads return
    // Title case. Both spellings must resolve to the same level.
    const mapping = seedDefaultPriorityMapping('dart', ['Critical', 'High', 'Medium', 'Low']);
    expect(providerPriorityToken(mapping, 'P0')).toBe('Critical');
    expect(localPriorityForToken('dart', mapping, 'critical')).toBe('P0');
    expect(localPriorityForToken('dart', mapping, 'CRITICAL')).toBe('P0');
  });

  it('maps a rung the workspace renamed away to NOTHING rather than inventing it', () => {
    // Dart 400s on an unknown priority (probe D1), so seeding a token the
    // workspace does not offer would queue a write that can only fail.
    const mapping = seedDefaultPriorityMapping('dart', ['high', 'medium', 'low']);
    expect(providerPriorityToken(mapping, 'P0')).toBeNull();
    expect(localPriorityForToken('dart', mapping, 'critical')).toBeNull();
    // The rungs it DOES offer are unaffected.
    expect(providerPriorityToken(mapping, 'P1')).toBe('high');
  });

  it('falls back to the canonical tokens when no live list is available', () => {
    // The conflict-resolution path resolves a mapping with no adapter in
    // scope. A priority scale is a documented enum, so the canonical names are
    // a sound default (unlike a category, which has none).
    const mapping = seedDefaultPriorityMapping('dart', null);
    expect(providerPriorityToken(mapping, 'P0')).toBe('critical');
    expect(localPriorityForToken('dart', mapping, 'Critical')).toBe('P0');
  });

  it('gives an extra workspace token no inbound entry', () => {
    const mapping = seedDefaultPriorityMapping('dart', [...DART_CONFIG_PRIORITIES, 'showstopper']);
    expect(localPriorityForToken('dart', mapping, 'showstopper')).toBeNull();
    // …and no local level was re-pointed at it either.
    expect(Object.values(outbound(mapping))).not.toContain('showstopper');
  });
});

describe('resolveEffectivePriorityMapping — overlay', () => {
  it('returns the seed when there is no overlay', () => {
    const seeded = seedDefaultPriorityMapping('linear', null);
    expect(resolveEffectivePriorityMapping('linear', null, null)).toEqual(seeded);
    expect(resolveEffectivePriorityMapping('linear', null, '')).toEqual(seeded);
  });

  it('honors an outbound override without touching the inbound half', () => {
    const mapping = resolveEffectivePriorityMapping(
      'linear',
      null,
      JSON.stringify({ toProvider: { P3: '4' } }),
    );
    expect(providerPriorityToken(mapping, 'P3')).toBe('4');
    // Unnamed levels keep the seed.
    expect(providerPriorityToken(mapping, 'P2')).toBe('3');
    // The inbound half is a SEPARATE decision and was not implied by this one.
    expect(localPriorityForToken('linear', mapping, '4')).toBe('P4');
  });

  it('honors an inbound override, lowercasing its key', () => {
    const mapping = resolveEffectivePriorityMapping(
      'dart',
      DART_CONFIG_PRIORITIES,
      JSON.stringify({ toLocal: { Critical: 'P1' } }),
    );
    expect(localPriorityForToken('dart', mapping, 'critical')).toBe('P1');
    expect(localPriorityForToken('dart', mapping, 'CrItIcAl')).toBe('P1');
  });

  it('lets an overlay clear a level to null', () => {
    const mapping = resolveEffectivePriorityMapping(
      'plane',
      null,
      JSON.stringify({ toProvider: { P5: null } }),
    );
    expect(providerPriorityToken(mapping, 'P5')).toBeNull();
  });

  it('ignores unknown keys and invalid values entry by entry', () => {
    const mapping = resolveEffectivePriorityMapping(
      'linear',
      null,
      JSON.stringify({
        toProvider: { P0: '4', P9: 'x', P1: 42 },
        toLocal: { '2': 'P5', '3': 'nonsense', '': 'P0' },
      }),
    );
    // Valid entries applied…
    expect(providerPriorityToken(mapping, 'P0')).toBe('4');
    expect(localPriorityForToken('linear', mapping, '2')).toBe('P5');
    // …invalid ones dropped, the seed standing in their place.
    expect(providerPriorityToken(mapping, 'P1')).toBe('2');
    expect(localPriorityForToken('linear', mapping, '3')).toBe('P2');
    expect(Object.keys(mapping.toProvider)).not.toContain('P9');
  });

  it('falls back to the seed on a corrupt or wrongly-shaped blob', () => {
    // A corrupt blob must degrade, never wedge the pass.
    const seeded = seedDefaultPriorityMapping('plane', null);
    for (const blob of ['{not json', '[]', 'null', '"plain string"', '7']) {
      expect(resolveEffectivePriorityMapping('plane', null, blob)).toEqual(seeded);
    }
    // A well-formed object whose halves are the wrong SHAPE is the same case.
    expect(
      resolveEffectivePriorityMapping('plane', null, JSON.stringify({ toProvider: 'nope', toLocal: [] })),
    ).toEqual(seeded);
  });

  it('re-seeds from the live list before overlaying, so a rename still degrades', () => {
    const mapping = resolveEffectivePriorityMapping(
      'dart',
      ['high', 'medium', 'low'],
      JSON.stringify({ toProvider: { P1: 'high' } }),
    );
    // The overlay named P1 only; P0's seed still collapsed to null because the
    // workspace no longer offers 'critical'.
    expect(providerPriorityToken(mapping, 'P1')).toBe('high');
    expect(providerPriorityToken(mapping, 'P0')).toBeNull();
  });

  it('degrades an overlay token the live list no longer offers, and says which', () => {
    // The wizard persists the WHOLE seeded table, so the rename the seed just
    // dropped arrives right back in the overlay. Restoring it verbatim would
    // queue a write Dart 400s on, which the outbox treats as terminal.
    const stale: string[] = [];
    const mapping = resolveEffectivePriorityMapping(
      'dart',
      ['high', 'medium', 'low'],
      JSON.stringify({ toProvider: { P0: 'critical', P1: 'high' } }),
      (token) => stale.push(token),
    );
    expect(providerPriorityToken(mapping, 'P0')).toBeNull();
    expect(stale).toEqual(['critical']);
    // A token the workspace still offers is untouched and reported as nothing.
    expect(providerPriorityToken(mapping, 'P1')).toBe('high');
  });

  it("adopts the live list's own casing for a surviving overlay token", () => {
    const mapping = resolveEffectivePriorityMapping(
      'dart',
      ['Critical', 'High'],
      JSON.stringify({ toProvider: { P0: 'critical' } }),
    );
    expect(providerPriorityToken(mapping, 'P0')).toBe('Critical');
  });

  it('keeps the overlay verbatim when there is no live list to check against', () => {
    // The write-back triggers and the connection summary resolve OFFLINE:
    // having nothing to compare against is not evidence of a rename, and
    // degrading there would report a change on a mapping that is fine.
    const stale: string[] = [];
    const mapping = resolveEffectivePriorityMapping(
      'dart',
      null,
      JSON.stringify({ toProvider: { P0: 'showstopper' } }),
      (token) => stale.push(token),
    );
    expect(providerPriorityToken(mapping, 'P0')).toBe('showstopper');
    expect(stale).toEqual([]);
  });

  it('does not report a level the overlay deliberately points at nothing', () => {
    // "— Not sent" is a user choice, not a rename.
    const stale: string[] = [];
    resolveEffectivePriorityMapping(
      'dart',
      DART_CONFIG_PRIORITIES,
      JSON.stringify({ toProvider: { P0: null } }),
      (token) => stale.push(token),
    );
    expect(stale).toEqual([]);
  });
});

describe('providerTokensEqual', () => {
  it('compares case-insensitively — the Dart config/read casing split', () => {
    expect(providerTokensEqual('Critical', 'critical')).toBe(true);
    expect(providerTokensEqual('HIGH', 'high')).toBe(true);
    expect(providerTokensEqual('high', 'medium')).toBe(false);
  });

  it('treats null as equal only to null', () => {
    expect(providerTokensEqual(null, null)).toBe(true);
    expect(providerTokensEqual(null, '0')).toBe(false);
    expect(providerTokensEqual('0', null)).toBe(false);
    // '0' is Linear's No-priority VALUE, never an absence.
    expect(providerTokensEqual('0', '0')).toBe(true);
  });
});

describe('isPriority', () => {
  it('accepts every level and rejects everything else', () => {
    for (const level of ALL) expect(isPriority(level)).toBe(true);
    for (const value of ['P7', 'p0', '', 'urgent', 0, null, undefined, {}]) {
      expect(isPriority(value)).toBe(false);
    }
  });
});
