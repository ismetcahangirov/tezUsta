import type { Meta, StoryObj } from '@storybook/react-native-web-vite';
import type { OrderSummary } from '@tezusta/types';

import { OrderList } from './OrderList';

function order(id: string, overrides: Partial<OrderSummary> = {}): OrderSummary {
  return {
    id,
    status: 'SEARCHING',
    serviceId: 'svc-1',
    addressId: 'addr-1',
    description: 'Mətbəxdə kran sızır, su dayanmır.',
    priceMinor: null,
    masterId: null,
    redispatchCount: 0,
    acceptedAt: null,
    createdAt: '2026-09-20T09:00:00.000Z',
    updatedAt: '2026-09-20T09:00:00.000Z',
    unreadMessageCount: 0,
    ...overrides,
  };
}

const meta = {
  title: 'Orders/OrderList',
  component: OrderList,
  args: {
    orders: [order('order-1'), order('order-2', { status: 'PAID', priceMinor: 4500 })],
    onSelect: () => undefined,
  },
} satisfies Meta<typeof OrderList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

/**
 * The arrangement the list exists for: one order with a master attached to it,
 * above everything that is already over
 * ([ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)
 * § 3) — the review CLAUDE.md § 17 asks for before a component reaches a route.
 */
export const OpenAboveFinished: Story = {
  args: {
    orders: [
      order('order-1', { status: 'MASTER_ON_THE_WAY', priceMinor: 4500 }),
      order('order-2', {
        status: 'CANCELLED',
        description: 'Qapı kilidi işləmir.',
        createdAt: '2026-09-12T18:20:00.000Z',
      }),
      order('order-3', {
        status: 'NO_MASTER_FOUND',
        description: 'Kondisioner soyutmur.',
        createdAt: '2026-08-30T11:00:00.000Z',
      }),
    ],
  },
};

/**
 * A description long enough to bury the rest of the row if it were allowed to.
 * Two lines, then an ellipsis — the row is a way back to an order, not a place
 * to read one.
 */
export const ALongDescription: Story = {
  args: {
    orders: [
      order('order-1', {
        description:
          'Mətbəxdə kranın altından su sızır, şkafın içi islanıb. Dünən axşam başlayıb, ' +
          'gecə daha da artıb. Kranı bağlayanda da damcılayır, altına qab qoymuşam. ' +
          'Mümkünsə bu gün gəlsin, çünki suyu tamam bağlamalı oluram.',
      }),
    ],
  },
};

/**
 * An order the master has written about (issue #182): the unread count sits on
 * the row, under the status, and nowhere else on the list.
 */
export const WithUnreadMessages: Story = {
  args: {
    orders: [
      order('order-1', {
        status: 'MASTER_ON_THE_WAY',
        priceMinor: 4500,
        acceptedAt: '2026-09-20T09:05:00.000Z',
        unreadMessageCount: 2,
      }),
      order('order-2', { status: 'PAID', priceMinor: 4500, description: 'Qapı kilidi işləmir.' }),
    ],
  },
};
