import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { useState } from 'react';
import { View } from 'react-native';

import { StarRating } from './StarRating';
import { Text } from './Text';

const starLabel = (star: number): string => `${String(star)} ulduz`;

const meta = {
  title: 'Components/StarRating',
  component: StarRating,
  args: { value: 4, label: 'Qiymət', starLabel, onChange: () => undefined },
  decorators: [
    (Story) => (
      <View className="bg-bg p-4">
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof StarRating>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

function Interactive(): React.JSX.Element {
  const [value, setValue] = useState<number | null>(null);
  return (
    <View className="gap-2">
      <StarRating value={value} label="Qiymət" starLabel={starLabel} onChange={setValue} />
      <Text variant="caption" tone="muted">
        {value === null ? 'Seçilməyib' : `${String(value)} / 5`}
      </Text>
    </View>
  );
}

/** Tap a star: the input as the review screen uses it. */
export const Input: Story = { render: () => <Interactive /> };

/** Every state the review screen and the received-reviews list show. */
export const States: Story = {
  render: () => (
    <View className="gap-4">
      <StarRating value={null} label="Qiymət" starLabel={starLabel} onChange={() => undefined} />
      <StarRating value={4} label="Qiymət" starLabel={starLabel} onChange={() => undefined} />
      <StarRating
        value={4}
        label="Qiymət"
        starLabel={starLabel}
        onChange={() => undefined}
        disabled
      />
      <StarRating value={3} label="Qiymət: 5-dən 3" starLabel={starLabel} size="md" />
    </View>
  ),
};
