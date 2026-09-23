import { View } from 'react-native';

import { Button, Text } from '../components';
import { cn } from '../lib/cn';
import { CONVERSATION_COPY as copy } from './conversation-copy';

/**
 * Where one of the user's own messages is on its way.
 *
 * `sent` and `read` are the server's facts — the message has an id, and the
 * other party has or has not read it. `sending` and `failed` belong to the
 * outbox: the server has not acknowledged them.
 */
export type DeliveryState = 'sending' | 'sent' | 'read' | 'failed';

export interface MessageBubbleProps {
  readonly body: string;
  /** Already formatted for display — the bubble does not know the locale. */
  readonly time: string;
  /** The user's own message, or the other party's. */
  readonly mine: boolean;
  /** Only for the user's own messages; ignored on the other party's. */
  readonly delivery?: DeliveryState | undefined;
  /** Offered on a failed message, when sending again can still succeed. */
  readonly onRetry?: (() => void) | undefined;
}

/**
 * One message ([ADR-0037](../../../../docs/decisions/ADR-0037-conversation-screen.md)).
 *
 * **Side and surface carry who wrote it; nothing else does.** The user's own
 * messages sit on the right on `inverse-surface` — the black pill of the
 * primary button, so "mine" reads as the same ink as "my action" — and the
 * other party's on the left on `surface`, the card colour. Both invert with the
 * theme through their tokens, and neither is lime: accent is a fill for a
 * *call to action* (`design-system.md` § 3), and a wall of lime bubbles would
 * turn the loudest colour in the system into background.
 *
 * **The side is enforced by a gutter, not a percentage width.** A `pl-12` or
 * `pr-12` on the row keeps a bubble from reaching the far edge using the
 * spacing scale, where a `max-w-[80%]` would be a value no token defines.
 *
 * **Delivery state is words, not ticks.** "Göndərildi" and "Oxundu" say what
 * two grey check marks make a user learn, are read aloud as they are, and need
 * no icon the set does not have — the same "the label carries the meaning"
 * rule the status pill follows (`design-system.md` § 4). A failure is said in
 * the danger tone *outside* the bubble, on the page, because red on the inverse
 * surface does not meet contrast in the light theme.
 */
export function MessageBubble({
  body,
  time,
  mine,
  delivery,
  onRetry,
}: MessageBubbleProps): React.JSX.Element {
  const failed = mine && delivery === 'failed';
  const status = mine && delivery !== undefined && !failed ? copy.delivery[delivery] : null;

  return (
    <View className={cn('gap-1 py-1', mine ? 'items-end pl-12' : 'items-start pr-12')}>
      <View
        className={cn('gap-1 rounded-md px-4 py-3', mine ? 'bg-inverse-surface' : 'bg-surface')}
      >
        <Text variant="body" tone={mine ? 'on-inverse' : 'default'}>
          {body}
        </Text>
        <Text variant="footnote" tone={mine ? 'on-inverse' : 'muted'}>
          {status === null ? time : `${time} · ${status}`}
        </Text>
      </View>

      {failed && (
        <View className="flex-row items-center gap-2">
          <Text variant="footnote" tone="danger">
            {copy.delivery.failed}
          </Text>
          {onRetry !== undefined && (
            <Button label={copy.resend} variant="ghost" size="sm" onPress={onRetry} />
          )}
        </View>
      )}
    </View>
  );
}
