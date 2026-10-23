import { type InputHTMLAttributes, useId } from 'react';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'className'> {
  label: string;
  /** Shown under the field and wired to it as its description. */
  hint?: string;
  /** Shown under the field, marks it invalid, and replaces the hint. */
  error?: string | undefined;
  className?: string;
}

/** The design system's pill input (ADR-0011), labelled for assistive technology. */
export function TextField({ label, hint, error, className = '', ...rest }: TextFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  const invalid = error !== undefined;

  return (
    <div className={`flex w-full flex-col gap-2 ${className}`}>
      <label htmlFor={id} className="text-caption text-text-muted">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={invalid}
        aria-describedby={note === undefined ? undefined : noteId}
        className={`h-control-md w-full rounded-full border-hairline bg-surface px-5 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 ${invalid ? 'border-danger' : 'border-border'}`}
        {...rest}
      />
      {note !== undefined && (
        <p id={noteId} className={`text-footnote ${invalid ? 'text-danger' : 'text-text-muted'}`}>
          {note}
        </p>
      )}
    </div>
  );
}
