import { View } from 'react-native';

import { cn } from '../lib/cn';

export interface SkeletonProps {
  /** Height token — matches the `size` scale in design-tokens.json. */
  className?: string;
  /** Read by a screen reader instead of the silence a bare box would give. */
  accessibilityLabel?: string;
}

/**
 * A placeholder block for content that has been asked for and not yet arrived.
 *
 * **It does not animate.** Motion — durations and easing — is still the
 * owner's to decide (`docs/design/design-system.md` §9), and a shimmer picked
 * here would be a motion language invented by whoever wrote this file. A
 * static block is honest about the same thing: something belongs here and is
 * not here yet.
 *
 * Uses `bg-track`, the token for an unfilled bar, because that is what this
 * is: the unfilled version of a row.
 */
export function Skeleton({ className, accessibilityLabel }: SkeletonProps): React.JSX.Element {
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      className={cn('rounded-sm bg-track', className)}
    />
  );
}
