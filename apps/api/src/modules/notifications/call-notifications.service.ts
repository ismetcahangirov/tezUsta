import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { CallRingRegistry } from '../calls/call-ring.registry';
import type { CallRingingEvent } from '../calls/call-ring.registry';
import { CallsService } from '../calls/calls.service';
import { NotificationsService } from './notifications.service';
import type { NotifyJobPayload } from './notifications.schema';

/**
 * What turns a ringing call into a push to the callee's phones (issue #189,
 * ADR-0039 § 4–5).
 *
 * **A wake-up, not a ring.** The push exists for the phone whose app is not
 * open — an open app already rang on `call:incoming`. What the phone does with
 * it is confirm the call with `GET /calls/:callId` before showing anything, so
 * nothing here has to be right about the call for longer than the push takes
 * to leave.
 *
 * **Immediately, with no window.** `MessageNotificationsService` waits to see
 * whether a message was read; a call cannot wait, because the ring timeout is
 * already running. The job goes on the notifications queue like every other
 * kind, so the preference filter, the channel, device retirement and receipts
 * are the ones every push already uses.
 *
 * **The server's state decides, twice.** Once here, implicitly — only an
 * invite that committed a `RINGING` row raises the event — and once in the
 * worker, through {@link stillRinging}, immediately before the send. Between
 * the two sits a queue, and a call answered, declined or cancelled inside that
 * gap must not ring a phone.
 *
 * Here rather than in `modules/calls` because the arrow points this way:
 * notifications reads calls, and calls knows nothing about pushes
 * (`call-ring.registry.ts`).
 */
@Injectable()
export class CallNotificationsService implements OnModuleInit {
  constructor(
    private readonly rings: CallRingRegistry,
    private readonly calls: CallsService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.rings.register('notifications', (event) => this.ringing(event));
  }

  /**
   * Whether a queued `call-incoming` job may still send.
   *
   * `false` for a job without a call id — a payload no release of this code
   * writes — and for a call that is no longer ringing this recipient. One
   * primary-key read, before the devices are resolved.
   */
  async stillRinging(payload: NotifyJobPayload): Promise<boolean> {
    if (payload.callId === undefined) {
      return false;
    }
    return this.calls.isRingingFor(payload.callId, payload.userId);
  }

  /** To the callee's account, never the caller's: the caller is the one ringing. */
  private async ringing(event: CallRingingEvent): Promise<void> {
    await this.notifications.notify({
      userId: event.calleeUserId,
      kind: 'call-incoming',
      orderId: event.orderId,
      callId: event.callId,
      senderKind: event.callerKind,
    });
  }
}
