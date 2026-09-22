import { readNotificationTarget, resolveNotificationRoute } from './notification-destination';

/**
 * The payload is untrusted input. It arrives over the network, is shown on a
 * lock screen, and is read by a device that has no way to ask whether the
 * sender was us — so this file is as much a security test as a routing one.
 */
describe('readNotificationTarget', () => {
  describe('the kinds this Epic raises', () => {
    it.each([
      ['order-offer', 'master'],
      ['order-accepted', 'customer'],
      ['order-status-changed', 'either'],
      ['order-cancelled', 'either'],
      ['order-redispatched', 'customer'],
      ['order-no-master-found', 'customer'],
    ])('reads %s as an order target for %s', (kind, audience) => {
      expect(readNotificationTarget({ kind, orderId: 'order-1' })).toEqual({
        kind,
        orderId: 'order-1',
        audience,
      });
    });
  });

  describe('what it refuses', () => {
    it('refuses a kind it does not know', () => {
      // A kind added to the server and not yet to this app is the normal way
      // this happens, and the right answer is to open the app and do nothing
      // rather than to guess a screen.
      expect(readNotificationTarget({ kind: 'order-invoiced', orderId: 'order-1' })).toBeNull();
    });

    it('refuses a known kind with no order id', () => {
      expect(readNotificationTarget({ kind: 'order-accepted' })).toBeNull();
    });

    it('refuses an order id that is not a string', () => {
      expect(readNotificationTarget({ kind: 'order-accepted', orderId: 42 })).toBeNull();
    });

    it('refuses an empty order id', () => {
      expect(readNotificationTarget({ kind: 'order-accepted', orderId: '   ' })).toBeNull();
    });

    it.each([undefined, null, 'a string', 42, []])('refuses %p as a payload', (data) => {
      expect(readNotificationTarget(data)).toBeNull();
    });

    it('refuses a payload with no kind at all', () => {
      expect(readNotificationTarget({ orderId: 'order-1' })).toBeNull();
    });
  });

  describe('a payload that tries to choose a screen', () => {
    it('ignores a url, a path and a pathname, and routes on the kind alone', () => {
      const target = readNotificationTarget({
        kind: 'order-accepted',
        orderId: 'order-1',
        url: 'https://example.com/steal',
        path: '/(shared)/settings',
        pathname: '/(master)',
        screen: '/(master)',
      });

      // The extra members are not carried anywhere. Nothing downstream can
      // navigate to them because nothing downstream is given them.
      expect(target).toEqual({ kind: 'order-accepted', orderId: 'order-1', audience: 'customer' });
    });

    it('does not navigate at all for a payload that is only a url', () => {
      expect(readNotificationTarget({ url: 'https://example.com/steal' })).toBeNull();
    });
  });
});

describe('resolveNotificationRoute', () => {
  const ORDER_TARGET = {
    kind: 'order-accepted',
    orderId: 'order-1',
    audience: 'customer',
  } as const;
  const OFFER_TARGET = { kind: 'order-offer', orderId: 'order-1', audience: 'master' } as const;
  const EITHER_TARGET = {
    kind: 'order-cancelled',
    orderId: 'order-1',
    audience: 'either',
  } as const;

  /**
   * **The half of #146 that was waiting on a screen** (#155,
   * [ADR-0029](../../../../docs/decisions/ADR-0029-customer-order-screen.md)).
   * Until the order screen existed this resolved to the customer home, because
   * there was nowhere for the order id to go. The id has always been carried;
   * this is where it is finally used.
   */
  it('opens the order a customer notification is about', () => {
    expect(
      resolveNotificationRoute(ORDER_TARGET, { grantedRoles: ['customer'], role: 'customer' }),
    ).toEqual({
      role: 'customer',
      route: { pathname: '/(customer)/order/[id]', params: { id: 'order-1' } },
    });
  });

  it('opens the order the payload named, not some other order', () => {
    expect(
      resolveNotificationRoute(
        { ...ORDER_TARGET, orderId: 'order-9' },
        { grantedRoles: ['customer'], role: 'customer' },
      ),
    ).toEqual({
      role: 'customer',
      route: { pathname: '/(customer)/order/[id]', params: { id: 'order-9' } },
    });
  });

  it('switches a dual-role user into the role the notification is about', () => {
    // A master reading the app as a customer taps an offer. Landing them on
    // the customer home would be the app ignoring the thing they just tapped.
    expect(
      resolveNotificationRoute(OFFER_TARGET, {
        grantedRoles: ['customer', 'master'],
        role: 'customer',
      }),
    ).toEqual({ role: 'master', route: '/(master)' });
  });

  it('leaves the current role alone when the kind does not say whose it is', () => {
    // `order-cancelled` reaches whichever party did not do the cancelling, so
    // the kind alone cannot name a role. Staying put beats guessing.
    expect(
      resolveNotificationRoute(EITHER_TARGET, {
        grantedRoles: ['customer', 'master'],
        role: 'master',
      }),
    ).toEqual({ role: 'master', route: '/(master)' });
  });

  it('opens the order for an either-audience notification read as a customer', () => {
    expect(
      resolveNotificationRoute(EITHER_TARGET, {
        grantedRoles: ['customer', 'master'],
        role: 'customer',
      }),
    ).toEqual({
      role: 'customer',
      route: { pathname: '/(customer)/order/[id]', params: { id: 'order-1' } },
    });
  });

  /**
   * **A master still lands on their home, and that is not an oversight.** There
   * is no master-facing order screen and no offer feed yet; naming a route that
   * does not exist is the guess this table exists to prevent.
   */
  it('sends a master to their home, because they have no order screen yet', () => {
    expect(
      resolveNotificationRoute(OFFER_TARGET, {
        grantedRoles: ['customer', 'master'],
        role: 'master',
      }),
    ).toEqual({ role: 'master', route: '/(master)' });
  });

  it('refuses to route into a role this account does not hold', () => {
    // A customer-only account receiving a master notification is either a
    // server bug or a stale device registration. Either way the app must not
    // open a role experience the account has no grant for.
    expect(
      resolveNotificationRoute(OFFER_TARGET, { grantedRoles: ['customer'], role: 'customer' }),
    ).toBeNull();
  });

  it('routes on the granted role when the selected one is not granted', () => {
    expect(
      resolveNotificationRoute(EITHER_TARGET, { grantedRoles: ['master'], role: 'customer' }),
    ).toEqual({ role: 'master', route: '/(master)' });
  });

  it('routes an unreadable token as the selected role rather than nowhere', () => {
    // Empty grants means "not known", not "holds nothing" — the same reading
    // `session-slice.ts` and the route guard already use.
    expect(resolveNotificationRoute(OFFER_TARGET, { grantedRoles: [], role: 'customer' })).toEqual({
      role: 'master',
      route: '/(master)',
    });
  });
});
