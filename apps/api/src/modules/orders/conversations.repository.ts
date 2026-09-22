import { Inject, Injectable } from '@nestjs/common';
import type { MessageSenderKind } from '@tezusta/types';
import { and, count, desc, eq, isNull, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { ConversationRow, MessageRow } from '../../infra/database/schema/conversations';
import { conversations, messages } from '../../infra/database/schema/conversations';

/** One page of messages, and the id the next page resumes from. */
export interface MessagePage {
  readonly rows: readonly MessageRow[];
  readonly nextCursorId: string | null;
}

/**
 * `conversations` and `messages` (issues #177, #178).
 *
 * **This module owns both tables because a conversation belongs to an order**
 * ([ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)), exactly as
 * `order_photos` and `order_offers` belong to one. That is not a filing
 * decision — it is what keeps the dependency graph acyclic. The conversation
 * has to be created inside the accept transaction, which lives in
 * `MasterOffersModule`; that module already imports this one, so
 * {@link create} is reachable from it with no new edge and no `forwardRef`
 * (`master-offers.module.ts` explains the direction). A `ConversationsModule`
 * of its own would have had to import `OrdersModule` to answer "who is party
 * to this order?" while `OrdersModule` imported it back to close a
 * conversation on re-dispatch, which `no-circular` does not survive
 * (CLAUDE.md §14).
 */
@Injectable()
export class ConversationsRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Opens the conversation for an order a master has just claimed.
   *
   * **`executor` is not a convenience here, it is the requirement.** The
   * accept path passes its open transaction so that the claim and this row
   * commit together: an `ACCEPTED` order with no conversation is an order
   * whose two parties cannot reach each other and whose only repair is a
   * backfill nobody would notice was needed. `master-offers.repository.ts`
   * makes the same argument for the audit row it writes in the same
   * transaction.
   *
   * **`conversations_one_open_per_order` is what makes "one" true**, not a
   * check performed here. Two accepts arriving together are the ordinary case
   * on ADR-0009's model, and the conditional `UPDATE` above this call already
   * decides which one wins — but relying on that alone would mean this table's
   * integrity depended on a guard in another module's SQL staying correct. The
   * partial unique index is the guarantee; it raises, the transaction unwinds,
   * and the loser is reported as having lost.
   */
  async create(
    input: { readonly orderId: string; readonly masterId: string },
    executor: DatabaseExecutor = this.db,
  ): Promise<ConversationRow> {
    const [row] = await executor
      .insert(conversations)
      .values({ id: uuidV7(), orderId: input.orderId, masterId: input.masterId })
      .returning();

    // `returning()` on a single-row insert that did not throw. Narrowing rather
    // than asserting, because the type says the array may be empty and a
    // non-null assertion would be a claim the compiler cannot check.
    if (row === undefined) {
      throw new Error('conversation insert returned no row');
    }
    return row;
  }

  /**
   * Closes the order's open conversation, if it has one.
   *
   * Called from the re-dispatch transaction (`orders.repository.ts#redispatch`)
   * — the one event that ends a conversation, because the master who held the
   * job has given it up and `orders.master_id` is about to become null.
   *
   * **Idempotent, and conditional on being open.** The `WHERE closed_at is
   * null` is not decoration: without it a second call would re-stamp the
   * timestamp and move the moment the channel closed, and the partial unique
   * index would stop protecting anything. Returns nothing, because a
   * re-dispatch of an order that somehow has no open conversation is not an
   * error worth unwinding a transaction for — the next accept will open one.
   */
  async closeForOrder(
    orderId: string,
    closedAt: Date,
    executor: DatabaseExecutor = this.db,
  ): Promise<void> {
    await executor
      .update(conversations)
      .set({ closedAt })
      .where(and(eq(conversations.orderId, orderId), isNull(conversations.closedAt)));
  }

  /** The order's current conversation, or `undefined` if it has none open. */
  async findOpenByOrderId(orderId: string): Promise<ConversationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(conversations)
      .where(and(eq(conversations.orderId, orderId), isNull(conversations.closedAt)));
    return row;
  }

  /**
   * How many messages in this conversation the given side has not read.
   *
   * Counts the messages the **other** side wrote, which is what "unread" means
   * to one party. Served by `messages_unread_idx`, the partial index over
   * unread rows only — so this touches a handful of rows in a healthy
   * conversation rather than the whole transcript, which is why there is no
   * counter column to be kept correct by every future writer.
   */
  async countUnreadFor(conversationId: string, reader: MessageSenderKind): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderKind, otherSide(reader)),
          isNull(messages.readAt),
        ),
      );
    return row?.value ?? 0;
  }

  /**
   * One page of a conversation, newest first, resumed after `afterMessageId`.
   *
   * **Keyset, not offset** — and this is the surface where offset would fail
   * most visibly: a conversation grows at the tail *while it is being read
   * back*, so `OFFSET 30` would skip or repeat a message every time the other
   * party wrote during a scroll.
   *
   * **The cursor's position is resolved in SQL, from the row it names.** A
   * `timestamptz` holds microseconds and a JavaScript `Date` holds
   * milliseconds, so a cursor that carried the timestamp would truncate it and
   * silently drop any row written in the same millisecond but a few
   * microseconds earlier (`message-cursor.ts` sets out the whole argument).
   * The subquery is scoped to the same conversation, so a well-formed cursor
   * naming somebody else's message finds nothing and yields an empty page
   * rather than a row from a conversation the caller is not party to.
   *
   * `(created_at, id) < (…)` is a row-value comparison, which is exactly the
   * ordering `messages_conversation_created_idx` is built to serve.
   *
   * Reads one row more than asked for and drops it. That extra row is how the
   * next cursor is known to exist without a second query — a page that
   * returned a cursor by guessing would hand a client an empty final page.
   */
  async listMessages(input: {
    readonly conversationId: string;
    readonly limit: number;
    readonly afterMessageId: string | null;
  }): Promise<MessagePage> {
    const { conversationId, limit, afterMessageId } = input;

    const rows = await this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          afterMessageId === null
            ? undefined
            : sql`(${messages.createdAt}, ${messages.id}) < (
                select ${messages.createdAt}, ${messages.id}
                  from ${messages}
                 where ${messages.id} = ${afterMessageId}
                   and ${messages.conversationId} = ${conversationId}
              )`,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page.at(-1);

    return {
      rows: page,
      nextCursorId: rows.length > limit && last !== undefined ? last.id : null,
    };
  }

  /** One message, for the read-receipt endpoint to locate what it was pointed at. */
  async findMessageById(messageId: string): Promise<MessageRow | undefined> {
    const [row] = await this.db.select().from(messages).where(eq(messages.id, messageId));
    return row;
  }

  /** Appends a message. The id and the timestamp are the server's, never the client's. */
  async append(input: {
    readonly conversationId: string;
    readonly senderKind: MessageSenderKind;
    readonly body: string;
  }): Promise<MessageRow> {
    const [row] = await this.db
      .insert(messages)
      .values({
        id: uuidV7(),
        conversationId: input.conversationId,
        senderKind: input.senderKind,
        body: input.body,
      })
      .returning();

    if (row === undefined) {
      throw new Error('message insert returned no row');
    }
    return row;
  }

  /**
   * Marks every message the other side sent at or before the one named as
   * read, and returns how many that changed.
   *
   * **Bounded by a row, not by "everything", and it never un-reads.**
   * `read_at is null` in the predicate is what makes a late or duplicated
   * receipt a no-op rather than a re-stamp — `messages_is_write_once` refuses
   * the re-stamp outright, and this clause is what stops an honest retry
   * reaching it. The bound is the named message's own `(created_at, id)`, so a
   * receipt that raced a newly arrived message cannot acknowledge something
   * the reader never saw.
   *
   * **The bound is resolved in SQL rather than passed in as a `Date`**, for
   * the precision reason `listMessages` and `message-cursor.ts` set out: a
   * timestamp that has been through JavaScript is truncated to milliseconds,
   * and a bound that sits microseconds *before* the row it names marks nothing
   * at all — an unread badge that quietly refuses to clear.
   */
  async markReadThrough(input: {
    readonly conversationId: string;
    readonly reader: MessageSenderKind;
    readonly throughMessageId: string;
    readonly readAt: Date;
  }): Promise<number> {
    const { conversationId, reader, throughMessageId, readAt } = input;

    const updated = await this.db
      .update(messages)
      .set({ readAt })
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.senderKind, otherSide(reader)),
          isNull(messages.readAt),
          sql`(${messages.createdAt}, ${messages.id}) <= (
            select ${messages.createdAt}, ${messages.id}
              from ${messages}
             where ${messages.id} = ${throughMessageId}
               and ${messages.conversationId} = ${conversationId}
          )`,
        ),
      )
      .returning({ id: messages.id });

    return updated.length;
  }
}

/**
 * The side that did not write a message is the side that reads it. A
 * conversation has exactly two parties (ADR-0033 puts group conversations out
 * of scope), which is what makes "the other one" a total function.
 */
function otherSide(side: MessageSenderKind): MessageSenderKind {
  return side === 'customer' ? 'master' : 'customer';
}
