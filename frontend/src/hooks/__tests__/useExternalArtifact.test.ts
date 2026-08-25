/**
 * useExternalArtifact — the cross-run artifact fetch behind an EXTERNAL
 * center-pane tab.
 *
 * The load-bearing details: it sends runId + atype (without them
 * `ArtifactRouter.getById` cannot reach the COMMITTED on-disk snapshot of an
 * artifact whose DB row was deleted on commit — IDEA-039), it subscribes before
 * the seed resolves, and a mid-flight event beats the older seed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { Artifact, ArtifactChangedEvent } from '../../../../shared/types/artifacts';

const getSpy = vi.fn();
const unsubscribeSpy = vi.fn();
let handler: ((e: ArtifactChangedEvent) => void) | null = null;
let subscribeCalls = 0;

vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      artifacts: {
        get: { query: (...a: unknown[]) => getSpy(...a) as Promise<Artifact | null> },
        onArtifactChanged: {
          subscribe: (_i: unknown, h: { onData: (e: ArtifactChangedEvent) => void }) => {
            handler = h.onData;
            subscribeCalls += 1;
            return { unsubscribe: unsubscribeSpy };
          },
        },
      },
    },
  },
}));

import { useExternalArtifact } from '../useExternalArtifact';

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'art-remote',
    runId: 'run-planner-9',
    sessionId: 'other-session',
    atype: 'decomposed-stories',
    label: 'Stories',
    stepOrigin: null,
    mode: 'template',
    committed: true,
    sessionOnly: false,
    isNew: false,
    payloadJson: null,
    sourceRef: null,
    createdAt: '',
    committedAt: null,
    ...overrides,
  };
}

const TARGET = {
  artifactId: 'art-remote',
  runId: 'run-planner-9',
  atype: 'decomposed-stories',
} as const;

describe('useExternalArtifact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handler = null;
    subscribeCalls = 0;
    getSpy.mockResolvedValue(makeArtifact());
  });

  it('fetches by (artifactId, runId, atype) — the committed-snapshot key', async () => {
    const { result } = renderHook(() => useExternalArtifact(7, { ...TARGET }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getSpy).toHaveBeenCalledWith({
      artifactId: 'art-remote',
      runId: 'run-planner-9',
      atype: 'decomposed-stories',
    });
    expect(result.current.artifact?.id).toBe('art-remote');
  });

  it('is inert for a null target (every non-external tab)', () => {
    const { result } = renderHook(() => useExternalArtifact(7, null));
    expect(getSpy).not.toHaveBeenCalled();
    expect(subscribeCalls).toBe(0);
    expect(result.current).toEqual({ artifact: null, loading: false });
  });

  it('does not re-fetch when only the caller OBJECT identity changes', async () => {
    const { result, rerender } = renderHook(
      ({ target }: { target: typeof TARGET }) => useExternalArtifact(7, { ...target }),
      { initialProps: { target: TARGET } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ target: { ...TARGET } });
    expect(getSpy).toHaveBeenCalledTimes(1);
  });

  it('lets a mid-flight commit event win over the older seed', async () => {
    let resolveSeed: ((v: Artifact | null) => void) | null = null;
    getSpy.mockReturnValue(
      new Promise<Artifact | null>((res) => {
        resolveSeed = res;
      }),
    );
    const { result } = renderHook(() => useExternalArtifact(7, { ...TARGET }));
    await waitFor(() => expect(handler).not.toBeNull());

    // A commit lands WHILE the seed query is still in flight.
    await act(async () => {
      handler?.({
        projectId: 7,
        runId: 'run-planner-9',
        sessionId: null,
        artifactId: 'art-remote',
        atype: 'decomposed-stories',
        action: 'committed',
        artifact: makeArtifact({ label: 'Stories (committed)' }),
      });
    });
    // …then the (older) seed resolves with the pre-commit shape.
    await act(async () => {
      resolveSeed?.(makeArtifact({ label: 'Stories' }));
    });

    expect(result.current.artifact?.label).toBe('Stories (committed)');
  });

  it('clears the artifact on a deleted event (the pane renders the absent state)', async () => {
    const { result } = renderHook(() => useExternalArtifact(7, { ...TARGET }));
    await waitFor(() => expect(result.current.artifact).not.toBeNull());
    await act(async () => {
      handler?.({
        projectId: 7,
        runId: 'run-planner-9',
        sessionId: null,
        artifactId: 'art-remote',
        atype: 'decomposed-stories',
        action: 'deleted',
        artifact: null,
      });
    });
    expect(result.current.artifact).toBeNull();
  });

  it('ignores events for a different artifact id', async () => {
    const { result } = renderHook(() => useExternalArtifact(7, { ...TARGET }));
    await waitFor(() => expect(result.current.artifact).not.toBeNull());
    await act(async () => {
      handler?.({
        projectId: 7,
        runId: 'run-planner-9',
        sessionId: null,
        artifactId: 'someone-else',
        atype: 'decomposed-stories',
        action: 'deleted',
        artifact: null,
      });
    });
    expect(result.current.artifact?.id).toBe('art-remote');
  });

  it('unsubscribes on unmount', async () => {
    const { result, unmount } = renderHook(() => useExternalArtifact(7, { ...TARGET }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    unmount();
    expect(unsubscribeSpy).toHaveBeenCalled();
  });
});
