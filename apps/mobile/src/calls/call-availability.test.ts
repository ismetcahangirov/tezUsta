import type { OrderStatus } from '@tezusta/types';

import { canCallAbout } from './call-availability';

const ACCEPTED_AT = '2026-09-24T10:00:00.000Z';

const CALLABLE: readonly OrderStatus[] = [
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
];

const NOT_CALLABLE: readonly OrderStatus[] = [
  'DRAFT',
  'SEARCHING',
  'NO_MASTER_FOUND',
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'DISPUTED',
  'RESOLVED',
  'REFUNDED',
  'CANCELLED',
];

describe('canCallAbout', () => {
  it.each(CALLABLE)('allows a call on an accepted order in %s', (status) => {
    expect(canCallAbout({ status, acceptedAt: ACCEPTED_AT })).toBe(true);
  });

  it.each(NOT_CALLABLE)('allows no call on an order in %s', (status) => {
    expect(canCallAbout({ status, acceptedAt: ACCEPTED_AT })).toBe(false);
  });

  it('allows no call on an order nobody has accepted', () => {
    expect(canCallAbout({ status: 'SEARCHING', acceptedAt: null })).toBe(false);
  });
});
