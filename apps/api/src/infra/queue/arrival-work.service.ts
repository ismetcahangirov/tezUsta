import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { ARRIVAL_QUEUE } from './queue.constants';
import type { DeferredJobPayload } from './queue.types';

/**
 * Puts arrival-promise work on its own queue (#396, ADR-0055 § 7).
 *
 * **One job per accept, by id**: the caller passes a deterministic id built
 * from the order and its `accepted_at`, so the accept and the backstop sweep
 * asking for the same promise collapse into one job. Correctness never rests
 * on that — the job writes through a conditional `UPDATE` — but it keeps the
 * Routes bill to one request per accept.
 *
 * **A failed job is revived, not ignored**, the shape `MediaWorkService`
 * takes: BullMQ treats `add` with the id of a failed job as a no-op, which
 * would leave an order whose first attempts all failed without a promise
 * however often the sweep asked. Retrying it resets its attempts.
 */
@Injectable()
export class ArrivalWorkService {
  constructor(
    @InjectQueue(ARRIVAL_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async enqueue(name: string, payload: DeferredJobPayload, jobId: string): Promise<void> {
    if (jobId.includes(':')) {
      throw new Error(`An arrival job id must not contain ":" (BullMQ's key separator)`);
    }
    if ((await this.queue.getJobState(jobId)) === 'failed') {
      const failed = await this.queue.getJob(jobId);
      try {
        await failed?.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
      } catch (error) {
        // Retried by a concurrent enqueue, or trimmed from the failed set in
        // the meantime; the `add` below covers both. Still failed is real.
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
      removeOnFail: { count: 1000 },
    });
  }
}
