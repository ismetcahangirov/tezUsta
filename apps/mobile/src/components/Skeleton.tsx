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
 *
 * **Accessibility is conditional on `accessibilityLabel`, not unconditional.**
 * Two bugs otherwise follow a bare `accessibilityRole="progressbar"`:
 *   - A caller rendering several placeholders (a list of four rows, say)
 *     produces four indeterminate, unnamed progress bars in a row — a worse
 *     VoiceOver/TalkBack reading than the one labelled loading region the
 *     caller actually wants. So without a label, the block gets
 *     `accessibilityElementsHidden` and `importantForAccessibility=
 *     "no-hide-descendants"`: skipped entirely rather than read as noise.
 *   - Even the labelled case was broken: verified against the installed
 *     `react-native@0.86.3` in
 *     `React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm`,
 *     `isAccessibilityElement = newViewProps.accessible` — a container that
 *     sets only `accessibilityLabel` with no explicit `accessible` is not an
 *     accessibility element on iOS at all, so VoiceOver skips over it and the
 *     label is never read. A caller who supplies a label meant the node to be
 *     read, so that case now sets `accessible` and a role explicitly.
 */
export function Skeleton({ className, accessibilityLabel }: SkeletonProps): React.JSX.Element {
  if (accessibilityLabel === undefined) {
    return (
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        className={cn('rounded-sm bg-track', className)}
      />
    );
  }

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      className={cn('rounded-sm bg-track', className)}
    />
  );
}
