import { Inject, Injectable } from '@nestjs/common';
import { asc, inArray, lte } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { pushTickets } from '../../infra/database/schema/push-tickets';

export interface AcceptedTicket {
  readonly deviceId: string;
  readonly receiptId: string;
}

/** One row of the worklist, as the sweep reads it (#142). */
export interface DueTicket {
  readonly id: string;
  readonly deviceId: string;
  readonly receiptId: string;
}

@Injectable()
export class PushTicketsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Records the receipts issue #142 will ask Expo about.
   *
   * One statement for the whole batch rather than a row at a time: a
   * twenty-master broadcast is one insert, and the round trips it saves are on
   * the notification path a master is waiting on.
   *
   * **`onConflictDoNothing` on the receipt id is what makes a job retry
   * safe.** BullMQ re-delivers a stalled job and retries a failed one, so a
   * job that sent successfully and then failed while writing will come back
   * and present the same receipt ids. Ignoring the duplicate is correct: the
   * receipt is already on the worklist, and a unique violation here would
   * fail a job whose real work is done.
   */
  async record(tickets: readonly AcceptedTicket[]): Promise<void> {
    if (tickets.length === 0) {
      return;
    }

    await this.db
      .insert(pushTickets)
      .values(
        tickets.map((ticket) => ({
          id: uuidV7(),
          deviceId: ticket.deviceId,
          receiptId: ticket.receiptId,
        })),
      )
      .onConflictDoNothing({ target: pushTickets.receiptId });
  }

  /**
   * The tickets old enough that Expo will have an answer (#142).
   *
   * **Bounded, and ordered oldest first.** An unbounded batch over a table
   * that has been accumulating since the last healthy sweep is the job that
   * fills a worker and delays everything behind it — the contention
   * `queue.constants.ts` warns about, arriving from the other direction.
   * Oldest first because those are the ones closest to falling out of Expo's
   * availability window, after which their answer is gone for good.
   *
   * The predicate names only `created_at`, which is exactly what
   * `push_tickets_created_at_idx` was created for: a scan here would read
   * every unresolved receipt in the table to find the ones that are ready
   * (CLAUDE.md §12).
   */
  async findDue(readyBefore: Date, limit: number): Promise<DueTicket[]> {
    return this.db
      .select({
        id: pushTickets.id,
        deviceId: pushTickets.deviceId,
        receiptId: pushTickets.receiptId,
      })
      .from(pushTickets)
      .where(lte(pushTickets.createdAt, readyBefore))
      .orderBy(asc(pushTickets.createdAt), asc(pushTickets.id))
      .limit(limit);
  }

  /**
   * Takes resolved rows off the worklist.
   *
   * A row means "this receipt still needs checking", so resolving it is a
   * delete rather than a flag — keeping resolved rows would turn a bounded
   * worklist into an unbounded delivery log nobody reads, and the delivery
   * record that does matter is the device's own `revoked_at`.
   *
   * Deleting a row that is already gone is a no-op, which is what makes a
   * re-run of the same sweep — after a retry or a redeploy — change nothing
   * the second time.
   */
  async deleteByIds(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const deleted = await this.db
      .delete(pushTickets)
      .where(inArray(pushTickets.id, [...ids]))
      .returning({ id: pushTickets.id });

    return deleted.length;
  }

  /**
   * Drops rows past the window in which Expo would still answer about them.
   *
   * Without this the table grows forever on exactly the rows that can never
   * be resolved: a sweep that was down for a day comes back to receipts the
   * provider has already forgotten, asks about them, gets nothing, and leaves
   * them in place to be asked about again every interval until the end of
   * time.
   */
  async deleteOlderThan(cutoff: Date): Promise<number> {
    const deleted = await this.db
      .delete(pushTickets)
      .where(lte(pushTickets.createdAt, cutoff))
      .returning({ id: pushTickets.id });

    return deleted.length;
  }
}
