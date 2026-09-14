import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Divider } from './Divider';
import { Text } from './Text';

const meta = {
  title: 'Components/Divider',
  component: Divider,
} satisfies Meta<typeof Divider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BetweenRows: Story = {
  render: () => (
    <View className="gap-4">
      <Text>Kateqoriya</Text>
      <Divider />
      <Text>Ünvan</Text>
      <Divider />
      <Text>Qiymət</Text>
    </View>
  ),
};
