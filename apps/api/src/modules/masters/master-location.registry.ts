import { Injectable, Logger } from '@nestjs/common';

/**
 * One position that has **already been recorded**, as the master's app sent it.
 *
 * Coordinates rather than a row id, because the consumer publishes them and a
 * second read of `master_locations` to fetch what the writer already held
 * would be a query on the hottest path in the system.
 *
 * `recordedAt` is the database's own timestamp for the row, not the moment
 * this event was raised — it is what the customer's map shows the point's age
 * from, and two API instances must not disagree about it.
 *
 * There is no accuracy field, and that is not an omission here: the ingest
 * contract has none. `reportLocationSchema` is `.strict()` over
 * `{ latitude, longitude }` and deliberately refuses a client that invents
 * `accuracy` (#98), so there is no accuracy to carry. A nullable field that
 * could never be non-null would be a lie in the contract rather than a
 * placeholder.
 */
export interface MasterPositionReported {
  readonly masterId: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly recordedAt: Date;
}

export type MasterPositionListener = (event: MasterPositionReported) => Promise<void>;

/**
 * Where `modules/realtime` says "tell me when a master reports a position",
 * without `modules/masters` importing it (issue #169).
 *
 * **The arrow has to point this way.** `modules/realtime` reads masters,
 * customers and orders to answer an authorization question
 * (`room-authorizer.ts`), so it imports `modules/masters`. Raising the fan-out
 * the other way round would close that loop, and `forwardRef` trades a
 * CI-visible cycle for a runtime-visible one (CLAUDE.md §14). The same
 * reasoning, and the same shape, as `order-rooms.registry.ts` and
 * `order-notifications.registry.ts`.
 *
 * It also puts "a fan-out may never fail a report" in one place. The position
 * is in the table and presence is refreshed; whether a customer's map moved is
 * a consequence. A Redis hiccup here must not turn a recorded position into a
 * 500 that a master's app will retry — which would write the movement twice
 * and still show the customer nothing.
 *
 * **No coordinate reaches a log line, here or anywhere below** (CLAUDE.md §11).
 * The failure log names the master id and the error, never the point.
 */
@Injectable()
export class MasterLocationRegistry {
  private readonly logger = new Logger(MasterLocationRegistry.name);
  private listener: MasterPositionListener | undefined;

  /** Registering twice is a programming error, not a last-one-wins merge. */
  register(listener: MasterPositionListener): void {
    if (this.listener !== undefined) {
      throw new Error('A master position listener is already registered');
    }
    this.listener = listener;
  }

  /**
   * Announce a position that has been written.
   *
   * With no listener registered there is nothing to fan out and nothing to
   * log — a deployment can legitimately run the API without the socket.
   */
  async reported(event: MasterPositionReported): Promise<void> {
    if (this.listener === undefined) {
      return;
    }

    try {
      await this.listener(event);
    } catch (error) {
      this.logger.warn(
        `Fanning out a position for master ${event.masterId} failed; the report stands: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
