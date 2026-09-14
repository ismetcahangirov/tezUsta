import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { ProgressBar } from './ProgressBar';
import { Text } from './Text';

const meta = {
  title: 'Components/ProgressBar',
  component: ProgressBar,
  args: { accessibilityLabel: 'Sənədlər', value: 1, max: 3 },
} satisfies Meta<typeof ProgressBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Steps: Story = {
  render: () => (
    <View className="gap-4">
      <Text variant="caption" tone="muted">
        Square ends on purpose — the one shape in the system that is a measurement.
      </Text>
      {[0, 1, 2, 3].map((value) => (
        <ProgressBar key={value} accessibilityLabel={`${value} of 3`} value={value} max={3} />
      ))}
    </View>
  ),
};
