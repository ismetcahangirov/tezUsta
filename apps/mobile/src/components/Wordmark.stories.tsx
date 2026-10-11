import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Wordmark } from './Wordmark';

const meta = {
  title: 'Components/Wordmark',
  component: Wordmark,
  args: { width: 200, tone: 'accent' },
  argTypes: { tone: { control: 'select', options: ['accent', 'on-accent'] } },
} satisfies Meta<typeof Wordmark>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const OnTheBrandFill: Story = {
  render: () => (
    <View className="items-center justify-center rounded-md bg-accent p-8">
      <Wordmark tone="on-accent" width={240} />
    </View>
  ),
};
