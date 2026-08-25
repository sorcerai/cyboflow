/**
 * TypedEventNarrowing — Stage 3 of the streamParser pipeline.
 *
 * Validates each parsed JSON object against the Zod schema and narrows it to
 * the appropriate ClaudeStreamEvent variant. Unknown discriminants fall through
 * to the { kind: '__unknown__', raw } catch-all — never throws, never drops.
 */

import { claudeStreamEventSchemaByType } from './schemas';
import type { ClaudeStreamEvent } from '../../../../shared/types/claudeStream';
import type { ILogger } from './types';
import type { ZodTypeAny } from 'zod';

/**
 * Runtime branch lookup, as a Map rather than a plain-object index.
 *
 * This MUST NOT be an object property lookup. `'constructor' in obj` — and
 * likewise `toString`, `valueOf`, `__proto__`, `hasOwnProperty` — is true for
 * any object literal via Object.prototype, so a wire event of
 * `{ type: 'constructor' }` would pass the guard and then resolve to
 * `Object`, whose `.safeParse` does not exist: a TypeError thrown straight
 * out of `narrow()`, breaking its documented NEVER-throws contract and taking
 * the streaming pipeline with it. A Map has no prototype chain to fall
 * through, so an unknown `type` is simply a miss.
 */
const BRANCH_BY_TYPE: ReadonlyMap<string, ZodTypeAny> = new Map(
  Object.entries(claudeStreamEventSchemaByType),
);

export class TypedEventNarrowing {
  private readonly logger: Pick<ILogger, 'verbose'> | undefined;

  constructor(logger?: Pick<ILogger, 'verbose'>) {
    this.logger = logger;
  }

  /**
   * Narrow a parsed JSON value to a typed ClaudeStreamEvent.
   *
   * Dispatches on the top-level `type` discriminant via
   * `claudeStreamEventSchemaByType` and `safeParse`s that ONE branch. On
   * success, returns the validated, narrowed event. On failure (unknown
   * variant, missing field, bad type), returns `{ kind: '__unknown__', raw }`.
   *
   * Equivalent to parsing the full `claudeStreamEventSchema` union, because
   * every branch pins a distinct `type` literal — but without constructing a
   * ZodError for each non-matching branch, which profiling showed dominated
   * main-process CPU while runs were streaming (see the map's header comment).
   *
   * Contract: NEVER throws. NEVER drops (unknown events become the catch-all
   * variant, not null).
   */
  narrow(parsed: unknown): ClaudeStreamEvent {
    const rawObj =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    const rawType = rawObj['type'];
    const wireType = typeof rawType === 'string' ? rawType : undefined;

    const branch = wireType === undefined ? undefined : BRANCH_BY_TYPE.get(wireType);
    if (branch !== undefined) {
      const result = branch.safeParse(parsed);
      if (result.success) {
        return result.data as ClaudeStreamEvent;
      }
    }

    // Log at debug/verbose level — informative but not noisy.
    this.logger?.verbose?.(
      `[streamParser] unknown ClaudeStreamEvent variant type=${wireType ?? '<missing>'}`,
    );

    return { kind: '__unknown__', raw: rawObj };
  }
}
