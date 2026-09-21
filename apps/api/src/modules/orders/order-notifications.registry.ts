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
 */
@Injectable()
export class OrderNotificationsRegistry {
  private readonly logger = new Logger(OrderNotificationsRegistry.name);
  private transitionNotifier: OrderTransitionNotifier | undefined;
  private broadcastNotifier: OrderBroadcastNotifier | undefined;

  /**
   * Both slots are filled in one call, so there is no boot ordering in which
   * offers are announced and transitions are not. Registering twice is a
   * programming error rather than a last-one-wins merge, for the reason
   * `DeferredJobHandlerRegistry` gives.
   */
  register(transitions: OrderTransitionNotifier, broadcasts: OrderBroadcastNotifier): void {
    if (this.transitionNotifier !== undefined) {
      throw new Error('An order notifier is already registered');
    }
    this.transitionNotifier = transitions;
    this.broadcastNotifier = broadcasts;
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
   */
  async transitioned(event: OrderTransitionEvent): Promise<void> {
    if (this.transitionNotifier === undefined) {
      return;
    }

    try {
      await this.transitionNotifier(event);
    } catch (error) {
      this.logger.warn(
        `Raising notifications for order ${event.orderId} reaching ${event.to} failed; the transition stands: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Announce a broadcast wave whose offers have committed. Same rules. */
  async broadcast(event: OrderBroadcastEvent): Promise<void> {
    if (this.broadcastNotifier === undefined || event.masterIds.length === 0) {
      return;
    }

    try {
      await this.broadcastNotifier(event);
    } catch (error) {
      this.logger.warn(
        `Raising offer notifications for order ${event.orderId} failed; the offers stand: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
