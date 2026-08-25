/**
 * useArtifactTabsSync — the EXTERNAL-tab prune exemption.
 *
 * An external tab (a cross-run, idea-scoped artifact opened from the idea
 * session canvas) is resolved by the pane against its OWN runId via
 * `artifacts.get`, never from the session-scoped list this hook syncs. It is
 * therefore absent from that list BY CONSTRUCTION — without the exemption the
 * prune loop would close it the instant it opened (the "Loading… then gone"
 * failure the feature exists to fix).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useArtifactTabsSync } from '../useArtifactTabsSync';
import { useCenterPaneStore } from '../../stores/centerPaneStore';
import { FLOW_TAB_ID, makeFlowTab, type TabItem } from '../../../../shared/types/centerPane';
import type { Artifact } from '../../../../shared/types/artifacts';

const SESSION_KEY = 'sess-1';

const EXTERNAL_TAB: TabItem = {
  id: 'art:decomposed-stories:art-remote',
  kind: 'artifact',
  label: 'Stories',
  atype: 'decomposed-stories',
  artifactId: 'art-remote',
  runId: 'run-planner-9',
  external: true,
  committed: false,
};

function seedWithExternalTab(): void {
  useCenterPaneStore.setState({
    bySession: {
      [SESSION_KEY]: {
        tabs: [makeFlowTab(), EXTERNAL_TAB],
        activeTabId: EXTERNAL_TAB.id,
        terminalOpen: true,
        rightTab: 'steps',
      },
    },
  });
}

describe('useArtifactTabsSync — external tabs', () => {
  beforeEach(() => {
    useCenterPaneStore.setState({ bySession: {} });
  });

  it('keeps an external tab open even though its row is absent from the session list', () => {
    seedWithExternalTab();
    const { rerender } = renderHook(
      ({ artifacts, loaded }: { artifacts: Artifact[]; loaded: boolean }) =>
        useArtifactTabsSync(SESSION_KEY, artifacts, loaded),
      { initialProps: { artifacts: [] as Artifact[], loaded: true } },
    );
    rerender({ artifacts: [], loaded: true });

    const session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    expect(session.tabs.some((t) => t.id === EXTERNAL_TAB.id)).toBe(true);
    expect(session.activeTabId).toBe(EXTERNAL_TAB.id);
  });

  it('still prunes a NON-external tab whose row vanished, alongside a surviving external one', () => {
    useCenterPaneStore.setState({
      bySession: {
        [SESSION_KEY]: {
          tabs: [
            makeFlowTab(),
            EXTERNAL_TAB,
            {
              id: 'art:screenshots',
              kind: 'artifact',
              label: 'Screenshots',
              atype: 'screenshots',
              artifactId: 'art-local',
              committed: false,
            },
          ],
          activeTabId: 'art:screenshots',
          terminalOpen: true,
          rightTab: 'steps',
        },
      },
    });

    renderHook(() => useArtifactTabsSync(SESSION_KEY, [], true));

    const session = useCenterPaneStore.getState().bySession[SESSION_KEY];
    expect(session.tabs.some((t) => t.id === 'art:screenshots')).toBe(false);
    expect(session.tabs.some((t) => t.id === EXTERNAL_TAB.id)).toBe(true);
    expect(session.tabs.some((t) => t.id === FLOW_TAB_ID)).toBe(true);
  });
});
