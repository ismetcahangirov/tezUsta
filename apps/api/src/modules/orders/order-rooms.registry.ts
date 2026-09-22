import { Injectable, Logger } from '@nestjs/common';

/**
 * A committed transition, told to whoever is holding the order's live room.
 *
 * Only the id, because the listener re-reads the row anyway: the point of
 * `RoomsService.revalidate` is that membership is decided from the database as
 * it stands, and handing over `masterId` would invite a comparison against the
 * event instead — a second implementation of "is this person on this order",
 * next to the one that already exists.
 */
export type OrderRoomsListener = (orderId: string) => Promise<void>;

/**
 * Where `modules/realtime` says "tell me when an order moves", without
 * `modules/orders` importing it.
 *
 * **A second registry beside `OrderNotificationsRegistry` rather than a second
 * subscriber inside it.** They look alike and are not the same thing: a
 * notification is a message sent to a person, swallowing failures because a
 * missed push must never undo a committed transition, while this is a
 * *security* consequence — a master who re-dispatched an order must stop
 * hearing it. Merging them would mean one registration call whose two halves
 * have different failure semantics, and `register()` there is deliberately
 * single-subscriber ("registering twice is a programming error rather than a
 * last-one-wins merge"), so adding realtime to it would mean changing that
 * rule for everyone.
 *
 * It keeps the same arrow direction and for the same reason
 * (`order-notifications.registry.ts`): `modules/realtime` reads orders,
 * customers and masters to answer an authorization question, and
 * `modules/masters` already imports `modules/orders`. Raising the other way
 * round would close the loop, and `forwardRef` trades a CI-visible cycle for a
 * runtime-visible one (CLAUDE.md §14).
 *
 * **This is the seam #168 publishes through.** Order events reaching the
 * socket is the next issue, and it wants exactly this signal — the difference
 * is what the listener does with it, not when it fires.
 */
@Injectable()
export class OrderRoomsRegistry {
  private readonly logger = new Logger(OrderRoomsRegistry.name);
  private listener: OrderRoomsListener | undefined;

  /** Registering twice is a programming error, not a last-one-wins merge. */
  register(listener: OrderRoomsListener): void {
    if (this.listener !== undefined) {
      throw new Error('An order rooms listener is already registered');
    }
    this.listener = listener;
  }

  /**
   * Announce a transition that has committed. After the transaction, never
   * inside it — a socket told about a row that then rolls back is a client
   * showing a state the database never reached.
   *
   * **Failures are swallowed and logged at `warn`, and the consequence is
   * worth stating plainly:** if this throws, a master who lost an order can
   * still be sitting in its room until their token expires and the socket
   * closes (`realtime.gateway.ts`, at most the access token's 15 minutes).
   * That is the lesser of the two evils — the alternative is failing a
   * transition the database has already committed, which would leave the
   * client retrying against an edge the order has already left — but it is a
   * residual window rather than none, and #168's own re-check on publish is
   * what will close it.
   */
  async transitioned(orderId: string): Promise<void> {
    if (this.listener === undefined) {
      return;
    }

    try {
      await this.listener(orderId);
    } catch (error) {
      this.logger.warn(
        `Revalidating the live room for order ${orderId} failed; the transition stands: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
