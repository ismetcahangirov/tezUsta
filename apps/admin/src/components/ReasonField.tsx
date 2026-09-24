import { useId } from 'react';

/** The bounds every admin reason shares on the server: trimmed, 1–600 characters. */
export const REASON_MAX_LENGTH = 600;

export type ReasonProblem = 'empty' | 'tooLong';

/** Checks a reason the way the API's schema will, so the admin hears it before a 422. */
export function reasonProblem(value: string): ReasonProblem | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'empty';
  if (trimmed.length > REASON_MAX_LENGTH) return 'tooLong';
  return undefined;
}

export interface ReasonFieldProps {
  label: string;
  hint: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | undefined;
  disabled?: boolean;
}

/** A required multi-line reason, labelled, with a live character count. */
export function ReasonField({ label, hint, value, onChange, error, disabled }: ReasonFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const invalid = error !== undefined;

  return (
    <div className="flex w-full flex-col gap-2">
      <label htmlFor={id} className="text-caption text-text-muted">
        {label}
      </label>
      <textarea
        id={id}
        required
        rows={4}
        value={value}
        disabled={disabled}
        aria-invalid={invalid}
        aria-describedby={noteId}
        onChange={(event) => onChange(event.target.value)}
        className={`w-full resize-y rounded-sm border-hairline bg-surface px-4 py-3 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 ${invalid ? 'border-danger' : 'border-border'}`}
      />
      <div id={noteId} className="flex justify-between gap-4 text-footnote">
        <span className={invalid ? 'text-danger' : 'text-text-muted'}>{error ?? hint}</span>
        <span className="text-text-muted">
          {value.trim().length}/{REASON_MAX_LENGTH}
        </span>
      </div>
    </div>
  );
}
