/**
 * Modal component tests — covers Escape-key handling, in particular the
 * nested-modal stack fix: a document-level Escape keypress must only close
 * the top-most open modal, not every ancestor at once.
 *
 * Tests:
 *   1. Single modal closes on Escape (no behavior change for the common case)
 *   2. Two stacked modals: Escape closes only the top, a second Escape then
 *      closes the next one down
 *   3. Top modal with closeOnEscape={false}: Escape closes nothing (it
 *      swallows the key rather than letting it fall through to the ancestor)
 *   4. Unmounting the top modal restores Escape handling to the one below
 */
import '@testing-library/jest-dom';
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import { Modal } from './Modal';

function pressEscape() {
  fireEvent.keyDown(document, { key: 'Escape' });
}

describe('Modal — Escape key stack', () => {
  it('closes a single modal on Escape', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose}>
        <div>content</div>
      </Modal>,
    );

    pressEscape();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes only the top-most of two stacked modals, then the next on a second Escape', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();

    const { rerender } = render(
      <>
        <Modal isOpen onClose={onCloseOuter}>
          <div>outer</div>
        </Modal>
        <Modal isOpen onClose={onCloseInner}>
          <div>inner</div>
        </Modal>
      </>,
    );

    // First Escape: only the inner (top-most) modal should respond.
    pressEscape();
    expect(onCloseInner).toHaveBeenCalledTimes(1);
    expect(onCloseOuter).not.toHaveBeenCalled();

    // Simulate the inner modal actually closing (isOpen -> false), which is
    // what its onClose handler would normally drive in a real consumer.
    rerender(
      <>
        <Modal isOpen onClose={onCloseOuter}>
          <div>outer</div>
        </Modal>
        <Modal isOpen={false} onClose={onCloseInner}>
          <div>inner</div>
        </Modal>
      </>,
    );

    // Second Escape: now the outer modal is top-of-stack and should respond.
    pressEscape();
    expect(onCloseOuter).toHaveBeenCalledTimes(1);
    expect(onCloseInner).toHaveBeenCalledTimes(1); // unchanged from before
  });

  it('swallows Escape when the top-most modal has closeOnEscape={false}, blocking the ancestor too', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();

    render(
      <>
        <Modal isOpen onClose={onCloseOuter}>
          <div>outer</div>
        </Modal>
        <Modal isOpen onClose={onCloseInner} closeOnEscape={false}>
          <div>inner</div>
        </Modal>
      </>,
    );

    pressEscape();

    expect(onCloseInner).not.toHaveBeenCalled();
    expect(onCloseOuter).not.toHaveBeenCalled();
  });

  it('restores Escape to the modal below once the top one unmounts', () => {
    const onCloseOuter = vi.fn();
    const onCloseInner = vi.fn();

    const { rerender } = render(
      <>
        <Modal isOpen onClose={onCloseOuter}>
          <div>outer</div>
        </Modal>
        <Modal isOpen onClose={onCloseInner}>
          <div>inner</div>
        </Modal>
      </>,
    );

    // Unmount the inner (top) modal entirely, rather than just toggling isOpen.
    rerender(
      <>
        <Modal isOpen onClose={onCloseOuter}>
          <div>outer</div>
        </Modal>
      </>,
    );

    pressEscape();

    expect(onCloseOuter).toHaveBeenCalledTimes(1);
    expect(onCloseInner).not.toHaveBeenCalled();
  });
});
