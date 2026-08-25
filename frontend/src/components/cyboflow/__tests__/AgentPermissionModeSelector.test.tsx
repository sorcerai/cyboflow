/**
 * The permission picker's per-provider option sets.
 *
 * The four mode IDS are fixed — they are the `PermissionMode` union the session
 * column stores — so what varies per provider is only the COPY: what each mode
 * actually does, and where the resulting approval requests surface. That copy is
 * the whole point of keying the option set to the provider, and it is also the
 * thing that silently reads as Claude's behavior if a provider is added without
 * an arm here. So each arm is pinned by its distinguishing sentence rather than
 * by counting buttons.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentPermissionModeSelector } from '../AgentPermissionModeSelector';

describe('AgentPermissionModeSelector — per-provider option sets', () => {
  it('offers the same four modes for every provider', () => {
    for (const provider of ['claude', 'codex', 'omp'] as const) {
      const { unmount } = render(
        <AgentPermissionModeSelector value="default" onChange={vi.fn()} agentProvider={provider} />,
      );
      expect(screen.getAllByRole('button')).toHaveLength(4);
      unmount();
    }
  });

  it('describes OMP approval-free mode instead of borrowing Claude wording', () => {
    render(
      <AgentPermissionModeSelector
        value="default"
        onChange={vi.fn()}
        agentProvider="omp"
        agentRuntime="omp-sdk"
      />,
    );

    expect(screen.getByText(/OMP runs approval-free/i)).toBeInTheDocument();
    expect(screen.getByText(/requests appear in the review queue/i)).toBeInTheDocument();
    expect(screen.queryByText(/skip permissions/i)).not.toBeInTheDocument();
  });

  it('sends OMP CLI approvals to the terminal, not the review queue', () => {
    render(
      <AgentPermissionModeSelector
        value="default"
        onChange={vi.fn()}
        agentProvider="omp"
        agentRuntime="omp-pty"
      />,
    );

    expect(screen.getByText(/do not enter the Cyboflow review queue/i)).toBeInTheDocument();
  });

  it('defaults an OMP session with no runtime prop to the structured set, as Codex does', () => {
    render(<AgentPermissionModeSelector value="default" onChange={vi.fn()} agentProvider="omp" />);

    expect(screen.getByText(/requests appear in the review queue/i)).toBeInTheDocument();
    expect(screen.queryByText(/do not enter the Cyboflow review queue/i)).not.toBeInTheDocument();
  });

  it('leaves the Claude and Codex copy untouched', () => {
    const { unmount } = render(
      <AgentPermissionModeSelector value="default" onChange={vi.fn()} agentProvider="claude" />,
    );
    expect(screen.getByText('Native Claude classifier')).toBeInTheDocument();
    expect(screen.queryByText(/review queue/i)).not.toBeInTheDocument();
    unmount();

    render(
      <AgentPermissionModeSelector
        value="default"
        onChange={vi.fn()}
        agentProvider="codex"
        agentRuntime="codex-sdk"
      />,
    );
    expect(screen.getByText(/Auto lets Codex review approval requests/i)).toBeInTheDocument();
  });
});
