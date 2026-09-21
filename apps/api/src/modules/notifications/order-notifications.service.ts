import { Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';

import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { OrderNotificationsRegistry } from '../orders/order-notifications.registry';
import type {
  OrderBroadcastEvent,
  OrderTransitionEvent,
} from '../orders/order-notifications.registry';
import {
  isNotifiableStatus,
  planOfferNotifications,
  planTransitionNotifications,
} from './order-notification-plan';
import type { PlannedNotification } from './order-notification-plan';
import { NotificationsService } from './notifications.service';

/**
 * What turns an order event into notifications (issue #144).
 *
 * **It fills a slot rather than being called**, registering itself into
 * `OrderNotificationsRegistry` from this module's own `onModuleInit` — the
 * same shape `NotificationDeliveryService` uses for the queue's handler
 * registry, and for the same reason. `modules/orders`, `modules/dispatch`,
 * `modules/masters/offers` and `modules/admin` raise events without importing
 * anything here; this module reads customers and masters to find the accounts
 * behind an order, and `modules/masters` imports `modules/orders`, so a raise
 * wired the other way round would close a cycle (CLAUDE.md §14).
 *
 * **Nothing here sends.** Every path below ends at
 * `NotificationsService.notify`, which puts one job on a queue and returns —
 * so a slow push provider can never slow down an accept a master is waiting
 * on, and a queue having a bad second can never fail a transition the
 * database has already committed.
 */
@Injectable()
export class OrderNotificationsService implements OnModuleInit {
  constructor(
    private readonly registry: OrderNotificationsRegistry,
    private readonly notifications: NotificationsService,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
  ) {}

  onModuleInit(): void {
    this.registry.register(
      (event) => this.onTransition(event),
      (event) => this.onBroadcast(event),
    );
  }

  /**
   * One committed transition becomes zero, one or two notifications.
   *
   * The two profile ids on the order are resolved into the accounts behind
   * them, and `planTransitionNotifications` does the deciding — which is where
   * "nobody is notified of their own action" lives, as one subtraction rather
   * than a condition at each call site.
   *
   * **The status is resolved first and the accounts second.** A transition
   * nothing has words for — the money statuses EPIC 12 owns — costs no reads
   * at all, which matters because every transition in the system arrives here.
   */
  private async onTransition(event: OrderTransitionEvent): Promise<void> {
    if (!isNotifiableStatus(event.to)) {
      return;
    }

    const [customerUserId, masterUserIds] = await Promise.all([
      this.customers.findUserId(event.customerId),
      this.masters.findUserIds(event.masterId === null ? [] : [event.masterId]),
    ]);

    const planned = planTransitionNotifications({
      to: event.to,
      customerUserId,
      masterUserId: event.masterId === null ? undefined : masterUserIds.get(event.masterId),
      actorUserId: event.actorUserId,
    });

    await this.enqueue(planned, event.orderId, event.to);
  }

  /** One wave becomes one notification per master it reached, and no more. */
  private async onBroadcast(event: OrderBroadcastEvent): Promise<void> {
    const userIds = await this.masters.findUserIds(event.masterIds);
    const planned = planOfferNotifications([...userIds.values()]);

    await this.enqueue(planned, event.orderId, undefined);
  }

  /**
   * **One job per recipient**, so one unreachable device does not take the
   * others' delivery and retry semantics with it.
   *
   * Enqueued in parallel because they are independent and `notify` never
   * throws — it logs a queue failure and returns, the one place in this Epic
   * where losing work is the right answer, because the alternative is losing
   * the order instead.
   *
   * **Ids only.** The payload carries the order id and the status and nothing
   * else: an address, a phone number or a coordinate in a notification is
   * readable by whoever is holding the phone, not by whoever owns it
   * (CLAUDE.md §11).
   */
  private async enqueue(
    planned: readonly PlannedNotification[],
    orderId: string,
    orderStatus: string | undefined,
  ): Promise<void> {
    await Promise.all(
      planned.map((notification) =>
        this.notifications.notify({
          userId: notification.userId,
          kind: notification.kind,
          orderId,
          orderStatus,
        }),
      ),
    );
  }
}
