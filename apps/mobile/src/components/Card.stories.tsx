import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Card } from './Card';
import { StatusPill } from './StatusPill';
import { Text } from './Text';

const meta = {
  title: 'Components/Card',
  component: Card,
} satisfies Meta<typeof Card>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Surfaces: Story = {
  render: () => (
    <View className="gap-4">
      <Card>
        <Text variant="body-strong">surface</Text>
        <Text tone="muted">The default container.</Text>
      </Card>
      <Card surface="alt">
        <Text variant="body-strong">alt</Text>
        <Text tone="muted">A quieter block inside a page.</Text>
      </Card>
      <Card surface="inverse">
        <Text variant="body-strong" tone="on-inverse">
          inverse
        </Text>
        <Text tone="on-inverse">Used deliberately, not decoratively.</Text>
      </Card>
    </View>
  ),
};

export const OrderSummary: Story = {
  render: () => (
    <Card>
      <View className="gap-3">
        <View className="flex-row items-center justify-between">
          <Text variant="body-strong">Kran sızır</Text>
          <StatusPill status="active" label="Yolda" />
        </View>
        <Text tone="muted">Nizami rayonu · 25 AZN</Text>
      </View>
    </Card>
  ),
};
