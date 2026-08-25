/**
 * QuickSessionCenterPane — EXTERNAL artifact tabs + the idea-session home
 * branch (idea sessions plan, Stages 3 + 5).
 *
 * Companion to QuickSessionCenterPane.test.tsx (which covers the session-scoped
 * artifact resolution). Here:
 *   1. an EXTERNAL tab (a cross-run, idea-scoped artifact) resolves through
 *      useExternalArtifact — NOT the session list — and renders with the
 *      artifact's OWN runId;
 *   2. while that fetch is in flight it renders the Loading state, and an
 *      artifact that resolves to null renders the absent state rather than
 *      hanging on "Loading…" forever;
 *   3. the home tab hosts the IdeaSessionCanvas when the session is an idea's
 *      home (`homeIdeaId`), and the QuickSessionCanvas otherwise.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session } from '../../../types/session';
import type { Artifact } from '../../../../../shared/types/artifacts';

vi.mock('../QuickSessionCanvas', () => ({
  QuickSessionCanvas: () => <div data-testid="mock-quick-session-canvas" />,
}));
vi.mock('../IdeaSessionCanvas', () => ({
  IdeaSessionCanvas: (props: { ideaId: string; sessionKey: string }) => (
    <div
      data-testid="mock-idea-session-canvas"
      data-idea-id={props.ideaId}
      data-session-key={props.sessionKey}
    />
  ),
}));
vi.mock('../../../hooks/useArtifactsList', () => ({
  useSessionArtifactsList: () => ({ artifacts: [], loaded: true }),
}));

// The external fetch — its own contract is the hook's; here it is driven so the
// pane's three branches (resolved / loading / absent) are observable.
let mockExternal: { artifact: Artifact | null; loading: boolean } = {
  artifact: null,
  loading: false,
};
const mockUseExternalArtifact = vi.fn(() => mockExternal);
vi.mock('../../../hooks/useExternalArtifact', () => ({
  useExternalArtifact: (...args: unknown[]) => {
    mockUseExternalArtifact(...(args as []));
    return mockExternal;
  },
}));

vi.mock('../ArtifactTabRenderer', () => ({
  ArtifactTabRenderer: (props: { runId: string }) => (
    <div data-testid="mock-artifact-tab-renderer" data-run-id={props.runId} />
  ),
}));

import { QuickSessionCenterPane } from '../QuickSessionCenterPane';
import { useCenterPaneStore } from '../../../stores/centerPaneStore';
import { FLOW_TAB_ID, makeFlowTab } from '../../../../../shared/types/centerPane';

const SESSION = {
  id: 's1',
  name: 'tester-mctest',
  worktreePath: '/repo',
  prompt: '',
  status: 'stopped',
  createdAt: new Date().toISOString(),
  output: [],
  jsonMessages: [],
} as Session;

const EXTERNAL_TAB_ID = 'art:decomposed-stories:art-remote';

function seedExternalTab(): void {
  useCenterPaneStore.setState({
    bySession: {
      s1: {
        tabs: [
          makeFlowTab(),
          {
            id: EXTERNAL_TAB_ID,
            kind: 'artifact',
            label: 'Stories',
            atype: 'decomposed-stories',
            artifactId: 'art-remote',
            runId: 'run-planner-9',
            external: true,
            committed: false,
          },
        ],
        activeTabId: EXTERNAL_TAB_ID,
        terminalOpen: true,
        rightTab: 'steps',
      },
    },
  });
}

function renderPane(session: Session = SESSION) {
  return render(
    <QuickSessionCenterPane
      session={session}
      projectId={7}
      projectName="tester-mctest"
      onBrowseAll={() => {}}
      onAddWorkflowToNewSession={() => {}}
      dockContent={<div data-testid="dock" />}
    />,
  );
}

describe('QuickSessionCenterPane — external artifact tabs', () => {
  beforeEach(() => {
    useCenterPaneStore.setState({ bySession: {} });
    mockExternal = { artifact: null, loading: false };
    mockUseExternalArtifact.mockClear();
  });

  it('resolves an external tab via useExternalArtifact and renders it with the artifact OWN runId', () => {
    seedExternalTab();
    mockExternal = {
      loading: false,
      artifact: {
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
      },
    };
    renderPane();

    expect(screen.getByTestId('mock-artifact-tab-renderer')).toHaveAttribute(
      'data-run-id',
      'run-planner-9',
    );
    // The hook is asked for exactly this (artifactId, runId, atype) identity —
    // runId + atype are what reach the committed on-disk snapshot.
    expect(mockUseExternalArtifact).toHaveBeenCalledWith(7, {
      artifactId: 'art-remote',
      runId: 'run-planner-9',
      atype: 'decomposed-stories',
    });
  });

  it('renders the Loading state while the external fetch is in flight', () => {
    seedExternalTab();
    mockExternal = { artifact: null, loading: true };
    renderPane();
    expect(screen.getByText(/Loading Stories/)).toBeInTheDocument();
    expect(screen.queryByTestId('mock-artifact-tab-renderer')).not.toBeInTheDocument();
  });

  it('renders an absent state (not a perpetual Loading) when the row resolves to null', () => {
    seedExternalTab();
    mockExternal = { artifact: null, loading: false };
    renderPane();
    expect(screen.getByText(/no longer available/)).toBeInTheDocument();
  });

  it('passes a null target for a non-external tab (the hook stays inert)', () => {
    useCenterPaneStore.setState({
      bySession: {
        s1: {
          tabs: [makeFlowTab()],
          activeTabId: FLOW_TAB_ID,
          terminalOpen: true,
          rightTab: 'steps',
        },
      },
    });
    renderPane();
    expect(mockUseExternalArtifact).toHaveBeenCalledWith(7, null);
  });
});

describe('QuickSessionCenterPane — home tab canvas selection', () => {
  beforeEach(() => {
    useCenterPaneStore.setState({ bySession: {} });
    mockExternal = { artifact: null, loading: false };
  });

  it('renders the QuickSessionCanvas for an ordinary quick session', () => {
    renderPane();
    expect(screen.getByTestId('mock-quick-session-canvas')).toBeInTheDocument();
  });

  it('renders the IdeaSessionCanvas for an idea HOME session, keyed by the pane session', () => {
    renderPane({ ...SESSION, homeIdeaId: 'idea-42' });
    const canvas = screen.getByTestId('mock-idea-session-canvas');
    expect(canvas).toHaveAttribute('data-idea-id', 'idea-42');
    expect(canvas).toHaveAttribute('data-session-key', 's1');
    expect(screen.queryByTestId('mock-quick-session-canvas')).not.toBeInTheDocument();
  });
});
