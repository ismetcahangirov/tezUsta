import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { DISPATCH_QUEUE } from './queue.constants';
import type { DeferredJobPayload } from './queue.types';

export interface ScheduleOptions {
  /** How long from now the job comes due, in milliseconds. */
  readonly delayMs: number;
  /**
   * A caller-chosen id. Two `schedule` calls with the same id enqueue ONE
   * job — BullMQ ignores the second — which is how "at most one give-up
   * deadline per order" is expressed without a read-then-write race between
   * two API replicas. Omit it and BullMQ assigns a sequence number, so every
   * call enqueues its own job.
   */
  readonly jobId?: string;
}

/**
 * The producer half of the deferred-work mechanism: "run this later".
 *
 * This is the only thing a feature module needs in order to schedule work —
 * it never sees a `Queue`, a connection, or a BullMQ option. That is not
 * politeness; it is what keeps the choice of mechanism reversible. The
 * surface below (`schedule`, `cancel`) is expressible on any queue, so
 * ADR-0025's "revisit when" is a rewrite of this file rather than of every
 * caller.
 */
@Injectable()
export class DeferredWorkService {
  private readonly logger = new Logger(DeferredWorkService.name);

  constructor(
    @InjectQueue(DISPATCH_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Enqueues `payload` to run under `name` after `delayMs`.
   *
   * Returns the job's id, so a caller that did not supply one can still
   * cancel later. `null` is impossible in practice (BullMQ always assigns an
   * id) but is what the vendor type admits, and inventing a non-null
   * assertion to hide that would be a lie about the contract.
   */
  async schedule(
    name: string,
    payload: DeferredJobPayload,
    options: ScheduleOptions,
  ): Promise<string | undefined> {
    const job = await this.queue.add(name, payload, {
      delay: options.delayMs,
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
      attempts: this.config.queue.jobAttempts,
      backoff: { type: 'exponential', delay: this.config.queue.jobBackoffMs },
      // Keep the queue from growing without bound. A completed dispatch tick
      // is of no forensic value; a failed one is, so failures are kept far
      // longer than successes — that is the record of a deadline that never
      // ran, which is the failure this mechanism exists to prevent.
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 1000 },
    });

    return job.id;
  }

  /**
   * Whether `jobId` still names work this queue is going to do.
   *
   * **The question a reconciler asks** (#115): ADR-0025 accepts that a lost
   * Redis means lost deadlines, and the only way to notice a deadline that
   * vanished is to ask after it by id — which is possible at all because the
   * dispatch job ids are deterministic (`dispatch.constants.ts`) rather than
   * sequence numbers.
   *
   * **`false` covers three different things, and deliberately so**: no such
   * job (evicted, flushed, or never enqueued), a job that has already run, and
   * a job that ran out of attempts and is parked in `failed`. The last one is
   * the least obvious and the most important: a give-up deadline that
   * exhausted its retries still *exists* in Redis, and a check that only asked
   * "is there a job with this id" would call that healthy and leave the order
   * searching forever. What the caller needs to know is whether anything is
   * still going to happen, and for all three the answer is no.
   *
   * Verified against the installed `bullmq@6.3.7` rather than from memory
   * (CLAUDE.md §9): `Job.getState()` returns `'completed' | 'failed' |
   * 'active' | 'delayed' | 'prioritized' | 'waiting' | 'waiting-children' |
   * 'unknown'`.
   */
  async isScheduled(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (job === undefined) {
      return false;
    }

    const state = await job.getState();
    return (
      state === 'delayed' ||
      state === 'waiting' ||
      state === 'waiting-children' ||
      state === 'prioritized' ||
      state === 'active'
    );
  }

  /**
   * Removes a scheduled job that is no longer wanted — an order accepted
   * before its give-up deadline, say.
   *
   * Returns `false` when there was nothing to remove, and also when the job
   * is already running: BullMQ refuses to remove a locked job, and that is
   * the correct answer rather than an error. A caller cannot rely on
   * cancellation winning the race, which is why every handler must re-read
   * the order's state before acting — the same rule as
   * `backend-architecture.md` § Background jobs' "jobs carry ids, never whole
   * objects".
   */
  async cancel(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (job === undefined) {
      return false;
    }

    try {
      await job.remove();
      return true;
    } catch (error) {
      this.logger.debug(
        `Deferred job "${jobId}" could not be cancelled (most likely already running): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }
}
