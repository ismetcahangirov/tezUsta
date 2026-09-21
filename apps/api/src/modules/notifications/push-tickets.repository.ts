import { Inject, Injectable } from '@nestjs/common';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { pushTickets } from '../../infra/database/schema/push-tickets';

export interface AcceptedTicket {
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
}
