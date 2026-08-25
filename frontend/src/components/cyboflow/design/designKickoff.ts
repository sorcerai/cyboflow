/**
 * Re-export of the canonical design-session kickoff prompt.
 *
 * The constant itself lives in `shared/types/designKickoff.ts` because the
 * MAIN process sends it too (the planner's approve-idea design fork launches
 * a design session via `orchestrator/designSessionLaunch`), and main cannot
 * import from `frontend/src`. Keeping one definition means the two launch
 * doors cannot silently drift into briefing the design agent differently.
 *
 * This file remains as the renderer-side import path every existing call site
 * already uses.
 */
export { DESIGN_KICKOFF_PROMPT } from '../../../../../shared/types/designKickoff';

/**
 * DESIGN_PROMOTE_PROMPT — the tier-promotion message for "Make it interactive"
 * (design-mode.md "In-session tier promotion").
 *
 * Sent as a real, visible user turn through the same `dispatchQuickSessionInput`
 * seam DESIGN_KICKOFF_PROMPT uses for the auto-start turn — the surface's
 * promote button dispatches it as a `continue` turn on the session's existing
 * Claude panel rather than inventing a synthetic/hidden path.
 */
export const DESIGN_PROMOTE_PROMPT =
  'Promote the prototype to the interactive tier: rebuild the CURRENT design as an interactive-prototype (inline JS allowed, still fully self-contained) and report it with that atype. Same layout, same content, every data-design-id carried over unchanged — this is a tier change, not a redesign. Iterate the interactive artifact from now on.';
