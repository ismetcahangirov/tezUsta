import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import { View } from 'react-native';

import { PartyRatingLine } from './PartyRatingLine';

const meta = {
  title: 'Reviews/PartyRatingLine',
  component: PartyRatingLine,
  args: { label: 'Ustanın reytinqi', rating: { ratingAverage: 4.67, ratingCount: 12 } },
  decorators: [
    (Story) => (
      <View className="bg-bg p-4">
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof PartyRatingLine>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/** Rated, and nobody has rated yet — the one that must never say 0. */
export const States: Story = {
  render: () => (
    <View className="gap-4">
      <PartyRatingLine label="Ustanın reytinqi" rating={{ ratingAverage: 4.67, ratingCount: 12 }} />
      <PartyRatingLine
        label="Müştərinin reytinqi"
        rating={{ ratingAverage: null, ratingCount: 0 }}
      />
    </View>
  ),
};
