import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { ReviewPrompt } from './ReviewPrompt';

const meta = {
  title: 'Reviews/ReviewPrompt',
  component: ReviewPrompt,
  args: { viewer: 'customer', onPress: () => undefined },
  decorators: [
    (Story) => (
      <View className="bg-bg p-4">
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof ReviewPrompt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** As the customer sees it on the order screen, and the master on the job screen and home. */
export const BothSides: Story = {
  render: () => (
    <View className="gap-4">
      <ReviewPrompt viewer="customer" onPress={() => undefined} />
      <ReviewPrompt viewer="master" onPress={() => undefined} />
    </View>
  ),
};
