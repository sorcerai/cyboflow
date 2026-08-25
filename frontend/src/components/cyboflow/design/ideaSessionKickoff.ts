/**
 * Re-export of the canonical idea-session clarify kickoff prompt builder.
 *
 * The function itself lives in `shared/types/ideaSessionKickoff.ts` because a
 * main-process launch seam may need the same bytes too (parallel to
 * `designKickoff.ts`'s DESIGN_KICKOFF_PROMPT re-export), and main cannot
 * import from `frontend/src`. Keeping one definition means any additional
 * launch door cannot silently drift into briefing the idea agent differently.
 *
 * This file is the renderer-side import path for the session surface's
 * clarify action.
 */
export { buildClarifyKickoffPrompt } from '../../../../../shared/types/ideaSessionKickoff';
