import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Avatar } from './Avatar';

const meta = {
  title: 'Components/Avatar',
  component: Avatar,
  args: { name: 'Elvin Məmmədov', size: 'md' },
  argTypes: { size: { control: 'select', options: ['sm', 'md', 'lg'] } },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Sizes: Story = {
  render: () => (
    <View className="flex-row items-center gap-4">
      <Avatar name="Elvin Məmmədov" size="sm" />
      <Avatar name="Elvin Məmmədov" size="md" />
      <Avatar name="ismət cahangirov" size="lg" />
    </View>
  ),
};
