import { type ReactNode, useEffect, useId, useRef } from 'react';

export interface DialogProps {
  title: string;
  /** Called on Escape and by whatever close control the dialog's content offers. */
  onClose: () => void;
  children: ReactNode;
}

/**
 * A modal over the page: a scrim in the `overlay` token and a `surface`
 * panel. Rendered only while open — closing it unmounts its content, which is
 * what lets a dialog own something that must not outlive it (a setup link is
 * shown once and lives only in the dialog that shows it, ADR-0043 § 3).
 *
 * Focus moves into the panel on open and back to whatever held it on close.
 */
export function Dialog({ title, onClose, children }: DialogProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.current?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
    );
    (first ?? panel.current)?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-overlay/50 p-8">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="flex max-h-full w-full max-w-xl flex-col gap-4 overflow-y-auto rounded-md bg-surface p-6 text-text outline-none"
      >
        <h2 id={titleId} className="text-h2 font-bold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
