/**
 * useIdeaSessionData — the idea canvas's single live read.
 *
 * Pins the four things the canvas depends on:
 *   1. it seeds from tasks.get + artifacts.listForIdea and takes the ledger off
 *      the idea's own `components` overlay (NO redundant ideaComponents.get);
 *   2. all three subscriptions are opened BEFORE the seed queries resolve
 *      (docs/CODE-PATTERNS.md's seed-query + subscription race policy);
 *   3. each event re-runs the RELEVANT query, and events for other ideas are
 *      ignored;
 *   4. everything unsubscribes on unmount / idea change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { BacklogTaskItem, TaskChangedEvent } from '../../../../shared/types/tasks';
import type {
  IdeaComponentChangedEvent,
  IdeaComponentState,
} from '../../../../shared/types/ideaComponents';
import type { IdeaArtifactLink } from '../../../../shared/types/ideaArtifacts';
import type { ArtifactChangedEvent } from '../../../../shared/types/artifacts';

const taskGetSpy = vi.fn();
const taskListSpy = vi.fn();
const listForIdeaSpy = vi.fn();
const ideaComponentsGetSpy = vi.fn();
const unsubscribeSpies = { task: vi.fn(), components: vi.fn(), artifacts: vi.fn() };

let taskHandler: ((e: TaskChangedEvent) => void) | null = null;
let componentsHandler: ((e: IdeaComponentChangedEvent) => void) | null = null;
let artifactHandler: ((e: ArtifactChangedEvent) => void) | null = null;
/** Query calls observed at the moment each subscribe() ran (race-policy proof). */
let queryCallsAtSubscribe = -1;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        get: { query: (...a: unknown[]) => taskGetSpy(...a) as Promise<BacklogTaskItem | null> },
        list: { query: (...a: unknown[]) => taskListSpy(...a) as Promise<BacklogTaskItem[]> },
        onTaskChanged: {
          subscribe: (_i: unknown, h: { onData: (e: TaskChangedEvent) => void }) => {
            taskHandler = h.onData;
            queryCallsAtSubscribe = taskGetSpy.mock.calls.length;
            return { unsubscribe: unsubscribeSpies.task };
          },
        },
      },
      ideaComponents: {
        get: { query: (...a: unknown[]) => ideaComponentsGetSpy(...a) as Promise<IdeaComponentState[]> },
        onComponentsChanged: {
          subscribe: (_i: unknown, h: { onData: (e: IdeaComponentChangedEvent) => void }) => {
            componentsHandler = h.onData;
            return { unsubscribe: unsubscribeSpies.components };
          },
        },
      },
      artifacts: {
        listForIdea: {
          query: (...a: unknown[]) => listForIdeaSpy(...a) as Promise<IdeaArtifactLink[]>,
        },
        onArtifactChanged: {
          subscribe: (_i: unknown, h: { onData: (e: ArtifactChangedEvent) => void }) => {
            artifactHandler = h.onData;
            return { unsubscribe: unsubscribeSpies.artifacts };
          },
        },
      },
    },
  },
}));

import { useIdeaSessionData } from '../useIdeaSessionData';

function componentState(component: IdeaComponentState['component']): IdeaComponentState {
  return {
    component,
    state: 'incomplete',
    source: 'derived',
    sourceRunId: null,
    sourceSessionId: null,
    builtAgainstVersion: null,
    staleAt: null,
    staleReason: null,
    updatedAt: null,
  };
}

const IDEA = {
  id: 'idea-42',
  ref: 'IDEA-042',
  title: 'Idea',
  components: [componentState('idea-spec')],
} as unknown as BacklogTaskItem;

const LINKS: IdeaArtifactLink[] = [
  { component: 'idea-spec', state: 'incomplete', staleAt: null, artifact: null },
];

