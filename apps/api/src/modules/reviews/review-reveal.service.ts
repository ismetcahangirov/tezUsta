import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { RecurringWorkService } from '../../infra/queue/recurring-work.service';
import { ReviewsRepository } from './reviews.repository';

/** The deferred job that reveals an order's sealed reviews at window end (#223). */
export const REVIEW_WINDOW_CLOSE_JOB = 'review-window-close';

/** The recurring sweep that reveals whatever the job missed (#223). */
export const REVIEW_WINDOW_SWEEP_JOB = 'maintenance-review-window';

/**
 * How many batches one sweep run may take — the ceiling `maintenance.constants`
 * sets for the retention sweeps, for the same reason: a backlog is worked down
 * across runs rather than in one job that holds a worker for minutes.
 */
const MAX_BATCHES_PER_RUN = 50;

const orderJobPayloadSchema = z.object({ orderId: z.uuid() }).strict();

/** One window-close job per order; dots, because BullMQ reserves `:`. */
export function reviewWindowCloseJobId(orderId: string): string {
  return `${REVIEW_WINDOW_CLOSE_JOB}.${orderId}`;
}

/**
 * Reveals sealed reviews when the review window closes (ADR-0042 § 3, #223).
 *
 * **Two paths to one guarded write.** The deferred job, scheduled from the
 * `COMPLETED` hook in `ReviewTimersService`, is the fast path: it fires when
 * the window ends. The recurring sweep is what makes a lost job — a Redis
 * flush, a deploy at the due time — harmless: it finds every order still
 * holding a sealed review past its window and reveals it. Both go through
 * `ReviewsRepository.revealIfWindowClosed`, which re-checks the window under
 * the order's lock and counts only rows it revealed itself, so running either
 * twice, or both at once, changes nothing the second time.
 *
 * The sweep runs on the maintenance queue at `MAINTENANCE_SWEEP_INTERVAL_MINUTES`
 * and in `MAINTENANCE_BATCH_SIZE` batches, the conventions every other sweep
 * follows; zero disables it and removes a scheduler an earlier release left.
 */
@Injectable()
export class ReviewRevealService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(ReviewRevealService.name);

  constructor(
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly recurring: RecurringWorkService,
    private readonly reviews: ReviewsRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.handlers.register(REVIEW_WINDOW_CLOSE_JOB, async (payload) => {
      await this.closeWindow(payload);
    });
    this.handlers.register(REVIEW_WINDOW_SWEEP_JOB, async () => {
      await this.sweep();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    const minutes = this.config.maintenance.sweepIntervalMinutes;
    if (minutes === 0) {
      await this.recurring.stop(REVIEW_WINDOW_SWEEP_JOB);
      return;
    }
    await this.recurring.every(REVIEW_WINDOW_SWEEP_JOB, minutes * 60_000);
  }

  /** The deferred job: this order's window has (probably) closed. */
  async closeWindow(rawPayload: DeferredJobPayload): Promise<number> {
    const parsed = orderJobPayloadSchema.safeParse(rawPayload);
    if (!parsed.success) {
      // A deploy boundary, not an attack — see `NotificationDeliveryService#parse`.
      throw new Error(
        `A "${REVIEW_WINDOW_CLOSE_JOB}" job carried a payload this release cannot read`,
      );
    }
    return this.reviews.revealIfWindowClosed(parsed.data.orderId, this.config.reviews.windowHours);
  }

  /** The sweep: every order past its window that still holds a sealed review. Returns reviews revealed. */
  async sweep(): Promise<number> {
    const { batchSize } = this.config.maintenance;
    const windowHours = this.config.reviews.windowHours;

    let revealed = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
      const orderIds = await this.reviews.listOrdersPastWindow(windowHours, batchSize);
      if (orderIds.length === 0) {
        break;
      }
      for (const orderId of orderIds) {
        revealed += await this.reviews.revealIfWindowClosed(orderId, windowHours);
      }
      if (orderIds.length < batchSize) {
        break;
      }
    }

    if (revealed > 0) {
      // A count, never an order id: which orders had a lone review is nobody's
      // business in a log line.
      this.logger.log(`Review window: revealed ${String(revealed)} sealed reviews`);
    }
    return revealed;
  }
}
