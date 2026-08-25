/**
 * reopenIdeaResolver — resolves which idea a RUN'S prototype artifact belongs
 * to when the artifact itself carries no `sourceRef` (a planner/sprint
 * -produced `ui-prototype`/`interactive-prototype`, per IDEA-013 "make any
 * prototype reopenable in design mode"). `sourceRef` is stamped ONLY on the
 * design-report path (see `main/src/orchestrator/mcpServer/mcpQueryHandler.ts`
 * `handleReportArtifact`), so a run-scoped prototype the planner's own
 * ui-prototype step reports has neither a sourceRef nor a bound session —
 * this resolver derives the idea from the RUN instead, via ownership.
 *
 * Reuses `listRunOwnedOrBatchIdeaIds` (runEntityOwnership.ts) — the SAME
 * owned-else-batch idea resolution every per-idea mint helper already uses —
 * rather than re-deriving run->idea ownership here.
 *
 * Ambiguity policy: when the run's owned-or-batch idea set resolves to MORE
 * THAN ONE idea (a batch run whose single combined prototype spans several
 * ideas), the link is genuinely ambiguous — guessing would silently offer
 * "reopen in design mode" against the wrong idea. This resolver fails
 * HONESTLY by returning null for that case too (the SAME outward signal as
 * "zero ideas resolve"), so the caller suppresses the CTA rather than
 * guessing or building a disambiguation surface. See
 * `ArtifactTabRenderer.tsx`'s `CanvasBody` for the render-gate consumer.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/* — mirrors runEntityOwnership.ts.
 */
import type { DatabaseLike } from '../types';
import { listRunOwnedOrBatchIdeaIds } from '../runEntityOwnership';

/**
 * The single idea id a run's prototype should reopen into design mode
 * against, or null when zero or more-than-one idea resolves for the run.
 * Fail-soft: `listRunOwnedOrBatchIdeaIds` already degrades to `[]` on any
 * thrown query per its own contract, so this function never throws either.
 *
 * @param db    Narrow DatabaseLike interface.
 * @param runId The workflow_runs.id that produced the prototype artifact.
 */
export function resolveReopenIdeaId(db: DatabaseLike, runId: string): string | null {
  const ideaIds = listRunOwnedOrBatchIdeaIds(db, runId);
  return ideaIds.length === 1 ? ideaIds[0] : null;
}
