/**
 * centerPaneStore — EXTERNAL artifact tabs (cross-run, idea-scoped).
 *
 * An external tab's backing row lives in ANOTHER run/session (the idea-session
 * canvas links out to deliverables its launched runs produced). Two invariants
 * make that safe, and both are only visible at the store level:
 *   1. it keys by artifact id for EVERY atype — including the non-per-entity
 *      ones, whose local tabs collapse into one `art:<atype>` viewer slot per
 *      session, so a cross-run row can neither hijack that slot nor be
 *      hijacked by a local row of the same atype;
 *   2. it never participates in the per-entity placeholder adoption, in either
 *      direction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { useCenterPaneStore } from '../centerPaneStore';
import { artifactTabId } from '../../../../shared/types/centerPane';

const KEY = 'sess-1';

describe('centerPaneStore — external artifact tabs', () => {
  beforeEach(() => {
    useCenterPaneStore.setState({ bySession: {} });
    useCenterPaneStore.getState().ensureSession(KEY);
  });

  const tabs = () => useCenterPaneStore.getState().bySession[KEY].tabs;

  it('keys a NON-per-entity external tab by artifact id (not the shared atype slot)', () => {
    useCenterPaneStore.getState().openArtifactTab(KEY, {
      atype: 'decomposed-stories',
      label: 'Stories',
      artifactId: 'art-remote',
      runId: 'run-planner-9',
      external: true,
    });
    const tab = tabs().find((t) => t.kind === 'artifact');
    expect(tab?.id).toBe('art:decomposed-stories:art-remote');
    expect(tab?.runId).toBe('run-planner-9');
    expect(tab?.external).toBe(true);
  });

  it('does not collide with a LOCAL tab of the same non-per-entity atype', () => {
    // The session's own decomposed-stories (the single-viewer slot)…
    useCenterPaneStore.getState().openArtifactTab(KEY, {
      atype: 'decomposed-stories',
      label: 'Local stories',
      artifactId: 'art-local',
    });
    // …and the idea's cross-run one. Two distinct tabs.
    useCenterPaneStore.getState().openArtifactTab(KEY, {
      atype: 'decomposed-stories',
      label: 'Remote stories',
      artifactId: 'art-remote',
      runId: 'run-planner-9',
      external: true,
    });
    const artifactTabs = tabs().filter((t) => t.kind === 'artifact');
    expect(artifactTabs.map((t) => t.id).sort()).toEqual([
      'art:decomposed-stories',
      'art:decomposed-stories:art-remote',
    ]);
    expect(artifactTabs.find((t) => t.id === 'art:decomposed-stories')?.external).toBeUndefined();
  });

  it('never adopts the eager per-entity placeholder (that tab belongs to THIS run)', () => {
    // The Workflow Progress chip's eager, artifact-less open.
    useCenterPaneStore.getState().openArtifactTab(KEY, { atype: 'idea-spec', label: 'Idea spec' });
    expect(tabs().some((t) => t.id === 'art:idea-spec')).toBe(true);

    useCenterPaneStore.getState().openArtifactTab(KEY, {
      atype: 'idea-spec',
      label: 'IDEA-042',
      artifactId: 'art-remote-spec',
      runId: 'run-planner-9',
      external: true,
    });

    const ids = tabs()
      .filter((t) => t.kind === 'artifact')
      .map((t) => t.id)
      .sort();
    // The placeholder survives untouched; the external tab is its own row.
    expect(ids).toEqual(['art:idea-spec', 'art:idea-spec:art-remote-spec']);
  });

  it('an artifact-less per-entity open is never resolved onto an open EXTERNAL tab', () => {
    useCenterPaneStore.getState().openArtifactTab(KEY, {
      atype: 'idea-spec',
      label: 'IDEA-042',
      artifactId: 'art-remote-spec',
      runId: 'run-planner-9',
      external: true,
    });
    // The chip's eager open on THIS run: the sole open idea-spec tab is the
    // external one, which must NOT be adopted as "the" per-entity tab.
    useCenterPaneStore.getState().openArtifactTab(KEY, { atype: 'idea-spec', label: 'Idea spec' });

    const ids = tabs()
      .filter((t) => t.kind === 'artifact')
      .map((t) => t.id)
      .sort();
    expect(ids).toEqual(['art:idea-spec', 'art:idea-spec:art-remote-spec']);
  });

  it('re-opening the same external tab reuses it and refreshes runId/label', () => {
    const open = (label: string) =>
      useCenterPaneStore.getState().openArtifactTab(KEY, {
        atype: 'ui-prototype',
        label,
        artifactId: 'art-proto',
        runId: 'run-design-3',
        committed: true,
        external: true,
      });
    open('Prototype');
    open('Prototype v2');
    const artifactTabs = tabs().filter((t) => t.kind === 'artifact');
    expect(artifactTabs).toHaveLength(1);
    expect(artifactTabs[0].label).toBe('Prototype v2');
    expect(artifactTabs[0].runId).toBe('run-design-3');
    expect(artifactTabs[0].committed).toBe(true);
    expect(useCenterPaneStore.getState().bySession[KEY].activeTabId).toBe(artifactTabs[0].id);
  });

  it('artifactTabId ignores `external` when there is no artifact id to key on', () => {
    expect(artifactTabId('decomposed-stories', undefined, true)).toBe('art:decomposed-stories');
    expect(artifactTabId('decomposed-stories', 'art-1', true)).toBe(
      'art:decomposed-stories:art-1',
    );
    // Unchanged for the pre-existing (non-external) callers.
    expect(artifactTabId('decomposed-stories', 'art-1')).toBe('art:decomposed-stories');
    expect(artifactTabId('idea-spec', 'art-1')).toBe('art:idea-spec:art-1');
  });
});
