/**
 * cyboflow.design sub-router — the design-session Approve action + the Approve
 * button's freshness read (design-mode.md "Approve — intent-first recoverable
 * state machine" + "Design-spec draft") + the reopen-in-design-mode idea
 * resolver (IDEA-013 "make any prototype reopenable").
 *
 *   approve          : mutation -> DesignApproveResult (drives the Approve state machine)
 *   draftStatus      : query    -> DesignDraftStatus | null (draft vs prototype freshness)
 *   resolveReopenIdea: query    -> { ideaId: string } | null (see reopenIdeaResolver.ts)
 *
 * `approve` forwards to the boot-configured DesignHandoffService singleton (which
 * holds the electron-backed prototype reader + snapshot dir); business failures
 * come back as `{ ok: false, code }` on the discriminated result (NOT thrown), so
 * the renderer can branch on the exact reason. `draftStatus` reads the session's
 * latest draft, the current prototype artifact on its chat run, and the linked
 * idea's version/title in one call — everything the Approve button + freshness
 * indicator need. `resolveReopenIdea` is the renderer's ONLY way to resolve which
 * idea a sourceRef-less prototype belongs to (the renderer has no DB access) —
 * see reopenIdeaResolver.ts for the ownership + ambiguity policy.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3', or
 * main/src/services/* (DesignHandoffService is orchestrator-local + standalone).
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import type { DatabaseLike } from '../../types';
import {
  DesignHandoffService,
  type DesignApproveResult,
} from '../../design/designHandoffService';
import { resolveReopenIdeaId } from '../../design/reopenIdeaResolver';

function requireDb(db: DatabaseLike | undefined, where: string): DatabaseLike {
  if (!db) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `[design.${where}] db not wired into tRPC context`,
    });
  }
  return db;
}

/**
 * Everything the Approve button + freshness indicator need in one call. Null is
 * returned (from the procedure) when the session has no draft yet.
 */
export interface DesignDraftStatus {
  /** The latest design-spec draft revision for the session. */
  latestDraftRevision: number;
  /** The prototype revision that draft is bound to (null before any prototype). */
  boundArtifactRevision: number | null;
  /** The current prototype artifact revision on the session's chat run (null when none). */
  currentPrototypeRevision: number | null;
  /** The current prototype artifact id (null when the session has no prototype yet). */
  prototypeArtifactId: string | null;
  /** The linked idea's current version (Approve's expectedIdeaVersion), null when link broken. */
  ideaVersion: number | null;
  /** The linked idea's title, null when the link is broken. */
  ideaTitle: string | null;
  /** The linked idea's id, null when the link is broken (post-approve planner seed). */
  ideaId: string | null;
  /** True when the idea is missing / decomposed / cross-project (fail-soft relink state). */
  linkBroken: boolean;
}

interface SessionStatusRow {
  design_idea_id: string | null;
  project_id: number | null;
  chat_run_id: string | null;
}

interface DraftStatusRow {
  draft_revision: number;
  bound_artifact_revision: number | null;
}

interface PrototypeStatusRow {
  id: string;
  revision: number;
}

interface IdeaStatusRow {
  version: number;
  title: string;
  decomposed_at: string | null;
  project_id: number;
}

export const designRouter = router({
  /**
   * Approve a design session's named draft revision — the host-owned, recoverable
   * Approve state machine. Returns the discriminated result; a business failure is
   * an `{ ok: false, code }` value, not a thrown error.
   */
  approve: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().min(1),
        draftRevision: z.number().int().positive(),
        expectedIdeaVersion: z.number().int().nonnegative(),
      }),
    )
    .mutation(async ({ input }): Promise<DesignApproveResult> => {
      return DesignHandoffService.getInstance().approve({
        sessionId: input.sessionId,
        draftRevision: input.draftRevision,
        expectedIdeaVersion: input.expectedIdeaVersion,
      });
    }),

  /**
   * Draft-vs-prototype freshness for the Approve button. Null when the session has
   * no draft yet. Resolves the current prototype via the session's chat_run_id +
   * the prototype family ('ui-prototype' | 'interactive-prototype'), preferring
   * a payload-bearing row over the bytes-less re-entry stub — the SAME selection
   * rule the draft-binding write uses (mcpQueryHandler.handleDesignUpdateDraft),
   * so freshness and binding can never disagree about WHICH prototype is current.
   * `linkBroken` mirrors the idea-link integrity contract.
   */
  draftStatus: protectedProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<DesignDraftStatus | null> => {
      const db = requireDb(ctx.db, 'draftStatus');

      const session = db
        .prepare('SELECT design_idea_id, project_id, chat_run_id FROM sessions WHERE id = ?')
        .get(input.sessionId) as SessionStatusRow | undefined;
      if (!session) return null;

      const draft = db
        .prepare(
          `SELECT draft_revision, bound_artifact_revision FROM design_spec_drafts
            WHERE session_id = ? ORDER BY draft_revision DESC LIMIT 1`,
        )
        .get(input.sessionId) as DraftStatusRow | undefined;
      if (!draft) return null;

      // The current prototype on the session's chat run — THE prototype-family
      // selection rule (payload-bearing, then interactive tier, then revision;
      // rationale at the draft-binding site in mcpQueryHandler); mirrored in
      // pickPrototype (DesignModeSurface). Change all three together.
      let prototype: PrototypeStatusRow | undefined;
      if (session.chat_run_id) {
        prototype = db
          .prepare(
            `SELECT id, revision FROM artifacts
              WHERE run_id = ? AND atype IN ('ui-prototype', 'interactive-prototype')
              ORDER BY (payload_json IS NOT NULL) DESC, (atype = 'interactive-prototype') DESC,
                       revision DESC, created_at DESC LIMIT 1`,
          )
          .get(session.chat_run_id) as PrototypeStatusRow | undefined;
      }

      let ideaVersion: number | null = null;
      let ideaTitle: string | null = null;
      let ideaId: string | null = null;
      let linkBroken = true;
      if (session.design_idea_id) {
        const idea = db
          .prepare('SELECT version, title, decomposed_at, project_id FROM ideas WHERE id = ?')
          .get(session.design_idea_id) as IdeaStatusRow | undefined;
        if (
          idea &&
          idea.decomposed_at === null &&
          (session.project_id == null || idea.project_id === session.project_id)
        ) {
          ideaVersion = idea.version;
          ideaTitle = idea.title;
          ideaId = session.design_idea_id;
          linkBroken = false;
        }
      }

      return {
        latestDraftRevision: draft.draft_revision,
        boundArtifactRevision: draft.bound_artifact_revision ?? null,
        currentPrototypeRevision: prototype?.revision ?? null,
        prototypeArtifactId: prototype?.id ?? null,
        ideaVersion,
        ideaTitle,
        ideaId,
        linkBroken,
      };
    }),

  /**
   * Resolves which idea a sourceRef-less prototype artifact belongs to, from
   * the run that produced it (ArtifactTabRenderer's "reopen in design mode"
   * CTA on a planner/sprint-produced ui-prototype/interactive-prototype —
   * IDEA-013). Returns null when zero or more-than-one idea resolves for the
   * run — see reopenIdeaResolver.ts for the ownership + ambiguity policy.
   */
  resolveReopenIdea: protectedProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ input, ctx }): Promise<{ ideaId: string } | null> => {
      const db = requireDb(ctx.db, 'resolveReopenIdea');
      const ideaId = resolveReopenIdeaId(db, input.runId);
      return ideaId !== null ? { ideaId } : null;
    }),
});
