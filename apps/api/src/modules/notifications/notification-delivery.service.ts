import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { PUSH_SENDER } from '../../infra/push/push-sender.types';
import type { PushEnvelope, PushSender } from '../../infra/push/push-sender.types';
import { DevicesService } from '../devices/devices.service';
import { renderNotification } from './notification-copy';
import { NOTIFY_JOB } from './notifications.service';
import { notifyJobPayloadSchema } from './notifications.schema';
import type { NotifyJobPayload } from './notifications.schema';
import { PushTicketsRepository } from './push-tickets.repository';
import type { AcceptedTicket } from './push-tickets.repository';

/**
 * The consumer half: what a queued notification actually does.
 *
 * Registered into {@link DeferredJobHandlerRegistry} from this module's own
 * `onModuleInit`, the same way the dispatch engine registers its job names —
 * so `infra/queue` keeps knowing nothing about notifications and the arrow
 * still points one way (CLAUDE.md §14's `no-circular`).
 */
@Injectable()
export class NotificationDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly devices: DevicesService,
    private readonly tickets: PushTicketsRepository,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {}

  onModuleInit(): void {
    this.handlers.register(NOTIFY_JOB, (payload) => this.deliver(payload));
  }

  /**
   * Deliver one notification to every live device its recipient has.
   *
   * **Idempotent in the way that matters and not in the way it cannot be.**
   * Re-running re-reads the devices, re-renders the copy and writes the same
   * receipt ids, which the unique index absorbs. What it cannot undo is a push
   * that already reached a phone: Expo's send is not idempotent, so a job that
   * sent and then failed will, on retry, show the same notification twice.
   * That is accepted rather than solved — the alternative is a per-device
   * delivery ledger written before the send, which turns one notification into
   * two round trips and still cannot close the window between them. Duplicate
   * notification, never a missing one, is the right side of that trade.
   */
  private async deliver(rawPayload: DeferredJobPayload): Promise<void> {
    const payload = this.parse(rawPayload);

    const devices = await this.devices.addressableFor(payload.userId);
    if (devices.length === 0) {
      // Not an error and not worth a warning. Plenty of accounts have never
      // opened the app on a phone that granted permission, and a job that
      // threw here would retry three times and land in the failed set for
      // every one of them.
      return;
    }

    const copy = renderNotification(payload);
    const envelopes: PushEnvelope[] = devices.map((device) => ({
      pushToken: device.expoPushToken,
      title: copy.title,
      body: copy.body,
      // Ids only — `PushData` has no member a coordinate, an address or a
      // phone number could be assigned to, so this is checked by the compiler
      // rather than by review.
      data: {
        kind: payload.kind,
        orderId: payload.orderId,
        orderStatus: payload.orderStatus,
      },
    }));

    // A whole-request failure throws out of here, which is how the job asks
    // BullMQ for a retry. Per-device failures come back as outcomes instead.
    const outcomes = await this.push.send(envelopes);

    const accepted: AcceptedTicket[] = [];
    const unreachable: string[] = [];
    let retryable = 0;

    for (const [index, outcome] of outcomes.entries()) {
      const device = devices[index];
      if (device === undefined) {
        // The port promises index alignment; a sender that broke it would
        // otherwise silently drop the tail of a broadcast.
        this.logger.error('Push outcomes were not aligned with the envelopes sent');
        break;
      }

      switch (outcome.status) {
        case 'accepted':
          accepted.push({ deviceId: device.id, receiptId: outcome.receiptId });
          break;
        case 'unreachable':
          unreachable.push(device.id);
          break;
        case 'retryable':
          retryable += 1;
          break;
        case 'rejected':
          // Ours to fix or an operator's: a malformed message, bad push
          // credentials. Retrying reproduces it exactly, so the job completes
          // and the line is the record. No token, no user id.
          this.logger.error(`Push rejected for kind "${payload.kind}": ${outcome.code}`);
          break;
      }
    }

    await this.tickets.record(accepted);

    for (const deviceId of unreachable) {
      // Immediately, at ticket time — `DeviceNotRegistered` reaches the send
      // path as well as the receipt path, and continuing to push to a dead
      // install is what Apple and Google penalise.
      await this.devices.retireUnreachable(deviceId);
    }

    if (retryable > 0) {
      // Throwing is how a job asks to be retried, and it is right here: the
      // provider asked us to come back. The whole job repeats, including the
      // devices that succeeded — see the note on duplicates above.
      throw new Error(
        `${String(retryable)} of ${String(outcomes.length)} pushes were refused transiently`,
      );
    }
  }

  private parse(rawPayload: DeferredJobPayload): NotifyJobPayload {
    const parsed = notifyJobPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      // A job outliving the code that understood it — a deploy boundary, not
      // an attack. Naming the job rather than dumping the payload keeps a user
      // id out of the log.
      throw new Error(`A "${NOTIFY_JOB}" job carried a payload this release cannot read`);
    }
    return parsed.data;
  }
}
