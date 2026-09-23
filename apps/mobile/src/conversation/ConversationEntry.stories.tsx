import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { ConversationEntry } from './ConversationEntry';

const meta = {
  title: 'Conversation/ConversationEntry',
  component: ConversationEntry,
  args: { viewer: 'customer', unreadCount: 2, writable: true, onPress: () => undefined },
  decorators: [
    (Story) => (
      <View className="bg-bg p-4">
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ConversationEntry>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** The three states it is seen in on the order and job screens. */
export const States: Story = {
  render: () => (
    <View className="gap-4">
      <ConversationEntry viewer="customer" unreadCount={2} writable onPress={() => undefined} />
      <ConversationEntry viewer="master" unreadCount={0} writable onPress={() => undefined} />
      <ConversationEntry
        viewer="customer"
        unreadCount={0}
        writable={false}
        onPress={() => undefined}
      />
    </View>
  ),
};
