import type { ReactNode } from 'react';
import { Pressable, type PressableProps } from 'react-native';

import { cn } from '../lib/cn';

export type IconButtonVariant =
  'primary' | 'surface' | 'on-inverse' | 'inverse-outline' | 'accent' | 'ghost' | 'danger';

const CONTAINER_CLASS: Record<IconButtonVariant, string> = {
  primary: 'bg-inverse-surface',
  surface: 'bg-surface',
  // The two states of a toggle on the inverse call surface (ADR-0041 § 2):
  // on is filled with the type colour; off is no fill and a hairline ring of
  // it. Fill *and* outline differ, so the state survives any one of them
  // being hard to see — and `selected` says it to a screen reader.
  'on-inverse': 'bg-on-inverse',
  'inverse-outline': 'bg-transparent border-hairline border-on-inverse',
  accent: 'bg-accent',
  ghost: 'bg-transparent',
  danger: 'bg-danger',
};

export interface IconButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  /** Required: an icon-only control is invisible to a screen reader without it. */
  accessibilityLabel: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  /**
   * For a toggle: whether it is on. Announced as the control's selected state,
   * so a toggle never reports itself through its fill alone. Omitted for an
   * ordinary button, which then has no selected state at all.
   */
  selected?: boolean;
  className?: string;
}

/**
 * The circular control the reference uses for back, forward, and map actions.
 * Always `icon-button` wide, which is also the minimum comfortable tap target.
 */
export function IconButton({
  accessibilityLabel,
  icon,
  variant = 'primary',
  selected,
  disabled = false,
  className,
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={
        selected === undefined
          ? { disabled: disabled === true }
          : { disabled: disabled === true, selected }
      }
      disabled={disabled}
      className={cn(
        'h-icon-button w-icon-button items-center justify-center rounded-full',
        CONTAINER_CLASS[variant],
        disabled === true ? 'opacity-40' : 'active:opacity-80',
        className,
      )}
      {...rest}
    >
      {icon}
    </Pressable>
  );
}
