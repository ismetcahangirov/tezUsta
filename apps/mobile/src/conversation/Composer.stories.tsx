import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Banner } from '../components';
import { Composer } from './Composer';
import { CONVERSATION_COPY as copy } from './conversation-copy';

const meta = {
  title: 'Conversation/Composer',
  component: Composer,
  args: { onSend: () => undefined },
  decorators: [
    (Story) => (
      <View className="bg-bg p-4">
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof Composer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Type into it: send stays disabled until there is something to send. */
export const Playground: Story = {};

/**
 * What stands where the composer was once the order is over. The composer is
 * absent rather than disabled (ADR-0033 § 2); this is the line that says why.
 */
export const ClosedConversation: Story = {
  render: () => <Banner message={copy.closedNotice} />,
};
