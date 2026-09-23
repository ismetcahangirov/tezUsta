import { Injectable, Logger } from '@nestjs/common';
import type { Message, MessageSenderKind } from '@tezusta/types';

/**
 * A message that has **already committed** to an order's conversation.
 *
 * Profile ids rather than account ids for the two parties, for the reason
 * `OrderTransitionEvent` gives: that is what the rows hold, and turning them
 * into the accounts behind them is the consumer's work. The one account id
 * here is the sender's, because "nobody is told of their own action" needs it
 * and the request that wrote the message already has it.
 */
export interface MessageCreatedEvent {
  readonly orderId: string;
  readonly conversationId: string;
  /** `orders.customer_id`. */
  readonly customerId: string;
  /** `conversations.master_id` — the master this conversation belongs to. */
  readonly masterId: string;
  readonly senderKind: MessageSenderKind;
  /** The account that wrote it. Excluded from every delivery of it. */
  readonly senderUserId: string;
  /**
   * The message **as the recipient sees it** — which, at the instant it was
   * written, is also as the sender sees it: `readAt` is null for both.
   * Presented once by `ConversationsService` so no consumer re-implements what
   * a party is allowed to be shown.
   */
  readonly message: Message;
}

/** A read receipt that has already committed and marked at least one message. */
export interface MessagesReadEvent {
  readonly orderId: string;
  readonly conversationId: string;
  readonly readerKind: MessageSenderKind;
  /** The account that read. Excluded from the delivery, like a sender. */
  readonly readerUserId: string;
  readonly throughMessageId: string;
  readonly readAt: Date;
}

/**
 * One consumer's callbacks. Either may be omitted — the push consumer (#180)
 * has nothing to say about a read receipt.
 */
export interface ConversationEventSubscriber {
  readonly messageCreated?: (event: MessageCreatedEvent) => Promise<void>;
  readonly messagesRead?: (event: MessagesReadEvent) => Promise<void>;
}

/**
 * Where `modules/realtime` (#179) and `modules/notifications` (#180) say "tell
 * me when a message is written or read", without `modules/orders` importing
 * either.
 *
 * **The same seam as `OrderNotificationsRegistry`, and for the same reason**:
 * both consumers read customers and masters, `modules/masters` imports
 * `modules/orders`, so a raise wired the other way would close a cycle
 * (CLAUDE.md §14). A separate registry rather than a third slot in that one,
 * because a message is not an order event — an order's subscribers would all
 * have had to learn to ignore it.
 *
 * **Every raise is after the commit, and every failure is swallowed.** A
 * message that is in the table is written, whatever happens next; turning a
 * socket or queue hiccup into a 500 would have the client retry a send that
 * succeeded, and the transcript would carry it twice. The recipient loses one
 * live delivery at worst and reads the message from history on the next
 * refetch, which the socket was never a substitute for (ADR-0032).
 */
@Injectable()
export class ConversationEventsRegistry {
  private readonly logger = new Logger(ConversationEventsRegistry.name);
  private readonly subscribers = new Map<string, ConversationEventSubscriber>();

  /**
   * @param name What this consumer is called in a failure log. Unique;
   *   registering it twice is a programming error, not a last-one-wins merge.
   */
  register(name: string, subscriber: ConversationEventSubscriber): void {
    if (this.subscribers.has(name)) {
      throw new Error(`A conversation event subscriber named ${name} is already registered`);
    }
    this.subscribers.set(name, subscriber);
  }

  /** Announce a committed message. Call after the write, never inside it. */
  async messageCreated(event: MessageCreatedEvent): Promise<void> {
    for (const [name, subscriber] of this.subscribers) {
      if (subscriber.messageCreated === undefined) {
        continue;
      }
      try {
        await subscriber.messageCreated(event);
      } catch (error) {
        // The order id and nothing from the message: the body never reaches a
        // log (CLAUDE.md §11).
        this.logger.warn(
          `Raising ${name} for a message on order ${event.orderId} failed; the message stands: ${describe(error)}`,
        );
      }
    }
  }

  /** Announce a committed read receipt. Same rules. */
  async messagesRead(event: MessagesReadEvent): Promise<void> {
    for (const [name, subscriber] of this.subscribers) {
      if (subscriber.messagesRead === undefined) {
        continue;
      }
      try {
        await subscriber.messagesRead(event);
      } catch (error) {
        this.logger.warn(
          `Raising ${name} for a read receipt on order ${event.orderId} failed; the receipt stands: ${describe(error)}`,
        );
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
