import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { MastersService } from '../masters/masters.service';
import type { SubscriptionNotice } from '../subscriptions/subscription-notices.registry';
import { SubscriptionNoticesRegistry } from '../subscriptions/subscription-notices.registry';
import { NotificationsService } from './notifications.service';

/**
 * Turns a subscription notice into a push to the master (#326).
 *
 * Fills `SubscriptionNoticesRegistry` at boot, the way
 * `OrderNotificationsService` fills the orders registry, so the subscriptions
 * module raises a push without knowing a queue exists. It resolves the master
 * into the account behind them and queues one job; the copy, the preference
 * filter and the channel are the delivery worker's.
 *
 * The de-duplication is already done: the subscriptions module claims each
 * notice in its ledger before raising it, so every call here is a push to
 * send.
 */
@Injectable()
export class SubscriptionNotificationsService implements OnModuleInit {
  constructor(
    private readonly registry: SubscriptionNoticesRegistry,
    private readonly masters: MastersService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.registry.register('push', (notice) => this.notify(notice));
  }

  private async notify(notice: SubscriptionNotice): Promise<void> {
    const userId = (await this.masters.findUserIds([notice.masterId])).get(notice.masterId);
    if (userId === undefined) {
      // A deleted profile: there is nobody to tell.
      return;
    }
    await this.notifications.notify({
      userId,
      kind: notice.kind,
      ...(notice.billingPeriod === null ? {} : { billingPeriod: notice.billingPeriod }),
      ...(notice.endsAt === undefined ? {} : { endsAt: notice.endsAt.toISOString() }),
      ...(notice.effectiveFrom === undefined
        ? {}
        : { effectiveFrom: notice.effectiveFrom.toISOString() }),
    });
  }
}
