import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { MAINTENANCE_QUEUE } from './queue.constants';

/**
 * The producer half of recurring work: "run this every so often, forever",
 * on the {@link MAINTENANCE_QUEUE}.
 *
 * A separate service from `DeferredWorkService` rather than two more methods
 * on it, because the two answer different questions and bind to different
 * queues. `schedule` is "once, later, because something happened"; this is
 * "repeatedly, because time passes". A feature module asks for one or the
 * other and never sees a `Queue`, a connection or a BullMQ option either way,
 * which is what keeps ADR-0025's "revisit when" a rewrite of two files rather
 * than of every caller.
 *
 * **Every replica may call {@link every} for the same id, and should.**
 * BullMQ's job scheduler is an upsert keyed by that id: N replicas calling it
 * leave exactly one scheduler behind, and the job it produces is an ordinary
 * queued job that exactly one worker in the fleet picks up. That is what
 * makes CLAUDE.md §12's "no in-process state two replicas would disagree
 * about" hold for a sweep — no leader election, no `@nestjs/schedule` tick
 * running on every replica at once, and no second mechanism to maintain.
 */
@Injectable()
export class RecurringWorkService {
  private readonly logger = new Logger(RecurringWorkService.name);

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Creates or updates the scheduler for `name`, which then produces one job
   * of that name every `everyMs`.
   *
   * The scheduler id **is** the job name. One recurring job per name is the
   * whole model here — two schedulers producing `maintenance-geocode-cache`
   * would be a configuration accident, never a design — and keying them the
   * same way means the upsert collapses a redeploy's call onto the existing
   * scheduler instead of leaving a second one running beside it.
   *
   * BullMQ delays the first iteration by `everyMs` rather than firing it at
   * once, so a deploy does not touch the database on its way up. That is
   * issue #57's "never runs from application boot", and it is the vendor's
   * behaviour rather than something arranged here — `queue.d.ts` on
   * `bullmq@6.3.7`: "It will also create the first job based on the repeat
   * options and delayed accordingly."
   */
  async every(name: string, everyMs: number): Promise<void> {
    await this.queue.upsertJobScheduler(
      name,
      { every: everyMs },
      {
        name,
        opts: {
          attempts: this.config.queue.jobAttempts,
          backoff: { type: 'exponential', delay: this.config.queue.jobBackoffMs },
          // A completed sweep is of no forensic value and there is one of
          // them every interval, forever; a failed one is the record that
          // retention stopped happening, which is the whole failure this
          // mechanism exists to make visible.
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 500 },
        },
      },
    );
    this.logger.log(
      `Recurring job "${name}" will run every ${String(Math.round(everyMs / 1000))}s`,
    );
  }

  /**
   * Stops a scheduler. Returns `false` when there was none — an expected
   * answer, not an error, since a replica that never scheduled it is entitled
   * to ask.
   */
  async stop(name: string): Promise<boolean> {
    return this.queue.removeJobScheduler(name);
  }

  /**
   * Runs one iteration now, out of band — an operator draining a backlog, and
   * the way an integration test exercises a sweep without waiting out an
   * interval.
   *
   * Deliberately not a scheduler: it adds a single job, so it cannot leave a
   * second recurring schedule behind if it is called twice.
   */
  async runNow(name: string): Promise<void> {
    await this.queue.add(
      name,
      {},
      {
        attempts: this.config.queue.jobAttempts,
        backoff: { type: 'exponential', delay: this.config.queue.jobBackoffMs },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 500 },
      },
    );
  }
}
