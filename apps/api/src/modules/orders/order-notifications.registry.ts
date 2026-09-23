import { Injectable, Logger } from '@nestjs/common';
import type { OrderStatus } from '@tezusta/types';

/**
 * One order transition that has **already committed**, as the parties to it
 * would describe it.
 *
 * Profile ids rather than account ids, because that is what an order row
 * holds. Turning them into the accounts behind them is the notification
 * module's work — `modules/orders` does not get to learn what a push token is,
 * and `modules/notifications` does not get to learn what an order edge is.
 */
export interface OrderTransitionEvent {
  readonly orderId: string;
  /** `orders.customer_id`. */
  readonly customerId: string;
  /**
   * `orders.master_id` **on the committed row**, which is not always the
   * master who acted: a re-dispatch clears the column in the same transaction
   * that records the master who dropped the job.
   */
  readonly masterId: string | null;
  /** The status the transaction actually landed on, never the one asked for. */
  readonly to: OrderStatus;
  /**
   * `orders.price_minor` **on the committed row** — minor units, null until a
   * master accepts and null again after a re-dispatch clears it
   * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)).
   *
   * Carried for the realtime subscriber (#168): the accept is the transition
   * the customer is waiting on, and the frozen price is the fact it delivers.
   * The notification subscriber ignores it — a push carries ids and a status
   * and nothing a lock screen should not show.
   */
  readonly priceMinor: number | null;
  /**
   * The account that performed it, when one did.
   *
   * `undefined` for an admin override and for anything the system did — which
   * is what makes "nobody is notified of their own action" reduce to removing
   * this id from the recipients. An admin is never in that set to begin with.
   */
  readonly actorUserId: string | undefined;
}

/** One broadcast wave that has already committed its offers. */
export interface OrderBroadcastEvent {
  readonly orderId: string;
  /** `masters.id` for every master this wave actually reached. */
  readonly masterIds: readonly string[];
}

export type OrderTransitionNotifier = (event: OrderTransitionEvent) => Promise<void>;
export type OrderBroadcastNotifier = (event: OrderBroadcastEvent) => Promise<void>;

/**
 * One consumer's pair of callbacks, under the name it registered with.
 *
 * The name is not decoration: it is what a failure is logged against, so an
 * operator reading "raising order events failed" can tell a push provider
 * having a bad minute from a socket that is not publishing.
 */
interface OrderEventSubscriber {
  readonly name: string;
  readonly transitions: OrderTransitionNotifier;
  readonly broadcasts: OrderBroadcastNotifier;
}

/**
 * Where the notification module says "tell me when an order moves, and when a
 * wave goes out", without `modules/orders` importing it.
 *
 * **This exists to keep one arrow pointing one way**, exactly as
 * `OrderDispatchRegistry` does and for the same reason. `modules/dispatch`,
 * `modules/masters/offers` and `modules/admin` all import `modules/orders`
 * already; the notification module has to read customers and masters to find
 * the accounts behind an order, and `modules/masters` imports
 * `modules/orders`. Wiring the raise the other way round would close that
 * loop, and `forwardRef` is not the answer — it trades a CI-visible cycle for
 * a runtime-visible one (CLAUDE.md §14).
 *
 * It also puts the "a notification may never fail a transition" rule in one
 * place. The order moved; the push is a consequence. Both methods below
 * swallow and log, so no call site has to remember to.
 *
 * **More than one consumer may subscribe, and each is isolated from the
 * others** (issue #168). A push and a socket frame are two deliveries of one
 * fact, and `modules/realtime` is a second consumer of exactly the events
 * already published here — so it arrives the same way rather than teaching
 * `modules/orders` what a socket is. A single slot would have meant either a
 * second registry carrying the same payload or the notification service
 * forwarding to the gateway, which is the import this class exists to prevent.
 *
 * Registering the **same name** twice is still a programming error, for the
 * reason `DeferredJobHandlerRegistry` gives — what is gone is the accident of
 * a second consumer silently replacing the first, not the check.
 */
@Injectable()
export class OrderNotificationsRegistry {
  private readonly logger = new Logger(OrderNotificationsRegistry.name);
  private readonly subscribers = new Map<string, OrderEventSubscriber>();

  /**
   * Both slots are filled in one call, so there is no boot ordering in which
   * offers are announced and transitions are not.
   *
   * @param name What this consumer is called in a failure log — `'push'`,
   *   `'realtime'`. Unique; registering it twice throws.
   */
  register(
    name: string,
    transitions: OrderTransitionNotifier,
    broadcasts: OrderBroadcastNotifier,
  ): void {
    if (this.subscribers.has(name)) {
      throw new Error(`An order notifier named ${name} is already registered`);
    }
    this.subscribers.set(name, { name, transitions, broadcasts });
  }

  /**
   * Announce a transition that has committed.
   *
   * **Call this after the transaction, never inside it.** A job enqueued in a
   * transaction that then rolls back tells a customer their order was accepted
   * when it was not, and BullMQ has no idea the database changed its mind.
   *
   * **Failures are swallowed, and here that is the whole point.** A master has
   * just been told they won a job, or a customer that theirs is cancelled;
   * turning a Redis hiccup into a 500 would deny a transition the database has
   * already committed, and the client's retry would then fail on an edge the
   * order has already left. Logged at `warn` rather than `error`: a missed
   * push is a real cost, but it is not damage to the order.
   *
   * With no notifier registered there is nothing to say and nothing to log —
   * a deployment can legitimately run without one, unlike a dispatch engine.
   *
   * **Every subscriber is attempted, whatever the others did.** One throwing
   * must not cost the other its delivery: a push provider having a bad minute
   * would otherwise silence the socket too, and the two failures have nothing
   * to do with each other.
   */
  async transitioned(event: OrderTransitionEvent): Promise<void> {
    await this.each(
      (subscriber) => subscriber.transitions(event),
      (name, message) =>
        `Raising ${name} for order ${event.orderId} reaching ${event.to} failed; the transition stands: ${message}`,
    );
  }

  /** Announce a broadcast wave whose offers have committed. Same rules. */
  async broadcast(event: OrderBroadcastEvent): Promise<void> {
    if (event.masterIds.length === 0) {
      return;
    }

    await this.each(
      (subscriber) => subscriber.broadcasts(event),
      (name, message) =>
        `Raising ${name} offers for order ${event.orderId} failed; the offers stand: ${message}`,
    );
  }

  /**
   * Runs one raise against every subscriber, swallowing each failure on its
   * own.
   *
   * Sequential rather than `Promise.all`, and deliberately: both consumers
   * hand work off rather than doing it — the notifier enqueues, the gateway
   * publishes — so there is nothing to overlap, and a sequential loop keeps
   * the order of deliveries the same on every run, which is one less thing for
   * a flaky test to be about.
   */
  private async each(
    raise: (subscriber: OrderEventSubscriber) => Promise<void>,
    describe: (name: string, message: string) => string,
  ): Promise<void> {
    for (const subscriber of this.subscribers.values()) {
      try {
        await raise(subscriber);
      } catch (error) {
        this.logger.warn(
          describe(subscriber.name, error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }
}
