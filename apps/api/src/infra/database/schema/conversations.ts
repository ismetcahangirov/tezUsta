import type { MessageSenderKind } from '@tezusta/types';
import { relations, sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { masters } from './masters';
import { orders } from './orders';

/**
 * Which side of the order wrote a message.
 *
 * A Postgres enum for the reason `order_status` is one: the set is closed and
 * the database should refuse a typo rather than store it. Not reusing
 * `order_actor_kind` even though its first two values are the same string —
 * that enum contains `admin` and `system`, and an enum permitting an actor who
 * may never write here would make the column say something the product does
 * not mean (see `MessageSenderKind` in `packages/types`).
 */
export const messageSenderKind = pgEnum('message_sender_kind', ['customer', 'master']);

/**
 * The written channel between the two parties to one order
 * ([ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)).
 *
 * **There is no membership table, and that is the point of the design.** A row
 * here names an order and the master who held it; who may read it is therefore
 * "this order's customer, or this order's currently assigned master", which
 * `orders` already answers. A conversation scoped to a *pair* of people would
 * have needed its own answer to that question, and would have had no moment at
 * which it ended.
 *
 * **`master_id` is stored even though `orders.master_id` exists**, because the
 * two stop agreeing exactly when it matters: re-dispatch sets `orders.master_id`
 * back to null (`orders.ts`), and a conversation that read its second party
 * from the order would lose the identity of the master who actually wrote half
 * of it. The column is the record of who this conversation *was* with, and it
 * is never updated after insert.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey(),

    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    /**
     * The master this conversation is with. Never null and never updated — see
     * the note on the table. `restrict` for the reason every other reference to
     * a master carries it: a transcript that outlived one of its authors would
     * be evidence with a hole in it.
     */
    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),

    /**
     * When this stopped being the order's *current* conversation, which happens
     * on exactly one event: re-dispatch. The master who held the job gave it
     * up, and the channel to the customer goes with it.
     *
     * **This is not "can no longer be written to", and conflating the two would
     * put the same rule in two places.** Whether a conversation accepts a
     * message is a question about the order's current status — ADR-0033 § 2
     * makes it read-only at a terminal status — and that is derived on every
     * request rather than stored, so no future terminal transition has to
     * remember to come back here and set a flag. A cancelled order's
     * conversation is unwritable with `closed_at` still null, and that is
     * correct.
     */
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * **One open conversation per order, enforced by the database.**
     *
     * Partial rather than a plain unique index on `order_id`: an order that is
     * re-dispatched and accepted again gets a *second* conversation (ADR-0033
     * § 2), so the column cannot be globally unique — but two conversations
     * open on one order at the same time is a state nothing can interpret, and
     * "check then insert" is precisely the race the accept path exists to
     * avoid. This index makes the second insert fail instead.
     */
    uniqueIndex('conversations_one_open_per_order')
      .on(table.orderId)
      .where(sql`${table.closedAt} is null`),

    /**
     * The order's conversations, newest first — the read behind "show me this
     * order's transcript", including the closed ones a dispute may need.
     */
    index('conversations_order_created_idx').on(table.orderId, sql`${table.createdAt} desc`),

    /** The foreign key Postgres does not index on its own. */
    index('conversations_master_idx').on(table.masterId),
  ],
);

