import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Text } from './Text';
import { UnreadBadge } from './UnreadBadge';

const meta = {
  title: 'Components/UnreadBadge',
  component: UnreadBadge,
  args: { count: 3, accessibilityLabel: '3 oxunmamış mesaj' },
} satisfies Meta<typeof UnreadBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** One, many, past the ceiling — and zero, which renders nothing at all. */
export const Counts: Story = {
  render: () => (
    <View className="gap-3">
      {[1, 12, 250, 0].map((count) => (
        <View key={count} className="flex-row items-center gap-3">
          <Text variant="caption" tone="muted">
            {String(count)}
          </Text>
          <UnreadBadge count={count} accessibilityLabel={`${String(count)} oxunmamış mesaj`} />
        </View>
      ))}
    </View>
  ),
};
