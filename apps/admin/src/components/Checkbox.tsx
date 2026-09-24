import type { InputHTMLAttributes } from 'react';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'className'
> {
  label: string;
}

/** A native checkbox with its label as its accessible name. */
export function Checkbox({ label, ...rest }: CheckboxProps) {
  return (
    <label className="flex items-center gap-2 text-body text-text">
      <input
        type="checkbox"
        className="accent-inverse-surface outline-none focus-visible:ring-2 focus-visible:ring-focus"
        {...rest}
      />
      {label}
    </label>
  );
}