/**
 * One message in a conversation.
 *
 * **Untrusted free text, bounded here as well as in the request schema**, for
 * the reason `orders.description` gives: Zod runs on the request path only,
 * and a column with no bound is a column a seed, a migration or tomorrow's
 * admin tool can fill with a megabyte. Two thousand characters matches
 * `orders.description` — a customer describing a problem and a customer
 * describing it again in a message are the same kind of text.
 *
 * **Write-once, enforced by a trigger installed in the migration** rather than
 * by convention. ADR-0033 puts message editing and deletion out of scope and
 * keeps the transcript for disputes; a transcript the application merely
 * promises not to rewrite is only as safe as every future query, migration and
 * admin console. `read_at` is the single exception — a receipt is a real
 * update to a real row — and the trigger permits exactly that column, exactly
 * once.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),

    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),

    /**
     * Which side wrote it. **Not a user id**, and the absence is deliberate:
     * the conversation already knows both parties, one human may hold both
     * roles, and a column naming the account would invite a read that returns
     * a stranger's user id to the other party.
     */
    senderKind: messageSenderKind('sender_kind').notNull(),

    body: text('body').notNull(),

    /**
     * When the *recipient* read it. Null until they do.
     *
     * One nullable timestamp rather than a per-party read cursor, because a
     * conversation has exactly two parties and a message has exactly one
     * recipient: the side that did not write it. A group conversation would
     * need the cursor, and ADR-0033 puts group conversations out of scope.
     */
    readAt: timestamp('read_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * **The history page, and the reason it is O(page).**
     *
     * The keyset cursor is `(created_at, id)` (`message-cursor.ts`), so `id`
     * is the third column for exactly the reason `orders_customer_created_idx`
     * carries it: without it Postgres fetches every row older than the cursor
     * and top-N sorts them, and the cost of reading back through a long
     * conversation grows with how long the conversation is. Descending,
     * because a chat is read newest-first.
     *
     * **Written as `sql` rather than `.desc()`, and that is not a style
     * choice.** Drizzle's `.desc()` emits `DESC NULLS LAST` in an index, while
     * a bare `ORDER BY created_at DESC` means `DESC NULLS FIRST` — so the two
     * orderings do not match and Postgres cannot use the index to avoid the
     * sort. Measured on 5,000 rows with only the `NULLS LAST` index present:
     * a sequential scan plus a `Sort`. With a plain `DESC` index and the same
     * query: an index-only scan and no sort at all. The columns are `NOT
     * NULL`, so nothing about the data changes either way — only whether the
     * index is usable. Asserted by the `EXPLAIN` in
     * `test/order-conversation.e2e.test.ts`, because nothing else notices.
     */
    index('messages_conversation_created_idx').on(
      table.conversationId,
      sql`${table.createdAt} desc`,
      sql`${table.id} desc`,
    ),

    /**
     * **The unread count, and the reason it is not a stored counter.**
     *
     * Partial on the unread rows only, so counting what one party has not read
     * touches an index holding just those — which in a healthy conversation is
     * a handful of rows, not the whole transcript. A counter column would have
     * to be kept correct by every writer of both tables, and the first one to
     * forget would make the badge wrong forever with nothing to notice it by
     * (`orders.photo_count` carries exactly that debt, and says so).
     */
    index('messages_unread_idx')
      .on(table.conversationId, table.senderKind)
      .where(sql`${table.readAt} is null`),

    /**
     * **Either no text at all, or real text within the bound** (issue #181).
     *
     * The empty string is the photo sent on its own: a message whose content
     * is its attachments. What the CHECK still refuses is the thing #178
     * refused it for — a body of whitespace, which renders as an empty
     * bubble. Whether an empty body really does carry a photo is not
     * something a single-table CHECK can see, because the photos are rows in
     * `message_attachments`; that half is the send transaction's
     * (`conversations.repository.ts#append`), which writes both or neither.
     * Named `messages_body_shape` rather than keeping the old name, because
     * the old name described a rule this no longer is.
     */
    check(
      'messages_body_shape',
      sql`${table.body} = '' or length(btrim(${table.body})) between 1 and 2000`,
    ),

    /**
     * A message cannot be read before it was written. Cheap, and it catches the
     * one class of bug — a clock or a hand-written backfill — that would
     * otherwise produce a negative "read after" in whatever reads this next.
     */
    check(
      'messages_read_after_created',
      sql`${table.readAt} is null or ${table.readAt} >= ${table.createdAt}`,
    ),
  ],
);

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  order: one(orders, { fields: [conversations.orderId], references: [orders.id] }),
  master: one(masters, { fields: [conversations.masterId], references: [masters.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export type ConversationRow = typeof conversations.$inferSelect;
export type NewConversationRow = typeof conversations.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

/**
 * The column type and the wire contract describe the same set, in both
 * directions — the same guard `orders.ts` puts on `order_status`, and for the
 * same reason: adding a value to one side and forgetting the other typechecks
 * everywhere and fails at runtime against a value Postgres rejects.
 */
type AssertNever<T extends never> = T;

export type MessageSenderKindEnumHasNoStrangers = AssertNever<
  Exclude<(typeof messageSenderKind.enumValues)[number], MessageSenderKind>
>;
export type MessageSenderKindEnumIsComplete = AssertNever<
  Exclude<MessageSenderKind, (typeof messageSenderKind.enumValues)[number]>
>;
