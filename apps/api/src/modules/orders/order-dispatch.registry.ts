import { Injectable, Logger } from '@nestjs/common';

/**
 * What an order that has just entered `SEARCHING` needs done to it: a search
 * scheduled.
 *
 * An interface rather than a class reference, because the point of this file
 * is that `modules/orders` never learns what dispatch is.
 */
export type OrderSearchStarter = (orderId: string) => Promise<void>;

/**
 * What an order that has just **left** `SEARCHING` needs done to it: the rest
 * of its schedule dropped.
 *
 * Takes the order id and nothing else, exactly like {@link OrderSearchStarter}
 * — which search is being ended is a fact the engine derives from the order's
 * own audit trail, and a caller that had to pass a generation would be a
 * caller that knows what a dispatch schedule is keyed by.
 */
export type OrderSearchEnder = (orderId: string) => Promise<void>;

/**
 * Where the dispatch engine says "tell me when an order starts searching, and
 * when it stops", without `modules/orders` importing it.
 *
 * **This exists to keep one arrow pointing one way.** The dispatch engine has
 * to read orders, transition them and write their audit trail, so it depends
 * on `modules/orders`; if `modules/orders` also called the engine directly,
 * the two modules would import each other and `no-circular` would fail the
 * build (CLAUDE.md §14) — with `forwardRef` as the only escape, which trades a
 * CI-visible cycle for a runtime-visible one. The same shape as
 * `ReadinessCheckRegistry` and `DeferredJobHandlerRegistry`, and for the same
 * reason: the lower layer offers a slot, the upper layer fills it.
 *
 * It is also what makes the engine **re-entrant**. EPIC 8 starts a fresh
 * dispatch by transitioning an order back to `SEARCHING` and announcing it
 * here, exactly as creation does — never by reaching into a private helper on
 * the engine (issue #103).
 */
@Injectable()
export class OrderDispatchRegistry {
  private readonly logger = new Logger(OrderDispatchRegistry.name);
  private starter: OrderSearchStarter | undefined;
  private ender: OrderSearchEnder | undefined;

  /**
   * Registering twice is a programming error rather than a last-one-wins
   * merge, for the reason `DeferredJobHandlerRegistry` gives: two engines
   * both believing they own dispatch would produce behaviour that depends on
   * module import order.
   *
   * Both slots are filled in one call, so there is no boot ordering in which
   * an engine owns half of dispatch — an order could otherwise be announced as
   * searching by an engine that had no way of being told the search had ended.
   */
  register(starter: OrderSearchStarter, ender: OrderSearchEnder): void {
    if (this.starter !== undefined) {
      throw new Error('A dispatch engine is already registered');
    }
    this.starter = starter;
    this.ender = ender;
  }

  /**
   * Announces that `orderId` is now `SEARCHING`.
   *
   * **Failures are swallowed, and that is deliberate.** The order is already
   * committed as `SEARCHING`; throwing here would fail the customer's request
   * for an order that genuinely exists, and the retry would collide with its
   * own idempotency key. What it must not do is hide: with no engine
   * registered — or one that threw — the order would search with nothing
   * scheduled, which is the failure issue #103 names first, so it is logged at
   * error level rather than debug.
   *
   * **The log is the only trace, and that is a known gap**: nothing yet
   * notices an order left `SEARCHING` with no schedule and re-drives it.
   * ADR-0025 names that reconciliation, and it is issue #115.
   */
  async started(orderId: string): Promise<void> {
    if (this.starter === undefined) {
      this.logger.error(
        `Order ${orderId} entered SEARCHING with no dispatch engine registered — nothing will broadcast it, and nothing will end its search`,
      );
      return;
    }

    try {
      await this.starter(orderId);
    } catch (error) {
      this.logger.error(
        `Scheduling dispatch for order ${orderId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Announces that `orderId` has stopped searching, so the rest of its
   * schedule can be dropped (issue #120).
   *
   * **This is an optimisation and never a correctness mechanism**, which is
   * what makes every line below safe. Each remaining tick already guards on
   * the database — the wave insert carries `exists (... status = 'SEARCHING')
   * for share`, and the give-up is a conditional `UPDATE` — so a schedule that
   * survives this call costs a few pointless reads and writes nothing. Nothing
   * may start depending on the cancellation having happened.
   *
   * **Failures are swallowed for a stronger reason than {@link started}'s.**
   * The caller here has already committed a transition somebody is acting on:
   * a master has won a job and is on their way. Turning a Redis hiccup into a
   * 500 would tell them they did not get the job they did get, and the retry
   * would answer `ORDER_ALREADY_TAKEN` — naming them as the master who beat
   * them to it. Logged at `warn` rather than `error`: it is waste rather than
   * damage, and every tick it fails to cancel is still a no-op.
   *
   * With no engine registered there is nothing to cancel and nothing to say —
   * {@link started} has already logged that loudly for this order, and it is
   * the call that actually needed one.
   */
  async ended(orderId: string): Promise<void> {
    if (this.ender === undefined) {
      return;
    }

    try {
      await this.ender(orderId);
    } catch (error) {
      this.logger.warn(
        `Cancelling the dispatch schedule for order ${orderId} failed; its remaining ticks will run and write nothing: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
