import type { ReactNode } from 'react';
import { View } from 'react-native';

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
 */
export function Banner({
  message,
  tone = 'neutral',
  action,
  className,
}: BannerProps): React.JSX.Element {
  return (
    <View
      className={cn(
        'flex-row items-center justify-between gap-3 rounded-md px-4 py-3',
        CONTAINER_CLASS[tone],
        className,
      )}
    >
      {/*
        The role sits on the message, not on the container. A container marked
        `accessible` would collapse the banner and its action button into one
        node, and the button would stop being reachable on its own — which is
        the opposite of what announcing the banner is for.
      */}
      <Text
        accessibilityRole="alert"
        variant="caption"
        tone={MESSAGE_TONE[tone]}
        className="flex-1"
      >
        {message}
      </Text>
      {action}
    </View>
  );
}
