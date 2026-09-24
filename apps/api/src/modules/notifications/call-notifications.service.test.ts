import { describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../../infra/config/app-config.types';
import { CallRingRegistry } from '../calls/call-ring.registry';
import type { CallRingingEvent } from '../calls/call-ring.registry';
import type { CallsService } from '../calls/calls.service';
import { CallNotificationsService } from './call-notifications.service';
import type { NotificationsService } from './notifications.service';

/**
 * The ring push's dark switch (issue #189, ADR-0039 § 3).
 *
 * A unit test rather than an end-to-end one, because the whole suite boots
 * with `CALL_RING_PUSH_ENABLED=true` (`test/setup-env.ts`) so that
 * `call-ring-push.e2e.test.ts` exercises the path as it will run once enabled.
 * What this proves is the other side: with the flag at its production default,
 * a committed ringing call enqueues nothing at all.
 */
describe('CallNotificationsService', () => {
  const event: CallRingingEvent = {
    callId: '0199c0de-0000-7000-8000-00000000c411',
    orderId: '0199c0de-0000-7000-8000-000000000001',
    calleeUserId: '0199c0de-0000-7000-8000-0000000ca11e',
    callerKind: 'master',
  };

  function wire(ringPushEnabled: boolean) {
    const rings = new CallRingRegistry();
    const notify = vi.fn().mockResolvedValue(undefined);
    const config = { calls: { signalling: { ringPushEnabled } } } as unknown as AppConfig;
    const service = new CallNotificationsService(
      rings,
      {} as CallsService,
      { notify } as unknown as NotificationsService,
      config,
    );
    service.onModuleInit();
    return { rings, notify };
  }

  it('enqueues no ring push while CALL_RING_PUSH_ENABLED is off', async () => {
    const { rings, notify } = wire(false);

    await rings.ringing(event);

    expect(notify).not.toHaveBeenCalled();
  });

  it('enqueues one call-incoming push to the callee when it is on', async () => {
    const { rings, notify } = wire(true);

    await rings.ringing(event);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({
      userId: event.calleeUserId,
      kind: 'call-incoming',
      orderId: event.orderId,
      callId: event.callId,
      senderKind: 'master',
    });
  });
});
