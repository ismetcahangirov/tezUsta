import { View } from 'react-native';

import { cn } from '../lib/cn';
import { Badge } from './Badge';

/** Above this the badge reads "99+": a count past it tells nobody anything more. */
export const UNREAD_BADGE_CEILING = 99;

export interface UnreadBadgeProps {
  /** How many are unread. Zero or less renders nothing. */
  count: number;
  /**
   * What a screen reader says for it — "3 oxunmamış mesaj" — because a bare
   * "3" out of context says nothing. Required, like `IconButton`'s label.
   */
  accessibilityLabel: string;
  className?: string | undefined;
}

/**
 * A count of unread things, as a lime pill ([ADR-0037](../../../../docs/decisions/ADR-0037-conversation-screen.md)).
 *
 * **The accent `Badge`, not a new shape.** Lime is a fill with `on-accent`
 * type on it, which is the accent rule (`design-system.md` § 3), and the pill
 * is the one the design system already has. What this adds is behaviour only:
 * nothing at zero, a ceiling, and a spoken label.
 *
 * **Absent at zero rather than showing "0".** A badge is the thing that is
 * different when there is something to read; one that is always there stops
 * being noticed.
 */
export function UnreadBadge({
  count,
  accessibilityLabel,
  className,
}: UnreadBadgeProps): React.JSX.Element | null {
  if (count <= 0) {
    return null;
  }

  const label = count > UNREAD_BADGE_CEILING ? `${String(UNREAD_BADGE_CEILING)}+` : String(count);

  return (
    <View accessible accessibilityLabel={accessibilityLabel} className={cn(className)}>
      <Badge label={label} tone="accent" />
    </View>
  );
}
