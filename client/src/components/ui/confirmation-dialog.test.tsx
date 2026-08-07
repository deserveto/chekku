// @vitest-environment jsdom
import { act, createRef, StrictMode, type RefObject } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmationDialog } from './confirmation-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

function renderDialog(
  open: boolean,
  options: {
    pending?: boolean;
    onCancel?: () => void;
    onConfirm?: () => void;
    fallbackFocusRef?: RefObject<HTMLElement | null>;
    strictMode?: boolean;
  } = {},
) {
  act(() => {
    const dialog = (
      <ConfirmationDialog
        open={open}
        title="Delete this thread?"
        description="This permanently removes the conversation."
        pending={options.pending}
        onCancel={options.onCancel ?? vi.fn()}
        onConfirm={options.onConfirm ?? vi.fn()}
        fallbackFocusRef={options.fallbackFocusRef}
      />
    );
    root!.render(options.strictMode ? <StrictMode>{dialog}</StrictMode> : dialog);
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);

  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('ConfirmationDialog', () => {
  it('opens as a labelled alert dialog and confirms the action', () => {
    const onConfirm = vi.fn();
    renderDialog(true, { onConfirm });

    const dialog = container.querySelector('dialog')!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();

    const deleteButton = Array.from(dialog.querySelectorAll('button'))
      .find((button) => button.textContent === 'Delete')!;
    act(() => deleteButton.click());
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('cancels from Escape or the backdrop and restores invoker focus', () => {
    const onCancel = vi.fn();
    const trigger = document.createElement('button');
    document.body.insertBefore(trigger, container);
    trigger.focus();
    renderDialog(true, { onCancel });

    const dialog = container.querySelector('dialog')!;
    act(() => dialog.dispatchEvent(new Event('cancel', { cancelable: true })));
    expect(onCancel).toHaveBeenCalledOnce();

    act(() => dialog.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onCancel).toHaveBeenCalledTimes(2);

    renderDialog(false, { onCancel });
    expect(document.activeElement).toBe(trigger);
  });

  it('locks both actions while confirmation is pending', () => {
    renderDialog(true, { pending: true });

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons).toHaveLength(2);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(container.textContent).toContain('Deleting…');
  });

  it('preserves the original invoker through Strict Mode effect replay', () => {
    const trigger = document.createElement('button');
    document.body.insertBefore(trigger, container);
    trigger.focus();

    renderDialog(true, { strictMode: true });
    renderDialog(false, { strictMode: true });

    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to a surviving fallback when the invoker was removed', () => {
    const fallback = document.createElement('button');
    const trigger = document.createElement('button');
    document.body.insertBefore(fallback, container);
    document.body.insertBefore(trigger, container);
    const fallbackFocusRef = createRef<HTMLElement>();
    fallbackFocusRef.current = fallback;
    trigger.focus();

    renderDialog(true, { fallbackFocusRef });
    trigger.remove();
    renderDialog(false, { fallbackFocusRef });

    expect(document.activeElement).toBe(fallback);
  });
});
