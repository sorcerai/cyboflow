/**
 * Coachmark — reachability of content the tour points at on a short window.
 *
 * Regression cover for the reported first-run dead end ("My Mac was not in full
 * screen, and because of that I couldn't scroll to the next item in the
 * onboarding flow at the bottom of the page"): steps 6-8 anchor into the
 * wizard's Configure column, and the scrim that makes the tour modal is
 * pointer-events-auto, so a wheel over it resolved against the scrim's OWN
 * ancestor chain (the fixed portal host) and scrolled nothing. With the CTA
 * below the fold the tour could not be completed at all.
 *
 * Both halves of the fix are pinned here: the wheel must drive the ANCHOR's
 * scroll container, and an anchor that starts below the fold must be brought
 * into view once when the step opens.
 */
import '@testing-library/jest-dom';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Coachmark } from './Coachmark';
import { ONBOARDING_ANCHOR_ATTR, ONBOARDING_ANCHORS } from '../../utils/onboarding';

/**
 * A scrollable container holding the coach anchor. jsdom has no layout, so the
 * scroll geometry (and scrollTop itself, which jsdom pins to 0) is defined here.
 */
function mountAnchor(): { scroller: HTMLElement; anchor: HTMLElement; scrollTop: () => number } {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
  let top = 0;
  Object.defineProperty(scroller, 'scrollTop', {
    get: () => top,
    set: (v: number) => {
      top = v;
    },
    configurable: true,
  });

  const anchor = document.createElement('div');
  anchor.setAttribute(ONBOARDING_ANCHOR_ATTR, ONBOARDING_ANCHORS.substrateSelect);
  scroller.appendChild(anchor);
  document.body.appendChild(scroller);
  return { scroller, anchor, scrollTop: () => top };
}

const noop = (): void => {};

function renderCoach() {
  // Step 6 (substrate) — a pointer step anchored into the wizard Configure column.
  return render(
    <Coachmark
      step={6}
      maxVisitedStep={6}
      onBack={noop}
      onSkip={noop}
      onGoTo={noop}
      onAnchorActioned={noop}
      onNext={noop}
      onForward={noop}
    />,
  );
}

describe('Coachmark scroll reachability', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom does not implement scrollIntoView; the component feature-detects it.
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView'];
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('forwards a wheel over the scrim to the anchor\'s scroll container', async () => {
    const { scrollTop } = mountAnchor();
    const { findAllByTestId } = renderCoach();

    const scrims = await findAllByTestId('coach-scrim');
    expect(scrims.length).toBe(4);

    fireEvent.wheel(scrims[0], { deltaY: 120 });
    expect(scrollTop()).toBe(120);

    // Further wheels accumulate, and any of the four rects works.
    fireEvent.wheel(scrims[3], { deltaY: 80 });
    expect(scrollTop()).toBe(200);
  });

  it('normalizes line-mode wheel deltas to pixels', async () => {
    const { scrollTop } = mountAnchor();
    const { findAllByTestId } = renderCoach();

    const scrims = await findAllByTestId('coach-scrim');
    fireEvent.wheel(scrims[0], { deltaY: 3, deltaMode: 1 });
    expect(scrollTop()).toBe(48);
  });

  it('scrolls the anchor into view once when the step opens', async () => {
    mountAnchor();
    renderCoach();

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    // The rect tracker runs every frame; the reveal must not repeat and fight
    // the user's own scrolling.
    const callsAfterReveal = scrollIntoView.mock.calls.length;
    // act(): the rect tracker keeps setting state across these frames.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(scrollIntoView.mock.calls.length).toBe(callsAfterReveal);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
  });

  it('is inert when the anchor has no scrollable ancestor', async () => {
    const anchor = document.createElement('div');
    anchor.setAttribute(ONBOARDING_ANCHOR_ATTR, ONBOARDING_ANCHORS.substrateSelect);
    document.body.appendChild(anchor);

    const { findAllByTestId } = renderCoach();
    const scrims = await findAllByTestId('coach-scrim');
    // No throw, nothing to scroll.
    expect(() => fireEvent.wheel(scrims[0], { deltaY: 120 })).not.toThrow();
  });
});
