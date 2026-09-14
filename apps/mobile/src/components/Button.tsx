import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, type PressableProps } from 'react-native';

import { cn } from '../lib/cn';
import { useTheme } from '../theme';
import { Text, type TextTone } from './Text';

export type ButtonVariant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

const CONTAINER_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-inverse-surface',
  accent: 'bg-accent',
  secondary: 'bg-surface border-hairline border-border',
  ghost: 'bg-transparent',
  danger: 'bg-danger',
};

const LABEL_TONE: Record<ButtonVariant, TextTone> = {
  primary: 'on-inverse',
  accent: 'on-accent',
  secondary: 'default',
  ghost: 'default',
  danger: 'on-danger',
};

/** Which colour role the spinner and any icon should take. */
const CONTENT_ROLE = {
  primary: 'on-inverse',
  accent: 'on-accent',
  secondary: 'text',
  ghost: 'text',
  danger: 'on-danger',
} as const;

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'h-control-sm px-4',
  md: 'h-control-md px-5',
  lg: 'h-control-lg px-6',
};

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Rendered before the label, as in the reference's "Continue to probe". */
  icon?: ReactNode;
  loading?: boolean;
  fullWidth?: boolean;
  className?: string;
}

/**
 * The pill button of the design system. Shape is constant — only the fill
 * changes — which is what makes a screenful of them read as one family.
 */
export function Button({
  label,
  variant = 'primary',
  size = 'md',
  icon,
  loading = false,
  fullWidth = false,
  disabled = false,
  className,
  ...rest
}: ButtonProps): React.JSX.Element {
  const { colors } = useTheme();
  const inactive = disabled || loading;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      className={cn(
        'flex-row items-center justify-center gap-2 rounded-full',
        CONTAINER_CLASS[variant],
        SIZE_CLASS[size],
        fullWidth && 'w-full',
        inactive && 'opacity-40',
        !inactive && 'active:opacity-80',
        className,
      )}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator accessibilityElementsHidden color={colors[CONTENT_ROLE[variant]]} />
      ) : (
        icon
      )}
      <Text variant="body-strong" tone={LABEL_TONE[variant]}>
        {label}
      </Text>
    </Pressable>
  );
}
