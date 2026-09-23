import { Injectable } from '@nestjs/common';
import type {
  Conversation,
  CursorPage,
  Message,
  MessageAttachment,
  MessageSenderKind,
  OrderStatus,
} from '@tezusta/types';

import { AppError } from '../../common/errors/app-error';
import { ERROR_CODES } from '../../common/errors/error-codes.types';
import { NotFoundError } from '../../common/errors/not-found.error';
import type { ConversationRow, MessageRow } from '../../infra/database/schema/conversations';
import type { OrderRow } from '../../infra/database/schema/orders';
import type { Actor } from '../auth/auth.types';
import { CustomersService } from '../customers/customers.service';
import { MastersService } from '../masters/masters.service';
import { ConversationEventsRegistry } from './conversation-events.registry';
import { ConversationsRepository } from './conversations.repository';
import type {
  ListMessagesQuery,
  MarkMessagesReadRequest,
  SendMessageRequest,
} from './conversations.schema';
import { refuseAttachments } from './message-attachments.errors';
import { MessageAttachmentsReader } from './message-attachments.reader';
import { decodeMessageCursor, encodeMessageCursor } from './message-cursor';
import { OrdersRepository } from './orders.repository';

/**
 * The statuses in which an order's conversation accepts new messages.
 *
 * **A positive list, not a list of terminal statuses to exclude**, and the
 * direction is the whole safety property: a status added to ADR-0015 later
 * defaults to *read-only* here rather than silently becoming a state in which
 * two people can still write to each other. Getting that wrong in the other
 * direction would be invisible — nothing fails, a channel just stays open past
 * the job it belonged to.
 *
 * These four are exactly the statuses in which a master is on the job. ADR-0033
 * § 2 enumerates the read-only side as `COMPLETED`, `PAID`, `CANCELLED`,
 * `RESOLVED`, `REFUNDED` and `NO_MASTER_FOUND`; `DISPUTED` is read-only too,
 * because by then the argument belongs in the dispute with an admin present,
 * and `PAYMENT_PENDING` is read-only because it is only ever reached from
 * `COMPLETED`, which already is. `DRAFT` and `SEARCHING` never have a
 * conversation to write to.
 */
const CONVERSATION_WRITABLE_STATUSES: readonly OrderStatus[] = [
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
];

/**
 * The order is over, so its conversation is a transcript rather than a channel.
 *
 * A named code rather than the generic `CONFLICT`, for the reason
 * `ORDER_PHOTO_LIMIT_EXCEEDED` is one: the app has a different thing to show
 * — the composer disappears and the history stays — and a client that saw
 * `CONFLICT` for this and for every other refusal would have to guess.
 */
export class ConversationNotWritableError extends AppError {
  constructor(status: OrderStatus) {
    super(
      ERROR_CODES.CONVERSATION_NOT_WRITABLE,
      'This order is finished, so its conversation can be read but not added to.',
      409,
      { orderStatus: status },
    );
    this.name = 'ConversationNotWritableError';
    Object.setPrototypeOf(this, ConversationNotWritableError.prototype);
  }
}

/**
 * The conversation on one order (issue #178).
 *
 * **Every method here answers authorization from the database on every
 * request** — never from the token's role claim, and never from anything the
 * client sent. A master removed from an order by a re-dispatch loses the
 * conversation at the same instant they lose the job, with no cache to expire
 * and no session to invalidate, because the question is re-asked rather than
 * remembered (CLAUDE.md §11).
 *
 * **Everything refuses with 404, never 403.** "This order is not yours" and
 * "there is no such order" have to be indistinguishable to a caller who is
 * party to neither, or the API becomes a way to discover which order ids
 * exist. `orders.controller.ts` takes the same line on the order itself.
 *
 * Nothing here logs a message body, a phone number or an order description
 * (`docs/engineering/security.md` § PII and privacy). The error path carries a
 * request id and a stable code.
 */
@Injectable()
export class ConversationsService {
  constructor(
    private readonly conversations: ConversationsRepository,
    private readonly orders: OrdersRepository,
    private readonly customers: CustomersService,
    private readonly masters: MastersService,
    private readonly events: ConversationEventsRegistry,
    private readonly attachments: MessageAttachmentsReader,
  ) {}

