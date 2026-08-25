/**
 * useIdeaSessionData — the ONE live read behind the idea-session canvas.
 *
 * The canvas needs three things about its linked idea and they all move
 * independently: the idea entity (title / ref / tags), its component ledger,
 * and the per-component artifact links (`cyboflow.artifacts.listForIdea`). This
 * is deliberately a SINGLE hook rather than three: they share a subscription
 * set, and three hooks would open three copies of the same project-scoped
 * channels and re-render the canvas three times per write.
 *
 * ## Seeding
 * Two queries: `tasks.get` for the idea and `artifacts.listForIdea` for the
 * links. The ledger comes from the idea's own `components` overlay
 * (`BacklogTaskItem.components`, populated for type='idea' by
 * `selectTaskById`) — deliberately NOT a separate initial
 * `ideaComponents.get`, which would be a redundant round-trip returning the
 * same merged hybrid snapshot. That also makes the idea query the SINGLE source
 * of ledger truth here, so the two halves can never disagree.
 *
 * ## Reactivity (docs/CODE-PATTERNS.md — seed-query + subscription race policy)
 * All three subscriptions are opened BEFORE the seed queries are awaited, so a
 * write landing inside the query window is not lost when the seed resolves. A
 * monotonic fetch id makes a slow earlier refetch unable to clobber a newer one.
 *   - `tasks.onTaskChanged`          → this idea changed ⇒ refetch the idea
 *   - `ideaComponents.onComponentsChanged` → this idea's ledger changed ⇒
 *     refetch BOTH (the ledger rides on the idea, and every link carries its
 *     component's state/staleAt)
 *   - `artifacts.onArtifactChanged`  → refetch the links. NOT filtered by run:
 *     the idea's components point at runs this hook does not enumerate, so
 *     there is nothing local to match on. `listForIdea` is a handful of
 *     indexed reads, so a project-wide refetch is the cheap, correct answer.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import type { BacklogTaskItem } from '../../../shared/types/tasks';
import type { IdeaComponentState } from '../../../shared/types/ideaComponents';
import type { IdeaArtifactLink } from '../../../shared/types/ideaArtifacts';
import { ideaReadyTaskIds } from '../components/Backlog/backlogSelectors';

export interface UseIdeaSessionDataResult {
  idea: BacklogTaskItem | null;
  /** The merged hybrid ledger, from the idea's own `components` overlay. */
  components: IdeaComponentState[];
  artifactLinks: IdeaArtifactLink[];
  /**
   * The idea's decomposed tasks currently ready to seed a sprint batch —
   * drives the "Launch sprint" tile's gate and its picker pre-selection.
   */
  readyTaskIds: string[];
  /** True until the initial seed for the current idea resolves (or fails). */
  loading: boolean;
}

const NO_COMPONENTS: IdeaComponentState[] = [];
const NO_LINKS: IdeaArtifactLink[] = [];
const NO_TASK_IDS: string[] = [];

export function useIdeaSessionData(
  ideaId: string | null,
  projectId: number | null,
): UseIdeaSessionDataResult {
  const [idea, setIdea] = useState<BacklogTaskItem | null>(null);
  const [artifactLinks, setArtifactLinks] = useState<IdeaArtifactLink[]>(NO_LINKS);
  const [readyTaskIds, setReadyTaskIds] = useState<string[]>(NO_TASK_IDS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (ideaId === null || projectId === null) {
      setIdea(null);
      setArtifactLinks(NO_LINKS);
      setReadyTaskIds(NO_TASK_IDS);
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Monotonic per-query fetch ids — a slow earlier refetch must never commit
    // over a newer one (the useArtifactData convention).
    let latestIdeaFetch = 0;
    let latestLinksFetch = 0;
    let latestReadyFetch = 0;

    setIdea(null);
    setArtifactLinks(NO_LINKS);
    setReadyTaskIds(NO_TASK_IDS);
    setLoading(true);

    const fetchIdea = (): Promise<void> => {
      const fetchId = ++latestIdeaFetch;
      return trpc.cyboflow.tasks.get.query({ taskId: ideaId }).then(
        (row) => {
          if (cancelled || fetchId !== latestIdeaFetch) return;
          setIdea(row);
        },
        (err: unknown) => {
          if (cancelled || fetchId !== latestIdeaFetch) return;
          console.warn('[useIdeaSessionData] tasks.get failed:', err);
        },
      );
    };

    const fetchLinks = (): Promise<void> => {
      const fetchId = ++latestLinksFetch;
      return trpc.cyboflow.artifacts.listForIdea.query({ projectId, ideaId }).then(
        (rows) => {
          if (cancelled || fetchId !== latestLinksFetch) return;
          setArtifactLinks(rows);
        },
        (err: unknown) => {
          if (cancelled || fetchId !== latestLinksFetch) return;
          console.warn('[useIdeaSessionData] artifacts.listForIdea failed:', err);
        },
      );
    };

    const fetchReadyTasks = (): Promise<void> => {
      const fetchId = ++latestReadyFetch;
      return trpc.cyboflow.tasks.list.query({ projectId }).then(
        (rows) => {
          if (cancelled || fetchId !== latestReadyFetch) return;
          setReadyTaskIds(ideaReadyTaskIds(rows, ideaId));
        },
        (err: unknown) => {
          if (cancelled || fetchId !== latestReadyFetch) return;
          console.warn('[useIdeaSessionData] tasks.list failed:', err);
        },
      );
    };

    // ── Subscriptions FIRST, seed queries after (race policy) ────────────────
    const taskSub = trpc.cyboflow.tasks.onTaskChanged.subscribe(
      { projectId },
      {
        onData: (event) => {
          if (event.task.id === ideaId) void fetchIdea();
          // The ready-batch set moves when ANY task changes (a child task's
          // stage move carries the child's id, not the idea's) — there is
          // nothing local to filter on, so refetch project-wide, exactly like
          // the artifact subscription below.
          void fetchReadyTasks();
        },
        onError: (err: unknown) => console.warn('[useIdeaSessionData] onTaskChanged error:', err),
      },
    );
    const componentsSub = trpc.cyboflow.ideaComponents.onComponentsChanged.subscribe(
      { projectId },
      {
        onData: (event) => {
          if (event.ideaId !== ideaId) return;
          // The ledger rides on the idea overlay, and every link carries its
          // component's state/staleAt — a ledger write moves both halves.
          void fetchIdea();
          void fetchLinks();
        },
        onError: (err: unknown) =>
          console.warn('[useIdeaSessionData] onComponentsChanged error:', err),
      },
    );
    const artifactSub = trpc.cyboflow.artifacts.onArtifactChanged.subscribe(
      { projectId },
      {
        onData: () => {
          void fetchLinks();
        },
        onError: (err: unknown) =>
          console.warn('[useIdeaSessionData] onArtifactChanged error:', err),
      },
    );

    void Promise.all([fetchIdea(), fetchLinks(), fetchReadyTasks()]).then(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
      taskSub.unsubscribe();
      componentsSub.unsubscribe();
      artifactSub.unsubscribe();
    };
  }, [ideaId, projectId]);

  return {
    idea,
    // `components` is optional on BacklogTaskItem for cross-process shape
    // parity; undefined means "not computed", which for this surface reads the
    // same as an empty ledger (the canvas renders the five rows from the
    // canonical key list either way).
    components: idea?.components ?? NO_COMPONENTS,
    artifactLinks,
    readyTaskIds,
    loading,
  };
}
