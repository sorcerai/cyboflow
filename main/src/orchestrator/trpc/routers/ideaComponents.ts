/**
 * cyboflow.ideaComponents sub-router — the idea component ledger's tRPC
 * surface (migration 101, `shared/types/ideaComponents.ts`,
 * `../../ideaComponents/ideaComponentRouter.ts`).
 *
 *   get                  : query        -> IdeaComponentState[] (merged hybrid view)
 *   getMany              : query        -> IdeaComponentsForIdea[] (the same view, batched)
 *   setState             : mutation     -> IdeaComponentState[] (the card's manual-override path)
 *   onComponentsChanged  : subscription -> IdeaComponentChangedEvent (project-scoped)
 *
 * `setState` is the ONLY write this router exposes (the flow-driven
 * `set-component-state`/`mark-stale`/`clear-stale`/`delete-for-idea` ops are
 * reached by orchestrator/MCP code directly via
 * `IdeaComponentRouter.getInstance()`, never over tRPC). It hard-codes
 * `source: 'manual'` — the whole point of the manual-override decision (see
 * `ideaComponentRouter.ts`'s `IdeaComponentSetState` JSDoc) is that a
 * human-driven override is RECORDED as manual so a later flow run surfaces it
 * rather than silently clobbering it; letting the client pass an arbitrary
 * `source` would defeat that. `projectId` for the write is resolved from the
 * idea's own row (never trusted from the client), mirroring
 * `feedback.ts`'s `resolveProjectId`.
 *
 * Standalone-typecheck invariant: no imports from 'electron',
 * 'better-sqlite3', or main/src/services/*.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import { IDEA_COMPONENT_KEYS } from '../../../../../shared/types/ideaComponents';
import type {
  IdeaComponentChangedEvent,
  IdeaComponentState,
  IdeaComponentsForIdea,
} from '../../../../../shared/types/ideaComponents';
import {
  IdeaComponentRouter,
  IdeaComponentError,
  ideaComponentChangeEvents,
  ideaComponentProjectChannel,
} from '../../ideaComponents/ideaComponentRouter';
import {
  resolveIdeaComponents,
  resolveIdeaComponentsBatch,
} from '../../ideaComponents/resolveIdeaComponents';
import { eventToAsyncIterable } from './events';
import type { IdeaComponentErrorCode } from '../../ideaComponents/ideaComponentRouter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[ideaComponents.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

/** Resolve the idea's project (writes never trust a client-supplied projectId). */
function resolveProjectId(db: DatabaseLike, ideaId: string, where: string): number {
  const idea = db
    .prepare('SELECT project_id AS projectId FROM ideas WHERE id = ?')
    .get(ideaId) as { projectId: number } | undefined;
  if (!idea) {
    throw new TRPCError({ code: 'NOT_FOUND', message: `[ideaComponents.${where}] idea ${ideaId} not found` });
  }
  return idea.projectId;
}

/** Map an IdeaComponentError code to a TRPCError (code carried in the message). */
function rethrowAsTRPCError(err: unknown): never {
  if (err instanceof IdeaComponentError) {
    const codeMap: Record<IdeaComponentErrorCode, TRPCError['code']> = {
      not_found: 'NOT_FOUND',
      invalid_payload: 'BAD_REQUEST',
    };
    throw new TRPCError({ code: codeMap[err.code], message: `${err.code}: ${err.message}`, cause: err });
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const ideaComponentsRouter = router({
  /** The merged hybrid view (ledger rows win, derivation fills the rest) for one idea. */
  get: protectedProcedure
    .input(z.object({ ideaId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<IdeaComponentState[]> => {
      const db = requireDb(ctx.db, 'get');
      return resolveIdeaComponents(db, input.ideaId);
    }),

  /**
   * The same merged hybrid view for SEVERAL ideas in one round trip — the read
   * behind the COMBINED multi-idea idea-summary tab, which renders one row per
   * idea the run owns and would otherwise fan out N `get` calls over IPC on
   * every live refresh (and it re-fetches on ANY project task change, because a
   * run's idea set is not cheaply knowable renderer-side).
   *
   * Backed by `resolveIdeaComponentsBatch` — a bounded number of GROUPED queries
   * rather than a resolve per idea (the same read the backlog list render uses).
   *
   * Returns one entry per REQUESTED id, in the requested order, so the caller can
   * zip it against its own idea list without a lookup miss: an unknown id yields
   * the same all-derived five-component snapshot `get` would return for it (the
   * resolver is total over the five keys and deliberately does not omit unknown
   * ids), never a dropped row. Duplicate ids are resolved once and echoed for
   * each occurrence.
   */
  getMany: protectedProcedure
    .input(z.object({ ideaIds: z.array(z.string().min(1)).max(200) }))
    .query(async ({ input, ctx }): Promise<IdeaComponentsForIdea[]> => {
      const db = requireDb(ctx.db, 'getMany');
      const resolved = resolveIdeaComponentsBatch(db, input.ideaIds);
      return input.ideaIds.map((ideaId) => ({ ideaId, states: resolved.get(ideaId) ?? [] }));
    }),

  /**
   * The card's manual-override path. Always records `source: 'manual'` —
   * never accepted from client input (see file header). Returns the
   * refreshed merged hybrid snapshot for the idea.
   */
  setState: protectedProcedure
    .input(
      z.object({
        ideaId: z.string().min(1),
        component: z.enum(IDEA_COMPONENT_KEYS),
        state: z.enum(['complete', 'incomplete', 'skipped']),
      }),
    )
    .mutation(async ({ input, ctx }): Promise<IdeaComponentState[]> => {
      const db = requireDb(ctx.db, 'setState');
      const projectId = resolveProjectId(db, input.ideaId, 'setState');
      try {
        const result = await IdeaComponentRouter.getInstance().applyChange(projectId, {
          op: 'set-component-state',
          ideaId: input.ideaId,
          component: input.component,
          state: input.state,
          source: 'manual',
        });
        return result.states;
      } catch (err) {
        rethrowAsTRPCError(err);
      }
    }),

  /** Project-scoped idea-component change stream (ledger write lifecycle). */
  onComponentsChanged: protectedProcedure
    .input(z.object({ projectId: z.number().int().positive() }))
    .subscription(async function* ({ input, signal }): AsyncGenerator<IdeaComponentChangedEvent> {
      const abortSignal = signal ?? new AbortController().signal;
      const source = eventToAsyncIterable<IdeaComponentChangedEvent>(
        ideaComponentChangeEvents,
        ideaComponentProjectChannel(input.projectId),
        abortSignal,
      );
      for await (const ev of source) {
        yield ev;
      }
    }),
});
