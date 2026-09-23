import { View } from 'react-native';

import { Text } from '../components';

export interface TypingIndicatorProps {
  /** "Usta yazır…" — who is typing, by their role on the order. */
  readonly label: string;
}

/**
 * "The other party is typing" ([ADR-0037](../../../../docs/decisions/ADR-0037-conversation-screen.md)).
 *
 * **Shaped like their next message and standing where it will appear**: the
 * other party's bubble surface, on their side, under the newest message. It
 * is a caption rather than three animated dots because motion is not settled
 * (CLAUDE.md §17) and because a caption says *who*, which dots do not.
 *
 * A polite live region, so a screen reader announces it once without
 * interrupting what it is reading.
 */
export function TypingIndicator({ label }: TypingIndicatorProps): React.JSX.Element {
  return (
    <View className="items-start py-1 pr-12" accessibilityLiveRegion="polite">
      <View className="rounded-md bg-surface px-4 py-3">
        <Text variant="caption" tone="muted">
          {label}
        </Text>
      </View>
    </View>
  );
}
