import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-inverse-surface text-on-inverse',
  accent: 'bg-accent text-on-accent',
  secondary: 'border-hairline border-border bg-surface text-text',
  ghost: 'bg-transparent text-text',
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  variant?: ButtonVariant;
  /** Shown instead of `label` while the action runs; the button is disabled meanwhile. */
  loadingLabel?: string;
  loading?: boolean;
}

/**
 * The design system's pill button (ADR-0011), as a DOM `<button>`: shape
 * constant, only the fill changes — the same variants as apps/mobile's.
 */
export function Button({
  label,
  variant = 'primary',
  loadingLabel,
  loading = false,
  disabled = false,
  type = 'button',
  className = '',
  ...rest
}: ButtonProps) {
  const inactive = disabled || loading;
  return (
    <button
      type={type}
      disabled={inactive}
      aria-busy={loading || undefined}
      className={`inline-flex h-control-sm items-center justify-center gap-2 rounded-full px-5 text-body-strong font-bold outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 enabled:hover:opacity-80 ${VARIANT_CLASS[variant]} ${className}`}
      {...rest}
    >
      {loading && loadingLabel !== undefined ? loadingLabel : label}
    </button>
  );
}