describe('useIdeaSessionData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskHandler = null;
    componentsHandler = null;
    artifactHandler = null;
    queryCallsAtSubscribe = -1;
    taskGetSpy.mockResolvedValue(IDEA);
    taskListSpy.mockResolvedValue([]);
    listForIdeaSpy.mockResolvedValue(LINKS);
  });

  it('seeds from tasks.get + artifacts.listForIdea and reads the ledger off the idea overlay', async () => {
    const { result } = renderHook(() => useIdeaSessionData('idea-42', 7));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(taskGetSpy).toHaveBeenCalledWith({ taskId: 'idea-42' });
    expect(listForIdeaSpy).toHaveBeenCalledWith({ projectId: 7, ideaId: 'idea-42' });
    expect(result.current.idea).toEqual(IDEA);
    expect(result.current.artifactLinks).toEqual(LINKS);
    expect(result.current.components).toEqual(IDEA.components);
    // The overlay IS the ledger seed — a separate ideaComponents.get would be a
    // redundant round-trip returning the same merged snapshot.
    expect(ideaComponentsGetSpy).not.toHaveBeenCalled();
  });

  it('subscribes BEFORE awaiting the seed queries (race policy)', async () => {
    renderHook(() => useIdeaSessionData('idea-42', 7));
    await waitFor(() => expect(taskHandler).not.toBeNull());
    // The subscribe ran while zero query results had been consumed — i.e. it was
    // registered ahead of the seed, so a write landing in the query window is
    // not lost when the seed resolves.
    expect(queryCallsAtSubscribe).toBe(0);
    expect(componentsHandler).not.toBeNull();
    expect(artifactHandler).not.toBeNull();
  });

  it('re-fetches the idea when THIS idea changes, and ignores other ideas', async () => {
    const { result } = renderHook(() => useIdeaSessionData('idea-42', 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(taskGetSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      taskHandler?.({ task: { id: 'other-idea' } } as TaskChangedEvent);
    });
    expect(taskGetSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      taskHandler?.({ task: { id: 'idea-42' } } as TaskChangedEvent);
    });
    expect(taskGetSpy).toHaveBeenCalledTimes(2);
    // A task change does not disturb the links.
    expect(listForIdeaSpy).toHaveBeenCalledTimes(1);
  });

  it('re-fetches BOTH halves on a ledger write for this idea (state rides on each link too)', async () => {
    const { result } = renderHook(() => useIdeaSessionData('idea-42', 7));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      componentsHandler?.({ projectId: 7, ideaId: 'other', states: [] });
    });
    expect(taskGetSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      componentsHandler?.({ projectId: 7, ideaId: 'idea-42', states: [] });
    });
    expect(taskGetSpy).toHaveBeenCalledTimes(2);
    expect(listForIdeaSpy).toHaveBeenCalledTimes(2);
  });

  it('re-fetches the links on any artifact change (the backing runs are not enumerable here)', async () => {
    const { result } = renderHook(() => useIdeaSessionData('idea-42', 7));
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      artifactHandler?.({
        projectId: 7,
        runId: 'run-x',
        sessionId: null,
        artifactId: 'art-1',
        atype: 'idea-spec',
        action: 'created',
        artifact: null,
      });
    });
    expect(listForIdeaSpy).toHaveBeenCalledTimes(2);
    expect(taskGetSpy).toHaveBeenCalledTimes(1);
  });

  it('derives readyTaskIds from tasks.list and re-derives on ANY task change', async () => {
    // One ready task directly under the idea; one ready task belonging elsewhere.
    const readyTask = {
      id: 'task-r1',
      type: 'task',
      originating_idea_id: 'idea-42',
      stage_position: 6,
      isDone: false,
      archived_at: null,
      inFlow: [],
      children: [],
    } as unknown as BacklogTaskItem;
    const foreignTask = {
      ...readyTask,
      id: 'task-x',
      originating_idea_id: 'idea-other',
    } as BacklogTaskItem;
    taskListSpy.mockResolvedValue([readyTask, foreignTask]);

    const { result } = renderHook(() => useIdeaSessionData('idea-42', 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(taskListSpy).toHaveBeenCalledWith({ projectId: 7 });
    expect(result.current.readyTaskIds).toEqual(['task-r1']);

    // A CHILD task's stage move carries the child's id — the ready set must
    // still refresh (project-wide refetch, nothing local to filter on).
    taskListSpy.mockResolvedValue([foreignTask]);
    await act(async () => {
      taskHandler?.({ task: { id: 'task-r1' } } as TaskChangedEvent);
    });
    expect(taskListSpy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.readyTaskIds).toEqual([]));
  });

  it('is inert (no queries, no subscriptions) without an idea or a project', () => {
    renderHook(() => useIdeaSessionData(null, 7));
    renderHook(() => useIdeaSessionData('idea-42', null));
    expect(taskGetSpy).not.toHaveBeenCalled();
    expect(listForIdeaSpy).not.toHaveBeenCalled();
    expect(taskHandler).toBeNull();
  });

  it('unsubscribes all three channels on unmount', async () => {
    const { result, unmount } = renderHook(() => useIdeaSessionData('idea-42', 7));
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    expect(unsubscribeSpies.task).toHaveBeenCalled();
    expect(unsubscribeSpies.components).toHaveBeenCalled();
    expect(unsubscribeSpies.artifacts).toHaveBeenCalled();
  });
});
