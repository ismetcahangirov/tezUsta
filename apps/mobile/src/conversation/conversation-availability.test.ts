import type { OrderStatus } from '@tezusta/types';

import { conversationAvailability } from './conversation-availability';

const ACCEPTED_AT = '2026-09-23T08:00:00.000Z';

describe('whether an order has a conversation to open', () => {
  it.each<OrderStatus>(['ACCEPTED', 'MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS'])(
    'has a writable one while %s',
    (status) => {
      expect(conversationAvailability({ status, acceptedAt: ACCEPTED_AT })).toEqual({
        writable: true,
      });
    },
  );

  it.each<OrderStatus>([
    'COMPLETED',
    'PAYMENT_PENDING',
    'PAID',
    'DISPUTED',
    'RESOLVED',
    'REFUNDED',
    'CANCELLED',
  ])('keeps a read-only transcript once %s', (status) => {
    expect(conversationAvailability({ status, acceptedAt: ACCEPTED_AT })).toEqual({
      writable: false,
    });
  });

  it.each<OrderStatus>(['SEARCHING', 'NO_MASTER_FOUND', 'CANCELLED'])(
    'has none when %s and nobody ever accepted',
    (status) => {
      expect(conversationAvailability({ status, acceptedAt: null })).toBeNull();
    },
  );
});
