import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DeferredJobHandlerRegistry } from '../../infra/queue/deferred-job-handler.registry';
import { DeferredWorkService } from '../../infra/queue/deferred-work.service';
import type { DeferredJobPayload } from '../../infra/queue/queue.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OrderNotificationsRegistry } from '../orders/order-notifications.registry';
import type { OrderTransitionEvent } from '../orders/order-notifications.registry';
import { planReviewReminders } from './review-reminder-plan';
import { ReviewsRepository } from './reviews.repository';

/** The deferred job that sends the one review reminder (ADR-0042 § 1, #226). */
export const REVIEW_REMINDER_JOB = 'review-reminder';

/** Ids only (ADR-0025): the job re-reads everything it decides on. */
const orderJobPayloadSchema = z.object({ orderId: z.uuid() }).strict();

/**
 * The job id for an order's reminder. **One per order, and that is the
 * "exactly once"**: BullMQ enqueues one job per id and ignores a second
 * schedule while the first is retained, so a `COMPLETED` event delivered twice
 * cannot queue two reminders. Dots, not colons — BullMQ reserves `:`.
 */
export function reviewReminderJobId(orderId: string): string {
  return `${REVIEW_REMINDER_JOB}.${orderId}`;
}

const HOUR_MS = 3_600_000;

/**
 * The timers a completed order starts for its reviews (issues #226, #223).
 *
 * **One hook point.** This is the only subscriber reviews hold on
 * `OrderNotificationsRegistry`, and `COMPLETED` is the only status it acts on:
 * everything review-shaped that runs on a clock is scheduled from
 * {@link completed}, so the reminder and the window close are two lines in one
 * method rather than two subscribers that could disagree about what
 * "completed" means. The registry swallows a failure here — the transition
 * stands whatever happens to a timer, and the window-close sweep (#223) is
 * what makes a lost timer harmless.
 *
 * **Every job re-decides at run time.** Scheduling records only that an order
 * completed; whether a reminder is still owed — not reviewed, window still
 * open, order still reviewable — is asked of the database when the job runs.
 */
@Injectable()
export class ReviewTimersService implements OnModuleInit {
  constructor(
    private readonly orderEvents: OrderNotificationsRegistry,
    private readonly handlers: DeferredJobHandlerRegistry,
    private readonly work: DeferredWorkService,
    private readonly reviews: ReviewsRepository,
    private readonly notifications: NotificationsService,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.orderEvents.register(
      'reviews',
      (event) => this.transitioned(event),
      // Nothing about a review depends on a broadcast.
      () => Promise.resolve(),
    );
    this.handlers.register(REVIEW_REMINDER_JOB, (payload) => this.remind(payload));
  }

  private async transitioned(event: OrderTransitionEvent): Promise<void> {
    if (event.to !== 'COMPLETED') {
      return;
    }
    await this.completed(event.orderId);
  }

  /** Everything a completed order starts, scheduled together. */
  private async completed(orderId: string): Promise<void> {
    await this.work.schedule(
      REVIEW_REMINDER_JOB,
      { orderId },
      {
        delayMs: this.config.reviews.reminderDelayHours * HOUR_MS,
        jobId: reviewReminderJobId(orderId),
      },
    );
  }

  /**
   * Sends the reminder to each party who still owes a review. Public so an
   * integration test can run the job's decision without waiting a day.
   */
  async remind(rawPayload: DeferredJobPayload): Promise<void> {
    const { orderId } = parsePayload(REVIEW_REMINDER_JOB, rawPayload);

    const context = await this.reviews.findOrderContext(orderId);
    if (context === undefined || context.masterId === null) {
      return;
    }

    const written = await this.reviews.listForOrder(orderId);
    const owed = planReviewReminders({
      status: context.status,
      completedAt: context.completedAt,
      windowHours: this.config.reviews.windowHours,
      now: new Date(),
      reviewedBy: written.map((row) => row.authorRole),
    });

    for (const role of owed) {
      const userId =
        role === 'customer'
          ? await this.customers.findUserId(context.customerId)
          : (await this.masters.findUserIds([context.masterId])).get(context.masterId);
      if (userId === undefined) {
        continue;
      }
      // Order id and kind only (ADR-0042 § 1). The preference filter runs in
      // the delivery worker, so a party who switched `review-reminders` off
      // is dropped there, at send time.
      await this.notifications.notify({ userId, kind: 'review-reminder', orderId });
    }
  }
}

function parsePayload(job: string, rawPayload: DeferredJobPayload): { orderId: string } {
  const parsed = orderJobPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) {
    // A deploy boundary, not an attack — see `NotificationDeliveryService#parse`.
    throw new Error(`A "${job}" job carried a payload this release cannot read`);
  }
  return parsed.data;
}
