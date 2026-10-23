import { Injectable, Logger } from '@nestjs/common';

/**
 * The price of an inspection-priced order was quoted, or the quote approved
 * ([ADR-0060](docs/decisions/ADR-0060-inspection-price-approval.md)).
 *
 * A decline is not one of these. It cancels the order, so it travels as the
 * transition it is, through `OrderNotificationsRegistry`.
 */
export interface OrderPriceEvent {
  readonly kind: 'quoted' | 'approved';
  readonly orderId: string;
  readonly customerId: string;
  readonly masterId: string;
  readonly priceMinor: number;
  /** Null for a quote. */
  readonly priceApprovedAt: Date | null;
  /** Who did it, so neither the socket nor the push tells them about it again. */
  readonly actorUserId: string;
}

export type OrderPriceEventSubscriber = (event: OrderPriceEvent) => Promise<void>;

/**
 * Where `modules/orders` tells the rest of the system that a price moved,
 * without importing the realtime or notifications modules — the same
 * inversion `ConversationEventsRegistry` and `OrderNotificationsRegistry`
 * use, so the arrows keep pointing into `modules/orders` (CLAUDE.md § 14).
 *
 * **A subscriber's failure never undoes the price.** The quote or approval has
 * committed by the time anyone is told, and a socket or queue error is logged
 * and swallowed per subscriber, so one failing does not starve the next.
 */
@Injectable()
export class OrderPriceEventsRegistry {
  private readonly logger = new Logger(OrderPriceEventsRegistry.name);
  private readonly subscribers = new Map<string, OrderPriceEventSubscriber>();

  register(name: string, subscriber: OrderPriceEventSubscriber): void {
    if (this.subscribers.has(name)) {
      throw new Error(`An order price subscriber named ${name} is already registered`);
    }
    this.subscribers.set(name, subscriber);
  }

  async changed(event: OrderPriceEvent): Promise<void> {
    for (const [name, subscriber] of this.subscribers) {
      try {
        await subscriber(event);
      } catch (error) {
        // The order id and the kind, never the amount: a log is not where a
        // price belongs.
        this.logger.warn(
          `Raising ${name} for a ${event.kind} price on order ${event.orderId} failed; the price stands: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
