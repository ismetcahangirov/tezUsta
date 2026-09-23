import type { MasterPositionRealtimeEvent, Message, OrderSummary } from '@tezusta/types';

import { createTestStore } from '../../test/support/test-store';
import { conversationApi } from '../conversation/conversation-endpoints';
import { ordersApi } from '../orders/order-endpoints';
import type { AppStore } from '../store';

import { applyRealtimeEvent } from './apply-realtime-event';
import { createSequenceGuard } from './sequence-guard';
import { trackingApi, type ReceivedMasterPosition } from './tracking-endpoints';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const ORDER_ID = 'order-1';

const POSITION: MasterPositionRealtimeEvent = {
  orderId: ORDER_ID,
  latitude: 40.377,
  longitude: 49.892,
  at: 5_000,
};

/**
 * Subscribes to the tracking entry the way the order screen does, and waits
 * for it to settle.
 *
 * Awaited rather than dispatched and forgotten: `updateQueryData` patches an
 * entry that exists, and an `initiate` that has not resolved yet has not
 * created one — a patch applied in that window is silently dropped, which is
 * the same failure the production code is allowed to have (nobody is
 * watching) and exactly the one a test must not reproduce by accident.
 */
async function subscribe(store: AppStore): Promise<void> {
  await store.dispatch(trackingApi.endpoints.masterPosition.initiate(ORDER_ID));
}

function positionIn(store: AppStore): ReceivedMasterPosition | null | undefined {
  return trackingApi.endpoints.masterPosition.select(ORDER_ID)(store.getState()).data;
}

/**
 * Applying one event to the one cache (issue #170, ADR-0017).
 *
 * The transition path is asserted through the rendered screen in
 * `order-live-updates.test.tsx`, which is where it belongs. What is left here
 * is the half no screen renders yet — the master's position, which #172 will
 * draw — and the rule that it goes into the **cache** rather than into a slice
 * of its own.
 */
