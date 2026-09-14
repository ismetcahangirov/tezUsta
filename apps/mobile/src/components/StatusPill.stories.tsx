import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { StatusPill } from './StatusPill';
import { Text } from './Text';

const meta = {
  title: 'Components/StatusPill',
  component: StatusPill,
  args: { status: 'active', label: 'Yolda' },
} satisfies Meta<typeof StatusPill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const OrderStates: Story = {
  render: () => (
    <View className="gap-3">
      <Text tone="muted">
        The label carries the meaning. Colour narrows it down; it never replaces it.
      </Text>
      <View className="flex-row flex-wrap gap-2">
        <StatusPill status="pending" label="Usta axtarılır" />
        <StatusPill status="active" label="Yolda" />
        <StatusPill status="done" label="Tamamlandı" />
        <StatusPill status="cancelled" label="Ləğv edildi" />
      </View>
    </View>
  ),
};
