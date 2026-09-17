import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Skeleton } from './Skeleton';

const meta = {
  title: 'Components/Skeleton',
  component: Skeleton,
  args: { className: 'h-control-md w-full' },
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const ListPlaceholder: Story = {
  render: () => (
    <View className="gap-4">
      {[0, 1, 2, 3].map((row) => (
        <View key={row} className="gap-2">
          <Skeleton className="h-control-sm w-1/2" />
          <Skeleton className="h-control-sm w-1/3" />
        </View>
      ))}
    </View>
  ),
};
