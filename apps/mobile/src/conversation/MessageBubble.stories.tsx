import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { MessageBubble } from './MessageBubble';
import { TypingIndicator } from './TypingIndicator';

const meta = {
  title: 'Conversation/MessageBubble',
  component: MessageBubble,
  args: { body: 'Salam, yoldayam. On dəqiqəyə çatıram.', time: '10:15', mine: false },
} satisfies Meta<typeof MessageBubble>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/**
 * A conversation as a customer sees it, top to bottom, with every delivery
 * state of their own messages — the review CLAUDE.md §17 asks for before the
 * bubble reaches a route. Check it in both themes: "mine" inverts with the
 * theme through `inverse-surface`.
 */
export const AConversation: Story = {
  render: () => (
    <View className="gap-1 bg-bg p-4">
      <MessageBubble body="Salam, yoldayam." time="10:02" mine={false} />
      <MessageBubble
        body="Giriş arxa tərəfdədir, 3-cü mərtəbə."
        time="10:03"
        mine
        delivery="read"
      />
      <MessageBubble body="Aydındır." time="10:04" mine={false} />
      <MessageBubble body="Su kranını bağlamışam." time="10:06" mine delivery="sent" />
      <MessageBubble body="Domofon işləmir, zəng edin." time="10:07" mine delivery="sending" />
      <MessageBubble
        body="Qapı açıqdır."
        time="10:08"
        mine
        delivery="failed"
        onRetry={() => undefined}
      />
      <TypingIndicator label="Usta yazır…" />
    </View>
  ),
};

/** A long message still keeps to its own side of the screen. */
export const ALongMessage: Story = {
  args: {
    mine: true,
    delivery: 'sent',
    body:
      'Mətbəxdə kranın altından su sızır, şkafın içi islanıb. Kranı bağlayanda da damcılayır, ' +
      'altına qab qoymuşam. Gələndə domofon işləmirsə zəng edin, aşağı düşüb açaram.',
  },
};
