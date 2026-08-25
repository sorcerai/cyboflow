/**
 * CategoryTag (migration 059) + FlowMarker (session-attribution seam) +
 * LedgerChip (idea component ledger, migration 101) unit tests. markers.tsx
 * otherwise has no direct test coverage — TaskCard/BacklogPane exercise the
 * other markers indirectly.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CategoryTag, FlowMarker, LedgerChip, ledgerChipVisualState } from '../markers';
import type { EntityCategory, FlowOverlay } from '../../../../../shared/types/tasks';
import type { IdeaComponentState } from '../../../../../shared/types/ideaComponents';

describe('CategoryTag', () => {
  it.each<[EntityCategory, string]>([
    ['feature', 'Feature'],
    ['bug', 'Bug'],
    ['chore', 'Chore'],
  ])('renders the %s label and title', (category, label) => {
    render(<CategoryTag category={category} />);
    const tag = screen.getByTestId('category-tag');
    expect(tag).toHaveTextContent(label);
    expect(tag).toHaveAttribute('title', `Category: ${label}`);
  });

  it('gives bug the error-tone class (attention-grabbing) unlike chore/feature', () => {
    const { unmount: unmountBug } = render(<CategoryTag category="bug" />);
    expect(screen.getByTestId('category-tag').className).toContain('status-error');
    unmountBug();

    const { unmount: unmountChore } = render(<CategoryTag category="chore" />);
    expect(screen.getByTestId('category-tag').className).not.toContain('status-error');
    unmountChore();

    render(<CategoryTag category="feature" />);
    expect(screen.getByTestId('category-tag').className).not.toContain('status-error');
  });
});

describe('FlowMarker', () => {
  function flow(over: Partial<FlowOverlay> = {}): FlowOverlay {
    return {
      agent: 'sprint',
      runId: 'run-abcdefgh',
      stepId: null,
      runStatus: 'running',
      sessionId: null,
      sessionName: null,
      ...over,
    };
  }

  it('prefers the session name over the run id slice when known', () => {
    render(<FlowMarker flow={flow({ sessionId: 'sess-1', sessionName: 'quick-20260714-100000' })} />);
    expect(screen.getByTestId('flow-marker')).toHaveTextContent('sprint · quick-20260714-100000');
  });

  it('falls back to the short run id when the session name is unresolved', () => {
    render(<FlowMarker flow={flow({ sessionName: null })} />);
    expect(screen.getByTestId('flow-marker')).toHaveTextContent('sprint · run-abcd');
  });

  it('renders as a button and fires onOpen on click when a session is attached', () => {
    const onOpen = vi.fn();
    render(
      <FlowMarker
        flow={flow({ sessionId: 'sess-1', sessionName: 'quick-20260714-100000' })}
        onOpen={onOpen}
      />,
    );
    const pill = screen.getByTestId('flow-marker');
    expect(pill.tagName).toBe('BUTTON');
    fireEvent.click(pill);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('stays a non-interactive span when onOpen is absent (session-less run)', () => {
    render(<FlowMarker flow={flow()} />);
    expect(screen.getByTestId('flow-marker').tagName).toBe('SPAN');
  });

  it('pulses the dot only while runStatus === running', () => {
    const { container, unmount } = render(<FlowMarker flow={flow({ runStatus: 'running' })} />);
    expect(container.querySelector('.animate-ping')).not.toBeNull();
    unmount();

    render(<FlowMarker flow={flow({ runStatus: 'queued' })} />);
    expect(document.querySelector('.animate-ping')).toBeNull();
  });
});

describe('LedgerChip', () => {
  function component(over: Partial<IdeaComponentState> = {}): IdeaComponentState {
    return {
      component: 'prototype',
      state: 'incomplete',
      source: 'derived',
      sourceRunId: null,
      sourceSessionId: null,
      builtAgainstVersion: null,
      staleAt: null,
      staleReason: null,
      updatedAt: null,
      ...over,
    };
  }

  it('labels the chip from IDEA_COMPONENT_LABELS, not a re-derived string', () => {
    render(<LedgerChip component={component({ component: 'idea-spec' })} />);
    expect(screen.getByTestId('ledger-chip-idea-spec')).toHaveTextContent('Idea spec');
  });

  it('renders the success treatment for a complete component', () => {
    render(<LedgerChip component={component({ state: 'complete' })} />);
    const chip = screen.getByTestId('ledger-chip-prototype');
    expect(chip).toHaveAttribute('data-ledger-state', 'complete');
    expect(chip.className).toContain('status-success');
  });

  it('renders the muted, dashed treatment for a skipped component', () => {
    render(<LedgerChip component={component({ state: 'skipped' })} />);
    const chip = screen.getByTestId('ledger-chip-prototype');
    expect(chip).toHaveAttribute('data-ledger-state', 'skipped');
    expect(chip.className).toContain('border-dashed');
  });

  // THE regression guard: staleness is a separate axis from state, so an
  // incomplete-with-prior-work component must never collapse into the same
  // visual as one that was simply never started.
  it('gives "needs review" (stale) a DIFFERENT treatment than "not started"', () => {
    const { unmount } = render(
      <LedgerChip component={component({ state: 'incomplete', staleAt: '2026-08-01T00:00:00Z' })} />,
    );
    const staleChip = screen.getByTestId('ledger-chip-prototype');
    expect(staleChip).toHaveAttribute('data-ledger-state', 'needs-review');
    expect(staleChip.className).toContain('status-warning');
    const staleClassName = staleChip.className;
    unmount();

    render(<LedgerChip component={component({ state: 'incomplete', staleAt: null })} />);
    const freshChip = screen.getByTestId('ledger-chip-prototype');
    expect(freshChip).toHaveAttribute('data-ledger-state', 'not-started');
    expect(freshChip.className).not.toBe(staleClassName);
    expect(freshChip.className).not.toContain('status-warning');
  });

  it('ledgerChipVisualState resolves all four states from (state, staleAt)', () => {
    expect(ledgerChipVisualState({ state: 'complete', staleAt: null })).toBe('complete');
    expect(ledgerChipVisualState({ state: 'skipped', staleAt: null })).toBe('skipped');
    expect(ledgerChipVisualState({ state: 'incomplete', staleAt: null })).toBe('not-started');
    expect(ledgerChipVisualState({ state: 'incomplete', staleAt: '2026-08-01T00:00:00Z' })).toBe('needs-review');
  });
});
