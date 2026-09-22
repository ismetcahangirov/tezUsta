import type { OrderStatus } from '@tezusta/types';

import { presentOrderStatus } from './order-status-presentation';

/**
 * The fourteen statuses of
 * [ADR-0015](../../../../docs/decisions/ADR-0015-order-lifecycle-states.md), as
 * a customer reads them (issue #155).
 *
 * Restated here rather than imported: there is no runtime list of statuses in
 * the app — `OrderStatus` is a type in `@tezusta/types`, which ships types only
 * — so this array is what makes "every one of them is covered" checkable at all.
 * A status added to the contract and not added here leaves the test passing,
 * which is exactly why the presentation table is a total `Record` and fails to
 * compile instead.
 */
const EVERY_STATUS: readonly OrderStatus[] = [
  'DRAFT',
  'SEARCHING',
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'PAYMENT_PENDING',
  'PAID',
  'DISPUTED',
  'RESOLVED',
  'REFUNDED',
  'NO_MASTER_FOUND',
  'CANCELLED',
];

describe('presentOrderStatus', () => {
  it('gives every status a label and a sentence saying what happens next', () => {
    for (const status of EVERY_STATUS) {
      const presentation = presentOrderStatus(status);

      expect(presentation.label.trim()).not.toBe('');
      expect(presentation.next.trim()).not.toBe('');
    }
  });

  it('never repeats a label, so two states cannot read as the same state', () => {
    const labels = EVERY_STATUS.map((status) => presentOrderStatus(status).label);

    expect(new Set(labels).size).toBe(labels.length);
  });

  /**
   * **The distinction the fifth tone exists for.** Nobody cancelled a
   * `NO_MASTER_FOUND` order — the platform had no free master nearby — and
   * showing it in the failure colour would be the visual form of exactly the
   * conflation that status was added to prevent
   * ([ADR-0029](../../../../docs/decisions/ADR-0029-customer-order-screen.md)).
   */
  it('does not dress an unfilled order as a cancelled one', () => {
    expect(presentOrderStatus('NO_MASTER_FOUND').tone).toBe('unfilled');
    expect(presentOrderStatus('CANCELLED').tone).toBe('cancelled');
  });

  it('reads a search as waiting and an accepted order as active', () => {
    expect(presentOrderStatus('SEARCHING').tone).toBe('pending');
    expect(presentOrderStatus('ACCEPTED').tone).toBe('active');
    expect(presentOrderStatus('PAID').tone).toBe('done');
  });
});
