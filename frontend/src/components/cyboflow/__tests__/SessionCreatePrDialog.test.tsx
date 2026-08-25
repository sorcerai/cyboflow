import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../utils/api', () => ({
  API: {
    sessions: {
      gitPush: vi.fn(),
      getRemoteUrl: vi.fn(),
      delete: vi.fn(),
      markComplete: vi.fn(),
    },
  },
}));

const mockShowError = vi.fn();
vi.mock('../../../stores/errorStore', () => ({
  useErrorStore: Object.assign(vi.fn(() => ({})), {
    getState: vi.fn(() => ({ showError: mockShowError })),
  }),
}));

import { SessionCreatePrDialog } from '../SessionCreatePrDialog';
import { API } from '../../../utils/api';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(API.sessions.gitPush).mockResolvedValue({ success: true });
  vi.mocked(API.sessions.delete).mockResolvedValue({ success: true });
  vi.mocked(API.sessions.markComplete).mockResolvedValue({ success: true, data: { stamped: 1 } });
  vi.mocked(API.sessions.getRemoteUrl).mockResolvedValue({
    success: true,
    data: { remoteUrl: 'https://github.com/o/r.git', branchName: 'my-branch' },
  });
  // openExternal is invoked directly off window.electronAPI, not API.sessions.
  (window as unknown as { electronAPI: { openExternal: ReturnType<typeof vi.fn> } }).electronAPI = {
    ...(window as unknown as { electronAPI?: object }).electronAPI,
    openExternal: vi.fn().mockResolvedValue(undefined),
  } as never;
});

describe('SessionCreatePrDialog', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    sessionId: 'sess-pr-1',
    sessionName: 'my-session',
    onSuccess: vi.fn(),
  };

  it('push + open GitHub no longer deletes unconditionally — lands on the closeout choice', async () => {
    render(<SessionCreatePrDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText(/Push & open GitHub/));
    });

    expect(API.sessions.gitPush).toHaveBeenCalledWith('sess-pr-1');
    expect(API.sessions.delete).not.toHaveBeenCalled();
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
    expect(screen.getByText('Mark complete')).toBeInTheDocument();
    expect(screen.getByText('Keep session open')).toBeInTheDocument();
  });

  it('"Keep session open" leaves the session alone: no delete, no markComplete, just onClose', async () => {
    render(<SessionCreatePrDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText(/Push & open GitHub/));
    });

    fireEvent.click(screen.getByText('Keep session open'));

    expect(API.sessions.delete).not.toHaveBeenCalled();
    expect(API.sessions.markComplete).not.toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('"Mark complete" calls markComplete then delete, then onSuccess and onClose', async () => {
    render(<SessionCreatePrDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText(/Push & open GitHub/));
    });

    const callOrder: string[] = [];
    vi.mocked(API.sessions.markComplete).mockImplementation(async () => {
      callOrder.push('markComplete');
      return { success: true, data: { stamped: 1 } };
    });
    vi.mocked(API.sessions.delete).mockImplementation(async () => {
      callOrder.push('delete');
      return { success: true };
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('create-pr-mark-complete'));
    });

    expect(callOrder).toEqual(['markComplete', 'delete']);
    expect(defaultProps.onSuccess).toHaveBeenCalled();
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('a failed markComplete does not call delete', async () => {
    render(<SessionCreatePrDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText(/Push & open GitHub/));
    });

    vi.mocked(API.sessions.markComplete).mockResolvedValue({ success: false, error: 'stamp failed' });

    await act(async () => {
      fireEvent.click(screen.getByTestId('create-pr-mark-complete'));
    });

    expect(API.sessions.delete).not.toHaveBeenCalled();
    expect(defaultProps.onSuccess).not.toHaveBeenCalled();
    expect(mockShowError).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Mark complete failed',
      error: 'stamp failed',
    }));
  });

  it('non-GitHub remote: fallback Done proceeds to the same closeout choice (no unconditional delete)', async () => {
    vi.mocked(API.sessions.getRemoteUrl).mockResolvedValue({
      success: true,
      data: { remoteUrl: 'https://example.com/o/r.git', branchName: 'my-branch' },
    });

    render(<SessionCreatePrDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText(/Push & open GitHub/));
    });

    expect(screen.getByText('my-branch')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Done'));

    expect(API.sessions.delete).not.toHaveBeenCalled();
    expect(screen.getByText('Mark complete')).toBeInTheDocument();
    expect(screen.getByText('Keep session open')).toBeInTheDocument();
  });

  it('push failure shows an error and stays on the confirm step', async () => {
    vi.mocked(API.sessions.gitPush).mockResolvedValue({ success: false, error: 'no remote' });

    render(<SessionCreatePrDialog {...defaultProps} />);

    await act(async () => {
      fireEvent.click(screen.getByText(/Push & open GitHub/));
    });

    expect(mockShowError).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Push failed',
      error: 'no remote',
    }));
    expect(screen.getByText(/Push & open GitHub/)).toBeInTheDocument();
  });
});