  /** The order's current conversation, as the caller sees it. */
  async getForOrder(actor: Actor, orderId: string): Promise<Conversation> {
    const { order, conversation, side } = await this.requireParty(actor, orderId);
    return this.present(conversation, order, side);
  }

  /**
   * One page of history, newest first.
   *
   * Readable whether or not the order is still live: ADR-0033 § 2 keeps the
   * transcript precisely so a dispute raised after completion has it.
   */
  async listMessages(
    actor: Actor,
    orderId: string,
    query: ListMessagesQuery,
  ): Promise<CursorPage<Message>> {
    const { conversation, side } = await this.requireParty(actor, orderId);

    const page = await this.conversations.listMessages({
      conversationId: conversation.id,
      limit: query.limit,
      afterMessageId: decodeMessageCursor(query.cursor),
    });

    // One query for every photo on the page, never one per message (#181).
    const photos = await this.attachments.forMessages(page.rows.map((row) => row.id));

    return {
      items: page.rows.map((row) => presentMessage(row, side, photos.get(row.id) ?? [])),
      nextCursor: page.nextCursorId === null ? null : encodeMessageCursor(page.nextCursorId),
    };
  }

  /**
   * Appends a message.
   *
   * **The response is what the sender reconciles its optimistic bubble
   * against**, which is why it returns the created message rather than 204:
   * the id and the timestamp are the server's, and a client that invented
   * either would produce a bubble that jumps position the moment the real
   * history arrives (ADR-0033 § 3).
   */
  async send(actor: Actor, orderId: string, input: SendMessageRequest): Promise<Message> {
    const { order, conversation, side } = await this.requireParty(actor, orderId);

    if (!isWritable(order)) {
      throw new ConversationNotWritableError(order.status);
    }

    const outcome = await this.conversations.append({
      conversationId: conversation.id,
      senderKind: side,
      body: input.body,
      attachmentIds: input.attachmentIds,
    });

    if (outcome.kind === 'refused') {
      throw refuseAttachments(outcome.refusal);
    }

    const message = presentMessage(
      outcome.row,
      side,
      await this.attachments.present(outcome.attachments),
    );

    // **After `append` has returned, which is after its transaction
    // committed** — the message and its photo bindings are one transaction
    // inside the repository, never one this method holds open. A frame raised
    // before that point could announce a message the database then rolled
    // back, and the two phones would disagree with the transcript and with
    // each other (#179). The registry swallows a failed delivery: the message
    // is written either way.
    //
    // The frame carries the attachments as presented to the *sender*, whose
    // presigned GETs are as good for the recipient: both are parties, and the
    // URLs name the object, not the viewer.
    await this.events.messageCreated({
      orderId: order.id,
      conversationId: conversation.id,
      customerId: order.customerId,
      masterId: conversation.masterId,
      senderKind: side,
      senderUserId: actor.userId,
      message,
    });

    return message;
  }

  /**
   * Marks everything the other party sent, up to and including the named
   * message, as read — and answers with the caller's new unread count.
   *
   * **Permitted on a finished order.** Reading is not writing: a customer
   * opening a completed job's transcript should clear its badge, and refusing
   * would leave an unread count nothing could ever clear.
   *
   * A message id that belongs to a different conversation is a 404, not a
   * silent no-op. Silently accepting it would let a caller probe whether an id
   * exists by watching which requests succeed.
   */
  async markRead(
    actor: Actor,
    orderId: string,
    input: MarkMessagesReadRequest,
  ): Promise<Conversation> {
    const { order, conversation, side } = await this.requireParty(actor, orderId);

    const target = await this.conversations.findMessageById(input.throughMessageId);

    if (target === undefined || target.conversationId !== conversation.id) {
      throw new NotFoundError();
    }

    const readAt = new Date();
    const marked = await this.conversations.markReadThrough({
      conversationId: conversation.id,
      reader: side,
      throughMessageId: target.id,
      readAt,
    });

    // Only a receipt that changed something is worth telling the sender about.
    // A retried or duplicated one is a no-op in the database and would be a
    // frame that re-stamps bubbles with a later time than the real one.
    if (marked > 0) {
      await this.events.messagesRead({
        orderId: order.id,
        conversationId: conversation.id,
        readerKind: side,
        readerUserId: actor.userId,
        throughMessageId: target.id,
        readAt,
      });
    }

    return this.present(conversation, order, side);
  }

