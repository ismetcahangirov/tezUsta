import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { MEDIA_QUEUE } from './queue.constants';
import type { DeferredJobPayload } from './queue.types';

/**
 * The producer half of the media queue: "process this upload as soon as a
 * media worker is free".
 *
 * Its own service for the reason `ImmediateWorkService` is one: it binds to a
 * different queue, and a feature module asks for the work it means without
 * ever seeing a `Queue`.
 */
@Injectable()
export class MediaWorkService {
  constructor(
    @InjectQueue(MEDIA_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Enqueues `payload` under `name`, de-duplicated on `jobId`.
   *
   * **The id is the caller's, and it is required.** One upload is one piece of
   * work: a confirm that is retried by the client, or two confirms that race,
   * must enqueue it once. BullMQ ignores an `add` whose id is already in the
   * queue, which is that guarantee for free.
   *
   * BullMQ refuses an id containing `:` — its key separator — so one is
   * refused here, loudly, rather than at a distance.
   *
   * Failures are kept as the notifications queue keeps them: the failed set
   * is where "why is this photo stuck" gets its answer.
   *
   * **Except that an enqueue retries a failed job under its id** (#374).
   * BullMQ ignores an `add` under a failed job's id just as under a live
   * one, so a job that gave up without recording why — its last attempt
   * threw before the item was marked failed — would swallow every rescue
   * enqueue after it, and its item would stay pending until a sweep. A
   * caller enqueueing means the work is wanted now, and every job on this
   * queue is idempotent. Retried rather than removed and added again, so the
   * job keeps its id, its options and its stack traces; its attempts start
   * again from zero, and it leaves the failed set while it waits. A completed
   * job is left alone: it ran to the end.
   */
  async enqueue(name: string, payload: DeferredJobPayload, jobId: string): Promise<void> {
    if (jobId.includes(':')) {
      throw new Error(`A media job id must not contain ":" (BullMQ's key separator)`);
    }
    if ((await this.queue.getJobState(jobId)) === 'failed') {
      const failed = await this.queue.getJob(jobId);
      try {
        await failed?.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
      } catch (error) {
        // Retried by a concurrent enqueue, or trimmed from the failed set, in
        // the meantime: the `add` below does nothing for the first and adds the
        // job afresh for the second. Still failed is a real error.
        if ((await this.queue.getJobState(jobId)) === 'failed') {
          throw error;
        }
      }
    }
    await this.queue.add(name, payload, {
      jobId,
      attempts: this.config.queue.jobAttempts,
      backoff: { type: 'exponential', delay: this.config.queue.jobBackoffMs },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 5000 },
    });
  }
}
