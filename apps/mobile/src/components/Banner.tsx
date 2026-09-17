import { useEffect, type ReactNode } from 'react';
import { AccessibilityInfo, View } from 'react-native';

import { cn } from '../lib/cn';
import { Text, type TextTone } from './Text';

export type BannerTone = 'neutral' | 'danger';

const CONTAINER_CLASS: Record<BannerTone, string> = {
  neutral: 'bg-surface-alt',
  danger: 'bg-danger',
};

const MESSAGE_TONE: Record<BannerTone, TextTone> = {
  neutral: 'default',
  danger: 'on-danger',
};

export interface BannerProps {
  message: string;
  tone?: BannerTone;
  /** Typically a small `Button` — "try again". */
  action?: ReactNode;
  className?: string;
}

/**
 * A full-width strip that says something about the screen as a whole rather
 * than about one row: "showing a saved copy", "could not refresh".
 *
 * Distinct from `Badge`, which labels a thing, and from `EmptyState`, which
 * replaces content. A banner sits *above* content that is still worth looking
 * at — which is exactly the offline case, where the list is stale but useful
 * and hiding it would be worse than showing it with a caveat.
 *
 * **`accessibilityRole="alert"` on its own announces nothing.** Verified
 * against the installed `react-native@0.86.3`: `React/Views/RCTView.m` maps
 * `@"alert"` to `UIAccessibilityTraitNone`, so on iOS the role contributes
 * nothing at all, and on neither platform does a component merely *appearing*
 * trigger a screen-reader announcement — a role only describes a node once
 * something has already decided to focus or read it. So this component
 * additionally:
 *   - sets `accessibilityLiveRegion="polite"` on the container, which is the
 *     Android/TalkBack mechanism for "read this when its content changes";
 *   - calls `AccessibilityInfo.announceForAccessibility(message)` in an
 *     effect, which is the iOS/VoiceOver mechanism, since VoiceOver has no
 *     live-region concept.
 * The effect is keyed on `message` so it fires once on mount and again only
 * when the text actually changes — not on every unrelated re-render, which
 * would otherwise spam VoiceOver on each parent render.
 */
export function Banner({
  message,
  tone = 'neutral',
  action,
  className,
}: BannerProps): React.JSX.Element {
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(message);
  }, [message]);

  return (
    <View
      accessibilityLiveRegion="polite"
      className={cn(
        'flex-row items-center justify-between gap-3 rounded-md px-4 py-3',
        CONTAINER_CLASS[tone],
        className,
      )}
    >
      <Text variant="caption" tone={MESSAGE_TONE[tone]} className="flex-1">
        {message}
      </Text>
      {action}
    </View>
  );
}