  /**
   * The order, its open conversation, and which side of it the caller is —
   * or 404.
   *
   * **The assigned master is asked about first, and only when the order has
   * one**, which is `orders.service.ts#resolveParty`'s rule and is here for
   * the same reason: one account may hold both roles
   * (`docs/product/user-roles.md`), so both questions can be answered yes by
   * one person. On this surface the tie matters more than it does there,
   * because the answer decides whose messages are "mine" — and a plumber
   * messaging about their own broken fridge is the customer on *that* order,
   * which is what the `order.masterId` guard makes true.
   *
   * `findOwn` rather than `getOwn` on both: a caller who legitimately holds
   * only one of the two profiles must not have the question answered by a 404
   * thrown from inside it.
   *
   * **Public because it is the party rule, and there is exactly one.** The
   * message-photo endpoints (`message-attachments.service.ts`, #181) ask it the
   * same question rather than writing a second copy that could drift.
   */
  async requireParty(
    actor: Actor,
    orderId: string,
  ): Promise<{ order: OrderRow; conversation: ConversationRow; side: MessageSenderKind }> {
    const order = await this.orders.findById(orderId);

    if (order === undefined) {
      throw new NotFoundError();
    }

    const side = await this.resolveSide(actor, order);

    const conversation = await this.conversations.findOpenByOrderId(order.id);

    // An order that has never been accepted has no conversation, and neither
    // does one whose conversation was closed by a re-dispatch that has not
    // been accepted again yet. Both are "there is nothing here", which is a
    // 404 rather than an empty conversation object — an empty object would
    // invite a client to render a composer for a channel that does not exist.
    if (conversation === undefined) {
      throw new NotFoundError();
    }

    return { order, conversation, side };
  }

  private async resolveSide(actor: Actor, order: OrderRow): Promise<MessageSenderKind> {
    if (order.masterId !== null) {
      const master = await this.masters.findOwn(actor);

      if (master !== undefined && master.id === order.masterId) {
        return 'master';
      }
    }

    const customer = await this.customers.findOwn(actor);

    if (customer !== undefined && customer.id === order.customerId) {
      return 'customer';
    }

    throw new NotFoundError();
  }

  private async present(
    conversation: ConversationRow,
    order: OrderRow,
    side: MessageSenderKind,
  ): Promise<Conversation> {
    return {
      id: conversation.id,
      orderId: conversation.orderId,
      unreadCount: await this.conversations.countUnreadFor(conversation.id, side),
      writable: isWritable(order),
      createdAt: conversation.createdAt.toISOString(),
      closedAt: conversation.closedAt === null ? null : conversation.closedAt.toISOString(),
    };
  }
}

/** Whether the order's conversation accepts new messages — and new photos for them (#181). */
export function isWritable(order: OrderRow): boolean {
  return CONVERSATION_WRITABLE_STATUSES.includes(order.status);
}

/**
 * One row as the caller sees it.
 *
 * **`readAt` is suppressed on a message the caller received**, and that is a
 * deliberate omission rather than an oversight: a read receipt is information
 * about the reader, so the sender is told when their message was read and the
 * reader is not told when they themselves read it. Sending it back would be
 * noise on the common path and, on a shared device, a small leak of when
 * somebody was looking at their phone.
 */
function presentMessage(
  row: MessageRow,
  viewer: MessageSenderKind,
  attachments: readonly MessageAttachment[],
): Message {
  const isOwn = row.senderKind === viewer;

  return {
    id: row.id,
    conversationId: row.conversationId,
    senderKind: row.senderKind,
    body: row.body,
    attachments,
    createdAt: row.createdAt.toISOString(),
    readAt: isOwn && row.readAt !== null ? row.readAt.toISOString() : null,
  };
}
