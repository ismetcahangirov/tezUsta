import { describe, expect, it, vi } from 'vitest';

import { OrderNotificationsRegistry } from './order-notifications.registry';
import type { OrderBroadcastEvent, OrderTransitionEvent } from './order-notifications.registry';

/**
 * The seam every committed order event leaves `modules/orders` through
 * (issues #144, #168).
 *
 * **The behaviour under test is isolation, not delivery.** Two consumers now
 * subscribe — a push and a socket — and the property that matters is that
 * neither can cost the other its delivery or cost the transition anything.
 * A registry that forwarded the first failure would turn a push provider
 * having a bad minute into an order the API refuses to move, which is the one
 * outcome every doc comment in this file is written to prevent.
 */
describe('OrderNotificationsRegistry', () => {
  const transition: OrderTransitionEvent = {
    orderId: 'order-1',
    customerId: 'customer-1',
    masterId: 'master-1',
    to: 'ACCEPTED',
    priceMinor: 6700,
    actorUserId: 'user-1',
  };

  const wave: OrderBroadcastEvent = { orderId: 'order-1', masterIds: ['master-1', 'master-2'] };

  function silence(): OrderNotificationsRegistry {
    const registry = new OrderNotificationsRegistry();
    // The registry logs a swallowed failure at `warn`; the tests below cause
    // those deliberately, and an expected log is noise rather than signal.
    vi.spyOn(registry['logger'], 'warn').mockImplementation(() => undefined);
    return registry;
  }

  it('reaches every subscriber with the same transition', async () => {
    const registry = silence();
    const push = vi.fn().mockResolvedValue(undefined);
    const socket = vi.fn().mockResolvedValue(undefined);

    registry.register('push', push, vi.fn());
    registry.register('socket', socket, vi.fn());
    await registry.transitioned(transition);

    expect(push).toHaveBeenCalledWith(transition);
    expect(socket).toHaveBeenCalledWith(transition);
  });

  it('reaches every subscriber with the same wave', async () => {
    const registry = silence();
    const push = vi.fn().mockResolvedValue(undefined);
    const socket = vi.fn().mockResolvedValue(undefined);

    registry.register('push', vi.fn(), push);
    registry.register('socket', vi.fn(), socket);
    await registry.broadcast(wave);

    expect(push).toHaveBeenCalledWith(wave);
    expect(socket).toHaveBeenCalledWith(wave);
  });

  it('still reaches the second subscriber when the first throws', async () => {
    const registry = silence();
    const socket = vi.fn().mockResolvedValue(undefined);

    registry.register('push', vi.fn().mockRejectedValue(new Error('queue is down')), vi.fn());
    registry.register('socket', socket, vi.fn());

    await expect(registry.transitioned(transition)).resolves.toBeUndefined();
    expect(socket).toHaveBeenCalledWith(transition);
  });

  it('never lets a throwing subscriber reach the caller', async () => {
    const registry = silence();
    registry.register('socket', vi.fn().mockRejectedValue(new Error('no server')), vi.fn());
    registry.register('push', vi.fn(), vi.fn().mockRejectedValue(new Error('queue is down')));

    await expect(registry.transitioned(transition)).resolves.toBeUndefined();
    await expect(registry.broadcast(wave)).resolves.toBeUndefined();
  });

  it('raises nothing for a wave that reached nobody', async () => {
    const registry = silence();
    const push = vi.fn().mockResolvedValue(undefined);
    registry.register('push', vi.fn(), push);

    await registry.broadcast({ orderId: 'order-1', masterIds: [] });

    expect(push).not.toHaveBeenCalled();
  });

  it('says nothing at all with no subscriber registered', async () => {
    const registry = silence();

    await expect(registry.transitioned(transition)).resolves.toBeUndefined();
    await expect(registry.broadcast(wave)).resolves.toBeUndefined();
  });

  it('refuses a second registration under one name', () => {
    const registry = silence();
    registry.register('push', vi.fn(), vi.fn());

    expect(() => {
      registry.register('push', vi.fn(), vi.fn());
    }).toThrow(/already registered/);
  });
});
