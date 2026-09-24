import { describe, expect, it, vi } from 'vitest';

import { CallRingRegistry } from './call-ring.registry';
import type { CallRingingEvent } from './call-ring.registry';

/**
 * The seam a ringing call leaves `modules/calls` through (issue #189).
 *
 * **The behaviour under test is isolation, not delivery** — the property
 * `order-notifications.registry.test.ts` pins for order events. The call is
 * committed and rings over the socket whatever a subscriber does; a queue
 * having a bad second must not turn a committed invite into a refusal the
 * caller would retry, and must not cost another subscriber its turn.
 */
describe('CallRingRegistry', () => {
  const event: CallRingingEvent = {
    callId: 'call-1',
    orderId: 'order-1',
    calleeUserId: 'user-callee',
    callerKind: 'customer',
  };

  function silence(): CallRingRegistry {
    const registry = new CallRingRegistry();
    // A swallowed failure is logged at `warn`; the tests below cause one on
    // purpose, and an expected log is noise rather than signal.
    vi.spyOn(registry['logger'], 'warn').mockImplementation(() => undefined);
    return registry;
  }

  it('reaches every subscriber with the same ringing call', async () => {
    const registry = silence();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);

    registry.register('first', first);
    registry.register('second', second);
    await registry.ringing(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });

  it('resolves, and still reaches the next subscriber, when one throws', async () => {
    const registry = silence();
    const second = vi.fn().mockResolvedValue(undefined);

    registry.register('push', vi.fn().mockRejectedValue(new Error('queue is down')));
    registry.register('second', second);

    await expect(registry.ringing(event)).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledWith(event);
  });

  it('does nothing, and does not throw, with nobody registered', async () => {
    await expect(new CallRingRegistry().ringing(event)).resolves.toBeUndefined();
  });

  it('refuses a second subscriber under a name already taken', () => {
    const registry = new CallRingRegistry();
    registry.register('notifications', vi.fn());

    expect(() => {
      registry.register('notifications', vi.fn());
    }).toThrow(/already registered/);
  });
});
