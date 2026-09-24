import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import type { OrderStatus } from '@tezusta/types';
import { View } from 'react-native';

import { Text } from '../components';
import { OrderStatusCard } from './OrderStatusCard';

const meta = {
  title: 'Orders/OrderStatusCard',
  component: OrderStatusCard,
  args: { status: 'SEARCHING', priceMinor: null },
} satisfies Meta<typeof OrderStatusCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/**
 * The states a customer actually passes through, in order — the review this
 * screen needed before it was wired into a route (CLAUDE.md §17).
 */
const JOURNEY: readonly { status: OrderStatus; priceMinor: number | null }[] = [
  { status: 'SEARCHING', priceMinor: null },
  { status: 'ACCEPTED', priceMinor: 4500 },
  { status: 'MASTER_ON_THE_WAY', priceMinor: 4500 },
  { status: 'IN_PROGRESS', priceMinor: 4500 },
  { status: 'PAID', priceMinor: 4500 },
];

/** Issue #228: the assigned master's rating, rated and not yet rated. */
export const WithMasterRating: Story = {
  render: () => (
    <View className="gap-4">
      <OrderStatusCard
        status="MASTER_ON_THE_WAY"
        priceMinor={4500}
        masterRating={{ ratingAverage: 4.67, ratingCount: 12 }}
      />
      <OrderStatusCard
        status="ACCEPTED"
        priceMinor={4500}
        masterRating={{ ratingAverage: null, ratingCount: 0 }}
      />
    </View>
  ),
};

export const TheJourney: Story = {
  render: () => (
    <View className="gap-4">
      {JOURNEY.map((order) => (
        <OrderStatusCard key={order.status} {...order} />
      ))}
    </View>
  ),
};

/**
 * The three ways an order ends without being done, side by side — the whole
 * reason `NO_MASTER_FOUND` has a tone of its own rather than wearing the
 * failure colour.
 */
export const EndingsThatAreNotSuccess: Story = {
  render: () => (
    <View className="gap-4">
      <Text tone="muted">
        Nobody cancelled an unfilled order. The label says which is which; the colour never does.
      </Text>
      <OrderStatusCard status="NO_MASTER_FOUND" priceMinor={null} />
      <OrderStatusCard status="CANCELLED" priceMinor={null} />
      <OrderStatusCard status="DISPUTED" priceMinor={4500} />
    </View>
  ),
};
