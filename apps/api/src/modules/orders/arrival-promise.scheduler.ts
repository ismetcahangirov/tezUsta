import { Injectable, Logger } from '@nestjs/common';

import { ArrivalWorkService } from '../../infra/queue/arrival-work.service';
import { ARRIVAL_PROMISE_JOB, arrivalPromiseJobId } from './arrival-promise.job';
import type { ArrivalPromisePayload } from './arrival-promise.job';

/**
 * Asks for one accept's arrival promise (#396, ADR-0055 § 8).
 *
 * **After the accept commits, never inside it**, and **never fatal**: the
 * master won the job the moment the claim committed, and a Redis error here
 * must not tell them otherwise. A failure is logged and swallowed, as
 * `OrderDispatchRegistry.ended()` swallows its own; the recurring sweep is
 * what notices an accept that has no promise a minute later.
 */
@Injectable()
export class ArrivalPromiseScheduler {
  private readonly logger = new Logger(ArrivalPromiseScheduler.name);

  constructor(private readonly work: ArrivalWorkService) {}

  async schedule(accept: { orderId: string; masterId: string; acceptedAt: Date }): Promise<void> {
    const payload: ArrivalPromisePayload = {
      orderId: accept.orderId,
      masterId: accept.masterId,
      acceptedAtMs: accept.acceptedAt.getTime(),
    };

    try {
      await this.work.enqueue(
        ARRIVAL_PROMISE_JOB,
        payload,
        arrivalPromiseJobId(payload.orderId, payload.acceptedAtMs),
      );
    } catch (error) {
      this.logger.warn(
        `Scheduling the arrival promise for order ${accept.orderId} failed; the accept stands and the sweep will retry: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
