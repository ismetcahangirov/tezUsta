import { Injectable, Logger } from '@nestjs/common';

import { ImmediateWorkService } from '../../infra/queue/immediate-work.service';
import type { NotificationRequest } from './notification.types';

/** The job name this module registers a handler for. */
export const NOTIFY_JOB = 'notify';

/**
 * What every other module calls to have somebody told something.
 *
 * **The whole public surface is {@link notify}, and it never sends.** It puts
 * one job on the notifications queue and returns. The Epic's own requirement
 * is that a slow push provider must not slow down an order acceptance, and the
 * only way to guarantee that is for the request path to have no way of
 * reaching the network at all.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly work: ImmediateWorkService) {}

  /**
   * Queue one notification for one person.
   *
   * **One job per recipient, never one job per broadcast.** A single job
   * fanning out to twenty masters fails as a unit, so one unreachable device
   * would cost the other nineteen their delivery and their retry semantics.
   *
   * **Never call this inside a transaction.** A job enqueued in a transaction
   * that then rolls back tells a customer their order was accepted when it was
   * not — BullMQ has no idea the database changed its mind. Issue #144 owns
   * the call sites and the after-commit ordering; this method is where the
   * rule is written down.
   *
   * **It does not throw.** The order moved; the push is a consequence. A queue
   * having a bad second must not turn an accept a master is waiting on into a
   * 500, so a failure to enqueue is logged and swallowed — the one place in
   * this module where losing work is the right answer, because the alternative
   * loses the order instead.
   */
  async notify(request: NotificationRequest): Promise<void> {
    try {
      await this.work.enqueue(NOTIFY_JOB, { ...request });
    } catch (error) {
      this.logger.error(
        `Could not queue a "${request.kind}" notification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
