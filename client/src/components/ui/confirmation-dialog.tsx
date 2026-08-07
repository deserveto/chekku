'use client';

import { useEffect, useId, useRef, type RefObject } from 'react';

interface ConfirmationDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  pending?: boolean;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmationDialog({
  open,
  title,
  description,
  confirmLabel = 'Delete',
  pending = false,
  fallbackFocusRef,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!wasOpenRef.current) {
        restoreFocusRef.current =
          document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
      }
      if (!dialog.open) dialog.showModal();
      cancelRef.current?.focus();
      wasOpenRef.current = true;
      return;
    }

    if (dialog.open) dialog.close();
    if (wasOpenRef.current) {
      const invoker = restoreFocusRef.current;
      const target = invoker?.isConnected ? invoker : fallbackFocusRef?.current;
      target?.focus();
    }
    wasOpenRef.current = false;
  }, [fallbackFocusRef, open]);

  useEffect(() => () => {
    const dialog = dialogRef.current;
    if (dialog?.open) dialog.close();
    if (wasOpenRef.current) {
      const invoker = restoreFocusRef.current;
      const target = invoker?.isConnected ? invoker : fallbackFocusRef?.current;
      target?.focus();
    }
    wasOpenRef.current = false;
  }, [fallbackFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      className="studio-confirmation-dialog"
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div className="studio-confirmation-panel">
        <div className="studio-confirmation-mark" aria-hidden="true">!</div>
        <div className="studio-confirmation-copy">
          <p className="studio-eyebrow">Confirm action</p>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </div>
        <div className="studio-confirmation-actions">
          <button
            ref={cancelRef}
            className="studio-button"
            type="button"
            disabled={pending}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="studio-button studio-button-danger"
            type="button"
            disabled={pending}
            onClick={onConfirm}
          >
            {pending ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  );
}
