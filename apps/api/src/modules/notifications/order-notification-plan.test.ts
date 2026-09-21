import { describe, expect, it } from 'vitest';

import { planOfferNotifications, planTransitionNotifications } from './order-notification-plan';

/**
 * Who hears about an order event, and what they are told (issue #144).
 *
 * **This is where "nobody is notified of their own action" is enforced**, and
 * it is a pure function precisely so that the rule is one rule rather than a
 * condition repeated at seven call sites. Every event in the Epic reduces to
 * the same three facts — the committed status, the two parties, and who acted
 * — so every case below is the same function with different arguments.
 */

const CUSTOMER = '0199c0de-0000-7000-8000-00000000c001';
const MASTER = '0199c0de-0000-7000-8000-00000000af01';
const ADMIN_ACTS = undefined;

describe('planning an order transition notification', () => {
  it('tells the customer a master took the job, and not the master who took it', () => {
    const planned = planTransitionNotifications({
      to: 'ACCEPTED',
      customerUserId: CUSTOMER,
      masterUserId: MASTER,
      actorUserId: MASTER,
    });

    expect(planned).toEqual([{ userId: CUSTOMER, kind: 'order-accepted' }]);
  });

  it.each(['MASTER_ON_THE_WAY', 'MASTER_ARRIVED', 'IN_PROGRESS', 'COMPLETED'] as const)(
    'tells the customer about %s, and not the master who did it',
    (to) => {
      const planned = planTransitionNotifications({
        to,
        customerUserId: CUSTOMER,
        masterUserId: MASTER,
        actorUserId: MASTER,
      });

      expect(planned).toEqual([{ userId: CUSTOMER, kind: 'order-status-changed' }]);
    },
  );

  it('tells the assigned master when the customer cancels', () => {
    const planned = planTransitionNotifications({
      to: 'CANCELLED',
      customerUserId: CUSTOMER,
      masterUserId: MASTER,
      actorUserId: CUSTOMER,
    });

    expect(planned).toEqual([{ userId: MASTER, kind: 'order-cancelled' }]);
  });

  it('tells nobody when an order with no master is cancelled', () => {
    const planned = planTransitionNotifications({
      to: 'CANCELLED',
      customerUserId: CUSTOMER,
      masterUserId: undefined,
      actorUserId: CUSTOMER,
    });

    expect(planned).toEqual([]);
  });

  /**
   * A re-dispatch clears `orders.master_id` in the same transaction, so the
   * master who dropped the job is not a recipient for two independent reasons
   * — they are the actor, and they are no longer a party. Either alone would
   * be enough; the test asserts the outcome rather than which one did it.
   */
  it('tells the customer their master fell through and the search resumed', () => {
    const planned = planTransitionNotifications({
      to: 'SEARCHING',
      customerUserId: CUSTOMER,
      masterUserId: undefined,
      actorUserId: MASTER,
    });

    expect(planned).toEqual([{ userId: CUSTOMER, kind: 'order-redispatched' }]);
  });

  it('tells the customer when the search ends with nobody', () => {
    const planned = planTransitionNotifications({
      to: 'NO_MASTER_FOUND',
      customerUserId: CUSTOMER,
      masterUserId: undefined,
      actorUserId: undefined,
    });

    expect(planned).toEqual([{ userId: CUSTOMER, kind: 'order-no-master-found' }]);
  });

  /**
   * An admin is neither party, so nothing excludes them — and nothing needs
   * to. The exclusion is "drop the actor from the recipients", and an admin's
   * id is never in the recipient set to begin with. This is the whole reason
   * the rule is expressed as an exclusion rather than as a per-event list of
   * who to tell.
   */
  it('tells both parties about an admin override, and the admin nothing', () => {
    const planned = planTransitionNotifications({
      to: 'CANCELLED',
      customerUserId: CUSTOMER,
      masterUserId: MASTER,
      actorUserId: ADMIN_ACTS,
    });

    expect(planned).toEqual([
      { userId: CUSTOMER, kind: 'order-cancelled' },
      { userId: MASTER, kind: 'order-cancelled' },
    ]);
  });

  it('never tells one person twice, even when they are both parties', () => {
    const planned = planTransitionNotifications({
      to: 'CANCELLED',
      customerUserId: CUSTOMER,
      masterUserId: CUSTOMER,
      actorUserId: undefined,
    });

    expect(planned).toEqual([{ userId: CUSTOMER, kind: 'order-cancelled' }]);
  });

  it('tells nobody about a party with no account behind it', () => {
    const planned = planTransitionNotifications({
      to: 'COMPLETED',
      customerUserId: undefined,
      masterUserId: MASTER,
      actorUserId: MASTER,
    });

    expect(planned).toEqual([]);
  });

  /**
   * The money statuses belong to EPIC 12 and have no notification kind yet.
   * Silence is the right answer until that Epic decides what they say — and a
   * status with no kind must never fall through to a neighbouring one.
   */
  it.each(['DRAFT', 'PAYMENT_PENDING', 'PAID', 'DISPUTED', 'RESOLVED', 'REFUNDED'] as const)(
    'raises nothing for %s, which no Epic has given words to yet',
    (to) => {
      const planned = planTransitionNotifications({
        to,
        customerUserId: CUSTOMER,
        masterUserId: MASTER,
        actorUserId: undefined,
      });

      expect(planned).toEqual([]);
    },
  );
});

describe('planning a broadcast notification', () => {
  it('produces one notification per master the broadcast reached, and no more', () => {
    const reached = [MASTER, '0199c0de-0000-7000-8000-00000000af02'];

    expect(planOfferNotifications(reached)).toEqual([
      { userId: MASTER, kind: 'order-offer' },
      { userId: '0199c0de-0000-7000-8000-00000000af02', kind: 'order-offer' },
    ]);
  });

  it('produces nothing for a wave that reached nobody', () => {
    expect(planOfferNotifications([])).toEqual([]);
  });

  /**
   * A master reached by two waves of the same search must not be told twice
   * for one wave's raise. Across waves they legitimately are told again — that
   * is a fresh offer — so the de-duplication is per raise and nothing wider.
   */
  it('tells one master once per wave', () => {
    expect(planOfferNotifications([MASTER, MASTER])).toEqual([
      { userId: MASTER, kind: 'order-offer' },
    ]);
  });
});
