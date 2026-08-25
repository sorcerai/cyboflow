/**
 * Unit tests for main/src/services/trackerSync/categoryMapping.ts — the
 * feature/bug/chore <-> provider-type translation layer.
 *
 * Covers:
 *   - provider support: Dart only, and an unsupported provider producing an
 *     EMPTY mapping whatever it is handed;
 *   - the name-match seed against a live /config.types list, case-insensitive
 *     both ways, keeping the workspace's own spelling;
 *   - the "never invent a type" rule: an unmatched category maps to nothing,
 *     including on the real probe workspace (Task/Subtask/Project/Milestone),
 *     and with no live list at all;
 *   - a workspace type nobody named getting no inbound entry;
 *   - the persisted overlay: both halves, invalid entries dropped, corrupt JSON
 *     falling back to the seed, and an overlay unable to re-enable an
 *     unsupported provider;
 *   - a null token never resolving to a category (categories have no "unset").
 */
import { describe, it, expect } from 'vitest';
import type { EntityCategory } from '../../../../../shared/types/tasks';
import {
  isCategory,
  localCategoryForToken,
  providerCategoryToken,
  providerSupportsCategorySync,
  resolveEffectiveCategoryMapping,
  seedDefaultCategoryMapping,
} from '../categoryMapping';

/** The Dart probe workspace's real /config.types — NONE of which is a category. */
const PROBE_TYPES = ['Task', 'Subtask', 'Project', 'Milestone'];
/** A workspace that actually models the three categories. */
const CATEGORY_TYPES = ['Feature', 'Bug', 'Chore', 'Task'];

const ALL: EntityCategory[] = ['feature', 'bug', 'chore'];

function outbound(mapping: {
  toProvider: Record<EntityCategory, string | null>;
}): Record<string, string | null> {
  return Object.fromEntries(ALL.map((c) => [c, mapping.toProvider[c]]));
}

describe('providerSupportsCategorySync', () => {
  it('is Dart-only', () => {
    expect(providerSupportsCategorySync('dart')).toBe(true);
    expect(providerSupportsCategorySync('linear')).toBe(false);
    expect(providerSupportsCategorySync('plane')).toBe(false);
  });
});

describe('seedDefaultCategoryMapping — unsupported providers', () => {
  it('produces an empty mapping for Linear and Plane', () => {
    for (const provider of ['linear', 'plane'] as const) {
      const mapping = seedDefaultCategoryMapping(provider, null);
      expect(outbound(mapping)).toEqual({ feature: null, bug: null, chore: null });
      expect(mapping.toLocal).toEqual({});
    }
  });

  it('stays empty even when handed a list, since there is no field to name', () => {
    const mapping = seedDefaultCategoryMapping('linear', CATEGORY_TYPES);
    expect(outbound(mapping)).toEqual({ feature: null, bug: null, chore: null });
    expect(localCategoryForToken(mapping, 'Bug')).toBeNull();
  });
});

describe('seedDefaultCategoryMapping — Dart', () => {
  it('matches the three categories against the live types, keeping their casing', () => {
    const mapping = seedDefaultCategoryMapping('dart', CATEGORY_TYPES);
    expect(outbound(mapping)).toEqual({ feature: 'Feature', bug: 'Bug', chore: 'Chore' });
    expect(localCategoryForToken(mapping, 'Bug')).toBe('bug');
    // Reads come back Title-cased and /config lists lowercase; both resolve.
    expect(localCategoryForToken(mapping, 'bug')).toBe('bug');
    expect(localCategoryForToken(mapping, 'BUG')).toBe('bug');
  });

  it('maps NOTHING on a workspace whose types are not categories', () => {
    // The real probe workspace. Inventing a type here would 400 (probe D3), so
    // the seed simply has nothing to say about category on this workspace.
    const mapping = seedDefaultCategoryMapping('dart', PROBE_TYPES);
    expect(outbound(mapping)).toEqual({ feature: null, bug: null, chore: null });
    expect(mapping.toLocal).toEqual({});
    expect(localCategoryForToken(mapping, 'Task')).toBeNull();
  });

  it('maps NOTHING with no live list — unlike priority, there is no canonical fallback', () => {
    // Dart types are entirely workspace-defined, so "no list" cannot mean
    // "assume the standard names".
    const mapping = seedDefaultCategoryMapping('dart', null);
    expect(outbound(mapping)).toEqual({ feature: null, bug: null, chore: null });
  });

  it('maps only the categories the workspace happens to offer', () => {
    const mapping = seedDefaultCategoryMapping('dart', ['Bug', 'Task']);
    expect(outbound(mapping)).toEqual({ feature: null, bug: 'Bug', chore: null });
    expect(localCategoryForToken(mapping, 'Task')).toBeNull();
  });
});

