import { type SelectHTMLAttributes, useId } from 'react';

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'className' | 'children'
> {
  label: string;
  options: readonly SelectOption[];
  hint?: string;
  error?: string | undefined;
  className?: string;
}

/** A labelled native `<select>`, shaped like `TextField`. */
export function SelectField({
  label,
  options,
  hint,
  error,
  className = '',
  ...rest
}: SelectFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  const invalid = error !== undefined;

  return (
    <div className={`flex w-full flex-col gap-2 ${className}`}>
      <label htmlFor={id} className="text-caption text-text-muted">
        {label}
      </label>
      <select
        id={id}
        aria-invalid={invalid}
        aria-describedby={note === undefined ? undefined : noteId}
        className={`h-control-md w-full rounded-full border-hairline bg-surface px-5 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 ${invalid ? 'border-danger' : 'border-border'}`}
        {...rest}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {note !== undefined && (
        <p id={noteId} className={`text-footnote ${invalid ? 'text-danger' : 'text-text-muted'}`}>
          {note}
        </p>
      )}
    </div>
  );
}
