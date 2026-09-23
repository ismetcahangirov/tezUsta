import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { CONVERSATION_COPY as copy } from './conversation-copy';
import { TypingIndicator } from './TypingIndicator';

const meta = {
  title: 'Conversation/TypingIndicator',
  component: TypingIndicator,
  args: { label: copy.typing.master },
  decorators: [
    (Story) => (
      <View className="bg-bg p-4">
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof TypingIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** What the master sees while the customer types. */
export const TheCustomerIsTyping: Story = { args: { label: copy.typing.customer } };
