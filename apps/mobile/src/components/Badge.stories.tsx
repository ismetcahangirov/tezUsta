import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Badge } from './Badge';

const meta = {
  title: 'Components/Badge',
  component: Badge,
  args: { label: 'Təcili', tone: 'accent' },
  argTypes: { tone: { control: 'select', options: ['accent', 'neutral', 'danger', 'inverse'] } },
} satisfies Meta<typeof Badge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Tones: Story = {
  render: () => (
    <View className="flex-row flex-wrap gap-2">
      <Badge label="Təcili" tone="accent" />
      <Badge label="Adi" tone="neutral" />
      <Badge label="Ləğv" tone="danger" />
      <Badge label="Yeni" tone="inverse" />
    </View>
  ),
};
