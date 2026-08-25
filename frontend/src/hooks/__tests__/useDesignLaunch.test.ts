/**
 * Unit tests for useDesignLaunch (idea sessions plan, Stage 4/5
 * "useDesignLaunch extraction").
 *
 * useQuickSession itself is REAL (not mocked) — only its dependencies
 * (API.sessions.createQuick, panelApi, the stream subscription) are, exactly
 * like useQuickSession.test.tsx — so these tests exercise the actual
 * `start(...)` positional-arg call useDesignLaunch builds.
 *
 * Behaviors verified:
 *   1. No overrides (the idea canvas's one-click Design tile): resolves this
 *      hook's own defaults (stored quick default -> global config -> floor)
 *      and still hard-pins substrate/provider/runtime + kickoff + designIdeaId.
 *   2. Overrides supplied (SessionStartWizard's Configure step): threaded
 *      through VERBATIM, beating this hook's own defaults.
 *   3. onSuccess always calls enterDesignMode, unconditionally.
 *   4. overrides.onSuccess fires AFTER enterDesignMode, with the session id.
 *   5. A createQuick failure surfaces in `error`, not a rejection.
 *   6. isLaunching reflects the in-flight state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useDesignLaunch } from '../useDesignLaunch';
import { DESIGN_KICKOFF_PROMPT } from '../../../../shared/types/designKickoff';

const { mockCreateQuick, mockCreatePanel } = vi.hoisted(() => ({
  mockCreateQuick: vi.fn(),
  mockCreatePanel: vi.fn(),
}));

vi.mock('../../utils/api', () => ({
  API: {
    sessions: { createQuick: mockCreateQuick },
    claudePanels: {
      setModel: vi.fn().mockResolvedValue({ success: true }),
      setFastMode: vi.fn().mockResolvedValue({ success: true }),
      setEffort: vi.fn().mockResolvedValue({ success: true }),
    },
    // panels.continue — the auto-start kickoff's dispatch target
    // (dispatchQuickSessionInput's 'continue' branch, fired fire-and-forget
    // after every successful launch since DESIGN_KICKOFF_PROMPT is always
    // threaded as kickoffPrompt). Not itself under test here — covered by
    // SessionStartWizard.test.tsx's "sends DESIGN_KICKOFF_PROMPT..." case —
    // just present so useQuickSession's dispatch has a real mock to hit.
    panels: {
      continue: vi.fn().mockResolvedValue({ success: true }),
    },
  },
}));

vi.mock('../../services/panelApi', () => ({
  panelApi: { createPanel: mockCreatePanel },
}));

vi.mock('../../utils/cyboflowApi', () => ({
  subscribeToStreamEvents: vi.fn(() => vi.fn()),
}));

import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useConfigStore } from '../../stores/configStore';
import { useDesignModeStore } from '../../stores/designModeStore';
import { API } from '../../utils/api';
import { DEFAULT_QUICK_MODEL } from '../../../../shared/types/sessionDefaults';
import type { AppConfig } from '../../types/config';

const mockPanelsContinue = vi.mocked(API.panels.continue);

beforeEach(() => {
  mockCreateQuick.mockReset();
  mockCreatePanel.mockReset();
  mockPanelsContinue.mockClear();
  mockCreateQuick.mockResolvedValue({
    success: true,
    data: { jobId: 'job-1', sessionId: 'sess-design-1', worktreePath: '/tmp/wt-design', runId: 'run-1' },
  });
  mockCreatePanel.mockResolvedValue({
    id: 'panel-design-1',
    sessionId: 'sess-design-1',
    type: 'claude',
    title: 'Chat',
    state: { isActive: true },
    createdAt: '',
    lastActiveAt: '',
    position: 0,
  });

  act(() => {
    useCyboflowStore.getState().clearActiveQuickSession();
    useConfigStore.setState({ config: null, isLoading: false, error: null });
    useDesignModeStore.setState({ activeDesignSessionId: null });
  });
});

describe('useDesignLaunch — no overrides (one-click launch)', () => {
  it('hard-pins substrate/provider/runtime + designIdeaId + the kickoff prompt', async () => {
    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 1,
        substrate: 'sdk',
        agentProvider: 'claude',
        agentRuntime: 'claude-sdk',
        designIdeaId: 'IDEA-7',
      }),
    );
    // The auto-start kickoff (design-mode.md v0.5) — fired fire-and-forget as
    // the freshly-created panel's first turn.
    expect(mockPanelsContinue).toHaveBeenCalledWith(
      'panel-design-1',
      DESIGN_KICKOFF_PROMPT,
      undefined,
      undefined,
      undefined,
    );
  });

  it('resolves the quick-floor model and default permission mode when nothing is configured', async () => {
    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPermissionMode: 'default',
        claudeConfig: expect.objectContaining({ model: DEFAULT_QUICK_MODEL }),
      }),
    );
  });

  it('honors a stored quick run-type default model when no override is passed', async () => {
    act(() => {
      useConfigStore.setState({
        config: { runTypeDefaults: { quick: { model: 'sonnet', permissionMode: 'acceptEdits' } } } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7');
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPermissionMode: 'acceptEdits',
        claudeConfig: expect.objectContaining({ model: 'sonnet' }),
      }),
    );
  });
});

describe('useDesignLaunch — overrides (a caller with its own Configure UI)', () => {
  it('threads every override field through verbatim, beating this hook\'s own defaults', async () => {
    act(() => {
      // A stored default that overrides MUST beat.
      useConfigStore.setState({
        config: { runTypeDefaults: { quick: { model: 'sonnet', permissionMode: 'acceptEdits' } } } as unknown as AppConfig,
      });
    });

    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7', {
        permissionMode: 'dontAsk',
        model: 'opus',
        fastMode: true,
        disabledMcpServers: ['srv-a'],
        enabledPlugins: ['plugin-a'],
        worktreeModeOverride: 'in-place',
        reasoningEffort: 'high',
      });
    });

    expect(mockCreateQuick).toHaveBeenCalledWith(
      expect.objectContaining({
        agentPermissionMode: 'dontAsk',
        worktreeMode: 'in-place',
        claudeConfig: { model: 'opus', fastMode: true, reasoningEffort: 'high' },
        disabledMcpServers: ['srv-a'],
        enabledPlugins: ['plugin-a'],
      }),
    );
  });
});

describe('useDesignLaunch — onSuccess', () => {
  it('always calls enterDesignMode, unconditionally', async () => {
    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7');
    });

    expect(useDesignModeStore.getState().activeDesignSessionId).toBe('sess-design-1');
  });

  it('fires overrides.onSuccess AFTER enterDesignMode, with the session id', async () => {
    const order: string[] = [];
    const spy = vi.fn((sessionId: string) => {
      order.push('override-onSuccess');
      expect(useDesignModeStore.getState().activeDesignSessionId).toBe(sessionId);
    });

    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7', {
        onSuccess: spy,
      });
    });

    expect(spy).toHaveBeenCalledWith('sess-design-1');
    expect(order).toEqual(['override-onSuccess']);
  });

  it('does not leak a prior onSuccess override into a later no-override call', async () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7', {
        onSuccess: spy,
      });
    });
    expect(spy).toHaveBeenCalledTimes(1);

    mockCreateQuick.mockResolvedValueOnce({
      success: true,
      data: { jobId: 'job-2', sessionId: 'sess-design-2', worktreePath: '/tmp/wt-design-2', runId: 'run-2' },
    });
    mockCreatePanel.mockResolvedValueOnce({
      id: 'panel-design-2',
      sessionId: 'sess-design-2',
      type: 'claude',
      title: 'Chat',
      state: { isActive: true },
      createdAt: '',
      lastActiveAt: '',
      position: 0,
    });

    await act(async () => {
      await result.current.launchDesign('IDEA-8');
    });

    // Still exactly once — the second, override-less launch never re-fired it.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useDesignModeStore.getState().activeDesignSessionId).toBe('sess-design-2');
  });
});

describe('useDesignLaunch — failure', () => {
  it('surfaces a design-door rejection (e.g. idea-busy) in `error`, without throwing', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'Idea IDEA-7 already has a session running' });

    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7');
    });

    expect(result.current.error).toBe('Idea IDEA-7 already has a session running');
    expect(useDesignModeStore.getState().activeDesignSessionId).toBeNull();
  });

  it('isLaunching returns to false after a failure', async () => {
    mockCreateQuick.mockResolvedValueOnce({ success: false, error: 'boom' });

    const { result } = renderHook(() => useDesignLaunch(1));

    await act(async () => {
      await result.current.launchDesign('IDEA-7');
    });

    expect(result.current.isLaunching).toBe(false);
  });
});

describe('useDesignLaunch — isLaunching', () => {
  it('is true while the call is in-flight and false once it settles', async () => {
    let resolveCall!: (value: unknown) => void;
    mockCreateQuick.mockReturnValueOnce(new Promise((resolve) => { resolveCall = resolve; }));

    const { result } = renderHook(() => useDesignLaunch(1));

    expect(result.current.isLaunching).toBe(false);

    act(() => {
      void result.current.launchDesign('IDEA-7');
    });

    await waitFor(() => {
      expect(result.current.isLaunching).toBe(true);
    });

    await act(async () => {
      resolveCall({ success: false, error: 'cancelled' });
    });

    expect(result.current.isLaunching).toBe(false);
  });
});
