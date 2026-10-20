import { describe, expect, it } from 'vitest';

import type { ReconciliationCandidate } from './billing.repository';
import { driftOf } from './billing-reconciler.service';

const CHECKOUT: ReconciliationCandidate = {
  checkoutId: '0192f5d4-0000-7000-8000-000000000001',
  providerRef: 'stub_a',
  amountMinor: 2_500,
  currency: 'AZN',
  recordedPaid: false,
  recordedRefund: false,
};
const PAID = { status: 'paid', amountMinor: 2_500, currency: 'AZN' } as const;

describe('driftOf (issue #323)', () => {
  it('finds nothing when both sides agree', () => {
    expect(driftOf(CHECKOUT, { status: 'pending' })).toEqual([]);
    expect(driftOf(CHECKOUT, { status: 'unknown' })).toEqual([]);
    expect(driftOf({ ...CHECKOUT, recordedPaid: true }, PAID)).toEqual([]);
    expect(
      driftOf(
        { ...CHECKOUT, recordedPaid: true, recordedRefund: true },
        { ...PAID, status: 'refunded' },
      ),
    ).toEqual([]);
  });

  it('finds a payment whose webhook never arrived', () => {
    expect(driftOf(CHECKOUT, PAID)).toEqual(['unrecordedPayments']);
  });

  it('finds a payment we recorded that the provider does not hold', () => {
    expect(driftOf({ ...CHECKOUT, recordedPaid: true }, { status: 'failed' })).toEqual([
      'unconfirmedPayments',
    ]);
  });

  it('finds a different amount or currency', () => {
    const recorded = { ...CHECKOUT, recordedPaid: true };

    expect(driftOf(recorded, { ...PAID, amountMinor: 100 })).toEqual(['amountMismatches']);
    expect(driftOf(recorded, { ...PAID, currency: 'USD' })).toEqual(['amountMismatches']);
  });

  it('finds a refund we never recorded', () => {
    expect(driftOf({ ...CHECKOUT, recordedPaid: true }, { ...PAID, status: 'refunded' })).toEqual([
      'unrecordedRefunds',
    ]);
  });
});
