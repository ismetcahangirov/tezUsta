import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { NOTIFICATIONS_QUEUE } from './queue.constants';
import type { DeferredJobPayload } from './queue.types';

/**
 * The producer half of the notifications queue: "do this **now**, but not on
 * the request's thread".
 *
 * A third service rather than a third method on `DeferredWorkService`, for the
 * reason `RecurringWorkService` is separate from it: the three answer
 * different questions and bind to different queues. `schedule` is "once,
 * later, because something happened"; `every` is "repeatedly, because time
 * passes"; this is "as soon as a worker is free, because somebody has to be
 * told". A feature module asks for one of the three and never sees a `Queue`,
 * a connection or a BullMQ option, which is what keeps ADR-0025's "revisit
 * when" a rewrite of three files rather than of every caller.
 *
 * **Nothing here is delayed**, and that is the point of the separate service
 * rather than `schedule(..., { delayMs: 0 })`: a delay of zero still enters
 * the delayed set and waits for a worker to promote it, which is latency
 * bought for nothing on the one queue whose whole job is to be quick.
 */
@Injectable()
export class ImmediateWorkService {
  constructor(
    @InjectQueue(NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Enqueues `payload` to run under `name` as soon as a worker takes it.
   *
   * **`removeOnFail` is the dead-letter story, and it is deliberately large.**
   * A job that exhausts `QUEUE_JOB_ATTEMPTS` stays in the failed set with its
   * payload and its error, so "the master was never told about that offer" is
   * a question with an answer rather than a silence. A completed push is of no
   * forensic value and there are a great many of them, so successes are kept
   * only shallowly — the same asymmetry `DeferredWorkService` applies, for the
   * same reason.
   *
   * No `jobId` is passed. Two notifications about two different things are two
   * jobs, and collapsing them on a caller-chosen id is a de-duplication policy
   * this layer has no basis to invent — the dispatch queue's deterministic ids
   * exist because a deadline is genuinely one thing per order.
   */
  async enqueue(name: string, payload: DeferredJobPayload): Promise<string | undefined> {
    const job = await this.queue.add(name, payload, {
      attempts: this.config.queue.jobAttempts,
      backoff: { type: 'exponential', delay: this.config.queue.jobBackoffMs },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 5000 },
    });

    return job.id;
  }
}
