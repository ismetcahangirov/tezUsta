import type { MessageSenderKind } from '@tezusta/types';
import { View } from 'react-native';

import { Card, ChevronRightIcon, ListRow, UnreadBadge } from '../components';
import { CONVERSATION_COPY as copy } from './conversation-copy';

export interface ConversationEntryProps {
  /** Whose screen this is — the subtitle names the *other* party. */
  readonly viewer: MessageSenderKind;
  readonly unreadCount: number;
  /** False once the order is over: the entry says the transcript is read-only. */
  readonly writable: boolean;
  readonly onPress: () => void;
}

/**
 * The way into an order's conversation, on the order screen and on the
 * master's job screen ([ADR-0037](../../../../docs/decisions/ADR-0037-conversation-screen.md)).
 *
 * **A card row with the unread badge on it, under the order's own status.**
 * The count belongs on the order, not on a tab (ADR-0033 § 6), and this is the
 * one place on the order that is *about* the conversation — so the badge sits
 * on the control that clears it. The row reuses `ListRow` in a `Card`, the
 * pattern the order screen's other sections already use, rather than adding a
 * button shape.
 */
export function ConversationEntry({
  viewer,
  unreadCount,
  writable,
  onPress,
}: ConversationEntryProps): React.JSX.Element {
  return (
    <Card className="py-0">
      <ListRow
        title={copy.entry.title}
        subtitle={writable ? copy.entry.open[viewer] : copy.entry.closed}
        onPress={onPress}
        accessibilityLabel={
          unreadCount > 0 ? `${copy.entry.title}, ${copy.unread(unreadCount)}` : copy.entry.title
        }
        trailing={
          <View className="flex-row items-center gap-2">
            <UnreadBadge count={unreadCount} accessibilityLabel={copy.unread(unreadCount)} />
            <ChevronRightIcon tone="text-muted" />
          </View>
        }
      />
    </Card>
  );
}
