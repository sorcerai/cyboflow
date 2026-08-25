/**
 * useExternalArtifact — resolve ONE artifact that lives OUTSIDE the pane's
 * session (a `TabItem.external` center-pane tab).
 *
 * The center pane normally resolves an artifact tab's backing row from the
 * session-scoped list (`useSessionArtifactsList`). The idea-session canvas
 * links out to deliverables minted by the idea's LAUNCHED runs — different
 * runs, different sessions — which that list can never contain, so such a tab
 * would render "Loading…" forever (and, without the prune exemption in
 * `useArtifactTabsSync`, be closed outright).
 *
 * This hook is the other half: a single `trpc.cyboflow.artifacts.get` keyed by
 * `(artifactId, runId, atype)`. Passing runId + atype is what makes the
 * COMMITTED-snapshot fallback reachable — committing an artifact deletes its DB
 * row and the on-disk snapshot becomes the record, and `ArtifactRouter.getById`
 * can only find that snapshot by `(runId, atype)` (IDEA-039). An id-only call
 * would resolve a live row and nothing else.
 *
 * Reactivity follows docs/CODE-PATTERNS.md's seed-query + subscription race
 * policy: the project-scoped `onArtifactChanged` subscription is opened BEFORE
 * the seed query is awaited, so a commit/update landing during the query window
 * is not overwritten when the seed resolves. Events are filtered to this
 * artifact id; a `deleted` event (the merge/create-PR reap of an uncommitted
 * row) clears it, which the pane renders as the absent state.
 */
import { useEffect, useState } from 'react';
import { trpc } from '../trpc/client';
import type { Artifact, ArtifactType } from '../../../shared/types/artifacts';

/** The identity of an artifact belonging to another run. */
export interface ExternalArtifactTarget {
  artifactId: string;
  /** The artifact's OWN run — required for the committed-snapshot fallback. */
  runId: string;
  /** Also required for that fallback (snapshots are keyed by `(runId, atype)`). */
  atype?: ArtifactType;
}

export interface UseExternalArtifactResult {
  artifact: Artifact | null;
  /** True until the seed query for the current target resolves (or fails). */
  loading: boolean;
}

export function useExternalArtifact(
  projectId: number | null,
  target: ExternalArtifactTarget | null,
): UseExternalArtifactResult {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [loading, setLoading] = useState(false);

  // Destructured to primitives so the effect keys on the IDENTITY of the target
  // rather than the caller's (per-render) object reference.
  const artifactId = target?.artifactId ?? null;
  const runId = target?.runId ?? null;
  const atype = target?.atype;

  useEffect(() => {
    if (artifactId === null || runId === null) {
      setArtifact(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    // Ids the subscription touched WHILE the seed was in flight — the seed
    // snapshot is OLDER than those events, so it must not resurrect a delete or
    // downgrade an update (same policy as useArtifactsList's mergeSeed).
    let seeded = false;
    let subTouched = false;
    let subDeleted = false;
    setArtifact(null);
    setLoading(true);

    // Subscribe FIRST (seed-query + subscription race policy) — only when the
    // project is known; without it the channel cannot be scoped and the tab is
    // a one-shot fetch.
    const sub =
      projectId === null
        ? null
        : trpc.cyboflow.artifacts.onArtifactChanged.subscribe(
            { projectId },
            {
              onData: (event) => {
                if (event.artifactId !== artifactId) return;
                if (event.action === 'deleted') {
                  if (!seeded) {
                    subDeleted = true;
                    subTouched = false;
                  }
                  setArtifact(null);
                  return;
                }
                if (event.artifact !== null) {
                  if (!seeded) {
                    subTouched = true;
                    subDeleted = false;
                  }
                  setArtifact(event.artifact);
                }
              },
              onError: (err: unknown) =>
                console.warn('[useExternalArtifact] onArtifactChanged error:', err),
            },
          );

    void trpc.cyboflow.artifacts.get
      .query({ artifactId, runId, ...(atype !== undefined ? { atype } : {}) })
      .then((row) => {
        if (cancelled) return;
        seeded = true;
        setLoading(false);
        // Newer subscription state wins over the older seed.
        if (subDeleted || subTouched) return;
        setArtifact(row);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.warn('[useExternalArtifact] artifacts.get failed:', err);
        seeded = true;
        setLoading(false);
      });

    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, [projectId, artifactId, runId, atype]);

  return { artifact, loading };
}
