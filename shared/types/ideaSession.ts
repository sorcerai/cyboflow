/**
 * Wire types for the `sessions:open-idea-session` IPC door — the backlog idea
 * card's "Open" (idea sessions plan, Stage 1).
 *
 * Declared in `shared/` rather than dual-declared in main/src/types/session.ts +
 * frontend/src/types/session.ts, per docs/CODE-PATTERNS.md → "IPC / type-parity
 * rules": a request field the server reads but the client can never send (or a
 * response field one side forgot) drops silently instead of failing the build.
 * ONE declaration, imported by the core, preload, the renderer API wrapper, and
 * the `window.electronAPI` declaration.
 */

export interface OpenIdeaSessionRequest {
  projectId: number;
  /** Opaque idea id (not the display ref). */
  ideaId: string;
}

export interface OpenIdeaSessionResponse {
  sessionId: string;
  /**
   * The session's `__quick__` chat sentinel run (`sessions.chat_run_id`) — what
   * `setActiveQuickSession` consumes. Null only for a pre-existing home row
   * whose sentinel backfill is somehow absent; callers must tolerate it.
   */
  chatRunId: string | null;
  /** A Claude chat panel already REGISTERED with the Claude runtime (never started). */
  claudePanelId: string;
  /** false = an existing home session was reused rather than minted. */
  created: boolean;
}