describe('applying a realtime event', () => {
  it('puts a position where the tracking query reads it', async () => {
    const store = createTestStore();
    // A subscriber, awaited, because RTK Query has no entry to patch until a
    // query has actually settled — exactly as the order screen does before the
    // first point arrives.
    await subscribe(store);

    applyRealtimeEvent(store.dispatch, createSequenceGuard(), {
      name: 'order:master-position',
      payload: POSITION,
    });

    expect(positionIn(store)).toEqual({ ...POSITION, receivedAt: expect.any(Number) });
  });

  /**
   * Freshness is judged on the phone's clock (#172), so the arrival time is
   * stamped where the frame lands — not the server's `at`, which is kept for
   * ordering and nothing else.
   */
  it('stamps the point with when it arrived, by this phone’s clock', async () => {
    const store = createTestStore();
    await subscribe(store);
    // Once, and calling through afterwards: restoring a spy on `performance.now`
    // leaves the Jest environment's clock returning `undefined` for later tests.
    jest.spyOn(performance, 'now').mockReturnValueOnce(1_234_567);

    applyRealtimeEvent(store.dispatch, createSequenceGuard(), {
      name: 'order:master-position',
      payload: POSITION,
    });

    expect(positionIn(store)?.receivedAt).toBe(1_234_567);
    expect(positionIn(store)?.at).toBe(POSITION.at);
  });

  it('replaces the previous point rather than accumulating a trail', async () => {
    const store = createTestStore();
    await subscribe(store);
    const guard = createSequenceGuard();

    applyRealtimeEvent(store.dispatch, guard, { name: 'order:master-position', payload: POSITION });
    applyRealtimeEvent(store.dispatch, guard, {
      name: 'order:master-position',
      payload: { ...POSITION, latitude: 40.4, at: 6_000 },
    });

    expect(positionIn(store)?.latitude).toBe(40.4);
  });

  it('discards a position older than the one already shown', async () => {
    const store = createTestStore();
    await subscribe(store);
    const guard = createSequenceGuard();

    applyRealtimeEvent(store.dispatch, guard, { name: 'order:master-position', payload: POSITION });
    const applied = applyRealtimeEvent(store.dispatch, guard, {
      name: 'order:master-position',
      payload: { ...POSITION, latitude: 1, at: 4_999 },
    });

    expect(applied).toBe(false);
    expect(positionIn(store)).toEqual({ ...POSITION, receivedAt: expect.any(Number) });
  });

  /**
   * An event for an order no screen is watching must not throw or invent a
   * cache entry. It is the common case: the order list is open, a transition
   * arrives for an order whose detail screen is not mounted.
   */
  it('is a no-op when nothing is subscribed to the order', () => {
    const store = createTestStore();

    expect(() =>
      applyRealtimeEvent(store.dispatch, createSequenceGuard(), {
        name: 'order:master-position',
        payload: POSITION,
      }),
    ).not.toThrow();
    expect(positionIn(store)).toBeUndefined();
  });

  it('patches only the fields a transition carries, leaving the rest alone', async () => {
    const store = createTestStore();
    const existing: OrderSummary = {
      id: ORDER_ID,
      status: 'SEARCHING',
      serviceId: 'svc-1',
      addressId: 'addr-1',
      description: 'Mətbəxdə kran sızır.',
      priceMinor: null,
      masterId: null,
      redispatchCount: 0,
      acceptedAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      unreadMessageCount: 0,
    };
    await store.dispatch(ordersApi.util.upsertQueryData('order', ORDER_ID, existing));

    applyRealtimeEvent(store.dispatch, createSequenceGuard(), {
      name: 'order:transition',
      payload: {
        orderId: ORDER_ID,
        status: 'ACCEPTED',
        masterId: 'master-1',
        priceMinor: 6700,
        at: 1_000,
      },
    });

    const patched = ordersApi.endpoints.order.select(ORDER_ID)(store.getState()).data;
    expect(patched).toEqual({
      ...existing,
      status: 'ACCEPTED',
      masterId: 'master-1',
      priceMinor: 6700,
    });
  });

  /**
   * The master's offer feed does not exist in this app yet, so the tag it
   * invalidates has no provider. The event must still be handled rather than
   * dropped by a `default:` nobody would ever notice.
   */
  it('handles an offer without a feed to invalidate', () => {
    const store = createTestStore();

    const applied = applyRealtimeEvent(store.dispatch, createSequenceGuard(), {
      name: 'order:offer',
      payload: { orderId: ORDER_ID, at: 1_000 },
    });

    expect(applied).toBe(true);
  });

  /**
   * A message is not a newer version of the order (issue #182). The guard
   * that stops a late transition walking the screen backwards must not also
   * drop a message stamped a millisecond before the transition that followed
   * it — silently, which is the one thing a conversation may not do.
   */
  it('keeps a message frame even when it is older than the order’s last transition', async () => {
    global.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [], nextCursor: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    const store = createTestStore();
    // The history loaded and empty, as the conversation screen holds it.
    await store.dispatch(conversationApi.endpoints.messages.initiate(ORDER_ID));
    const guard = createSequenceGuard();
    const late: Message = {
      id: 'm-1',
      conversationId: 'conversation-1',
      senderKind: 'master',
      body: 'Yoldayam.',
      attachments: [],
      createdAt: '2026-09-23T08:00:00.000Z',
      readAt: null,
    };

    applyRealtimeEvent(store.dispatch, guard, {
      name: 'order:transition',
      payload: {
        orderId: ORDER_ID,
        status: 'MASTER_ON_THE_WAY',
        masterId: 'm',
        priceMinor: 1,
        at: 2_000,
      },
    });
    const applied = applyRealtimeEvent(store.dispatch, guard, {
      name: 'message:new',
      payload: { orderId: ORDER_ID, message: late, at: 1_999 },
    });

    expect(applied).toBe(true);
    const held = conversationApi.endpoints.messages.select(ORDER_ID)(store.getState()).data;
    expect(held?.pages.flatMap((page) => page.items).map((message) => message.id)).toEqual(['m-1']);
  });
});
