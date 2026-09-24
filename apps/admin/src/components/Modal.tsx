import { type ReactNode, useEffect, useId, useRef } from 'react';

export interface ModalProps {
  title: string;
  /** Called on Escape and by the dialog's own cancel control. */
  onClose: () => void;
  /** While true, Escape does nothing — a request is in flight. */
  busy?: boolean;
  children: ReactNode;
}

/**
 * A modal dialog over the page: an `overlay` scrim and a `surface` panel.
 *
 * A `div` with `role="dialog"` rather than `<dialog>.showModal()`, because
 * jsdom does not implement `showModal` and the panel's tests render the real
 * component. Focus moves into the dialog when it opens — to the first field,
 * else the first button — and Escape closes it unless a request is running.
 */
export function Modal({ title, onClose, busy = false, children }: ModalProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first =
      panel.current?.querySelector<HTMLElement>('textarea, input, select') ??
      panel.current?.querySelector<HTMLElement>('button:not([disabled])');
    first?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-overlay/50 p-6">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-full w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-md bg-surface p-6 text-text"
      >
        <h2 id={titleId} className="text-h2 font-bold text-text">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
