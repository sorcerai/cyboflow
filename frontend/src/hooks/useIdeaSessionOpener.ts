/**
 * useIdeaSessionOpener — the backlog idea card's "Open" (idea sessions plan,
 * Stage 4): find-or-create the idea's ONE persistent, in-place, SDK-pinned
 * home session and focus it.
 *
 * A thin door-caller, mirroring useTaskRunLauncher's shape (launchingTaskId /
 * error / launch): `openIdeaSession(task)` calls
 * `API.sessions.openIdeaSession({ projectId, ideaId })` — the door that layers
 * on `openIdeaSessionCore` (main/src/services/openIdeaSessionCore.ts) — then,
 * on success, does exactly what DraggableProjectTreeView's `handleSessionClick`
 * does for its quick-session arm: `setActiveQuickSession(sessionId, chatRunId)`,
 * `setActiveProjectId(task.project_id)`, `goToSession()`. `goToSession` itself
 * already flips `backlogOpen`/`humanReviewOpen` to false in the same `set()`
 * call handleSessionClick's separate `closeBacklog`/`closeHumanReview` calls
 * make, so mirroring only the quick-session arm's three calls is sufficient —
 * no need to duplicate those two.
 *
 * `chatRunId` is nullable in the response (a pre-existing home whose sentinel
 * backfill is somehow absent) — `setActiveQuickSession` already accepts
 * `runId?: string`, so `chatRunId ?? undefined` is all the tolerance needed.
 *
 * `openingTaskId` mirrors `useTaskRunLauncher`'s `launchingTaskId`: the id of
 * the idea currently being opened (or null), driving the card's in-flight
 * button guard. Failure surfaces via `error` — the same
 * banner/`role="alert"` pattern BacklogPane already renders for
 * `useTaskRunLauncher`'s `error` — rather than a thrown rejection.
 */
import { useCallback, useState } from 'react';
import { API } from '../utils/api';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { useNavigationStore } from '../stores/navigationStore';
import type { BacklogTaskItem } from '../../../shared/types/tasks';

export interface IdeaSessionOpenerState {
  /** Idea task id currently being opened, or null when idle. */
  openingTaskId: string | null;
  /** Last open error message, or null. */
  error: string | null;
  /** Find-or-create `task`'s idea home session and focus it. */
  openIdeaSession: (task: BacklogTaskItem) => Promise<void>;
}

export function useIdeaSessionOpener(): IdeaSessionOpenerState {
  const [openingTaskId, setOpeningTaskId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openIdeaSession = useCallback(async (task: BacklogTaskItem): Promise<void> => {
    setError(null);
    setOpeningTaskId(task.id);
    try {
      const result = await API.sessions.openIdeaSession({
        projectId: task.project_id,
        ideaId: task.id,
      });
      if (!result.success || !result.data) {
        setError(result.error ?? 'Failed to open the idea session');
        return;
      }
      const { sessionId, chatRunId } = result.data;
      useCyboflowStore.getState().setActiveQuickSession(sessionId, chatRunId ?? undefined);
      useNavigationStore.getState().setActiveProjectId(task.project_id);
      useNavigationStore.getState().goToSession();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to open the idea session');
    } finally {
      setOpeningTaskId(null);
    }
  }, []);

  return { openingTaskId, error, openIdeaSession };
}