describe('resolveEffectiveCategoryMapping — overlay', () => {
  it('returns the seed when there is no overlay', () => {
    const seeded = seedDefaultCategoryMapping('dart', CATEGORY_TYPES);
    expect(resolveEffectiveCategoryMapping('dart', CATEGORY_TYPES, null)).toEqual(seeded);
    expect(resolveEffectiveCategoryMapping('dart', CATEGORY_TYPES, '')).toEqual(seeded);
  });

  it('lets a user point a category at a type the name match missed', () => {
    // The whole reason the overlay exists: 'Defect' is this workspace's bug.
    const mapping = resolveEffectiveCategoryMapping(
      'dart',
      ['Defect', 'Task'],
      JSON.stringify({ toProvider: { bug: 'Defect' }, toLocal: { Defect: 'bug' } }),
    );
    expect(providerCategoryToken(mapping, 'bug')).toBe('Defect');
    expect(localCategoryForToken(mapping, 'defect')).toBe('bug');
    expect(providerCategoryToken(mapping, 'feature')).toBeNull();
  });

  it('ignores unknown keys and invalid values entry by entry', () => {
    const mapping = resolveEffectiveCategoryMapping(
      'dart',
      CATEGORY_TYPES,
      JSON.stringify({
        toProvider: { bug: 'Task', epic: 'Project', chore: 7 },
        toLocal: { Task: 'bug', Project: 'epic', '': 'chore' },
      }),
    );
    expect(providerCategoryToken(mapping, 'bug')).toBe('Task');
    expect(localCategoryForToken(mapping, 'task')).toBe('bug');
    // Invalid entries dropped; the seed stands.
    expect(providerCategoryToken(mapping, 'chore')).toBe('Chore');
    expect(localCategoryForToken(mapping, 'project')).toBeNull();
  });

  it('falls back to the seed on a corrupt or wrongly-shaped blob', () => {
    const seeded = seedDefaultCategoryMapping('dart', CATEGORY_TYPES);
    for (const blob of ['{not json', '[]', 'null', '"plain string"', '7']) {
      expect(resolveEffectiveCategoryMapping('dart', CATEGORY_TYPES, blob)).toEqual(seeded);
    }
    expect(
      resolveEffectiveCategoryMapping(
        'dart',
        CATEGORY_TYPES,
        JSON.stringify({ toProvider: 'nope', toLocal: 3 }),
      ),
    ).toEqual(seeded);
  });

  it('cannot re-enable an unsupported provider', () => {
    // A mapping the adapter could neither read nor write is worse than none.
    const mapping = resolveEffectiveCategoryMapping(
      'plane',
      null,
      JSON.stringify({ toProvider: { bug: 'Bug' }, toLocal: { Bug: 'bug' } }),
    );
    expect(providerCategoryToken(mapping, 'bug')).toBeNull();
    expect(localCategoryForToken(mapping, 'Bug')).toBeNull();
  });

  it('degrades an overlay type the workspace no longer offers, and says which', () => {
    // TITLE-IS-THE-ID: the wizard persisted 'Defect', the owner renamed it, and
    // restoring it verbatim over the seed would queue a write Dart 400s on.
    const stale: string[] = [];
    const mapping = resolveEffectiveCategoryMapping(
      'dart',
      ['Bug', 'Task'],
      JSON.stringify({ toProvider: { bug: 'Defect', chore: 'Task' } }),
      (token) => stale.push(token),
    );
    expect(providerCategoryToken(mapping, 'bug')).toBeNull();
    expect(stale).toEqual(['Defect']);
    expect(providerCategoryToken(mapping, 'chore')).toBe('Task');
  });

  it("adopts the live list's own casing for a surviving overlay type", () => {
    const mapping = resolveEffectiveCategoryMapping(
      'dart',
      ['Defect'],
      JSON.stringify({ toProvider: { bug: 'defect' } }),
    );
    expect(providerCategoryToken(mapping, 'bug')).toBe('Defect');
  });

  it('keeps the overlay verbatim when there is no live list to check against', () => {
    const stale: string[] = [];
    const mapping = resolveEffectiveCategoryMapping(
      'dart',
      null,
      JSON.stringify({ toProvider: { bug: 'Defect' } }),
      (token) => stale.push(token),
    );
    expect(providerCategoryToken(mapping, 'bug')).toBe('Defect');
    expect(stale).toEqual([]);
  });

  it('does not report a category the overlay deliberately points at nothing', () => {
    const stale: string[] = [];
    resolveEffectiveCategoryMapping(
      'dart',
      CATEGORY_TYPES,
      JSON.stringify({ toProvider: { chore: null } }),
      (token) => stale.push(token),
    );
    expect(stale).toEqual([]);
  });
});

describe('localCategoryForToken', () => {
  it('never resolves a null token — a category has no "unset" level', () => {
    // Contrast priorityMapping, where a null token IS P6 on Dart.
    const mapping = seedDefaultCategoryMapping('dart', CATEGORY_TYPES);
    expect(localCategoryForToken(mapping, null)).toBeNull();
  });
});

describe('isCategory', () => {
  it('accepts the three categories and rejects everything else', () => {
    for (const category of ALL) expect(isCategory(category)).toBe(true);
    for (const value of ['Bug', 'epic', '', 'P0', 0, null, undefined, {}]) {
      expect(isCategory(value)).toBe(false);
    }
  });
});
