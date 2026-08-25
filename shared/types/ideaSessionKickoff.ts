/**
 * buildClarifyKickoffPrompt — the canonical first-turn message for an idea
 * session's clarify flow (idea-session.md), parallel to
 * `DESIGN_KICKOFF_PROMPT` (designKickoff.ts) for design sessions.
 *
 * Sent as a synthetic first user turn when a clarify interview is kicked off
 * for a session's linked idea — it appears as a visible user bubble by design
 * (transparency over magic), the same convention `DESIGN_KICKOFF_PROMPT`
 * follows.
 *
 * It lives in `shared/` because both the main process (any host-side launch
 * seam) and the renderer (the session surface's clarify action) need the
 * SAME bytes for the same `ideaRef` — two hand-kept copies would drift
 * silently, briefing the agent differently depending on which launch door was
 * used. Unlike the design kickoff, this one is parameterized on the idea's
 * display ref (an idea session can, in principle, retarget which idea it
 * clarifies), so it's a function rather than a constant.
 */
export function buildClarifyKickoffPrompt(ideaRef: string): string {
  return (
    `Begin clarifying idea ${ideaRef}. Read it first with cyboflow_get_task, ` +
    'then interview me about the gaps — one focused round at a time. When we ' +
    'have settled the spec, rewrite the idea body via cyboflow_update_task ' +
    'and stamp the idea-spec component complete.'
  );
}
