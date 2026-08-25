/**
 * SubstrateSelector under the FLIPPED `selectableInPickers` state for OMP.
 *
 * Separate file from SubstrateSelector.test.tsx on purpose: that suite proves
 * the UNFLIPPED default (omp-sdk/omp-pty absent from every picker even with
 * the provider switched on — see its "offers exactly the picker-selectable
 * runtimes" describe block), which this file must not disturb. Here the
 * capability module is mocked to simulate the day
 * RUNTIME_CAPABILITIES.omp-sdk/omp-pty.selectableInPickers flips to true (the
 * "last Phase-1 step" docs/proposals/omp-provider-integration.md §5.5
 * describes) — proving the row, its onChange wiring, and the provider-toggle
 * interplay all work ahead of that flip, with everything else (every other
 * runtime's selectability) delegating to the real implementation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../../hooks/useForcedSubstrate', () => ({
  useForcedSubstrate: () => null,
}));

vi.mock('../../../../../shared/types/agentCapabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../shared/types/agentCapabilities')>();
  return {
    ...actual,
    isRuntimeSelectableInPickers: (runtime: string | null | undefined) =>
      runtime === 'omp-sdk' || runtime === 'omp-pty' ? true : actual.isRuntimeSelectableInPickers(runtime),
  };
});

import { SubstrateSelector } from '../SubstrateSelector';
import { useConfigStore } from '../../../stores/configStore';
import type { AppConfig } from '../../../types/config';
import type { AgentProviderAccess } from '../../../../../shared/types/agentRuntime';

function setProviderAccess(access: AgentProviderAccess | undefined): void {
  useConfigStore.setState({
    config: { gitRepoPath: '/repo', agentProviderAccess: access } as AppConfig,
  });
}

beforeEach(() => {
  useConfigStore.setState({ config: null });
});

describe('SubstrateSelector — OMP rows once selectableInPickers flips', () => {
  it('offers omp-sdk and omp-pty as real, enabled options once flipped AND the provider is on', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByRole('option', { name: 'OMP' })).not.toBeDisabled();
    expect(screen.getByRole('option', { name: 'OMP (CLI)' })).not.toBeDisabled();
  });

  it('still hides the OMP rows when flipped but the provider itself is off (absent ⇒ disabled)', () => {
    setProviderAccess({ claude: true, codex: true });
    render(<SubstrateSelector value="claude-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.queryByRole('option', { name: /OMP/i })).not.toBeInTheDocument();
  });

  it('selecting omp-sdk fires onChange with the runtime id', () => {
    const onChange = vi.fn();
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="claude-sdk" onChange={onChange} runtimeScope="session" />);

    fireEvent.change(screen.getByRole('combobox', { name: /select agent runtime/i }), {
      target: { value: 'omp-sdk' },
    });
    expect(onChange).toHaveBeenCalledWith('omp-sdk');
  });

  it('renders the OMP — v1 limits caveats once omp-sdk is the live selected value', () => {
    setProviderAccess({ claude: true, codex: true, omp: true });
    render(<SubstrateSelector value="omp-sdk" onChange={vi.fn()} runtimeScope="session" />);

    expect(screen.getByTestId('substrate-caveats')).toHaveTextContent('OMP — v1 limits');
  });
});
