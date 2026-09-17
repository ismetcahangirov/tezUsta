import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { Banner } from './Banner';
import { Button } from './Button';

const meta = {
  title: 'Components/Banner',
  component: Banner,
  args: { message: 'Saxlanmış siyahı göstərilir', tone: 'neutral' },
  argTypes: { tone: { control: 'select', options: ['neutral', 'danger'] } },
} satisfies Meta<typeof Banner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Tones: Story = {
  render: () => (
    <View className="gap-3">
      <Banner message="Saxlanmış siyahı göstərilir" />
      <Banner
        message="Kataloq yenilənmədi"
        tone="danger"
        action={<Button label="Yenidən" size="sm" variant="ghost" onPress={() => undefined} />}
      />
    </View>
  ),
};
