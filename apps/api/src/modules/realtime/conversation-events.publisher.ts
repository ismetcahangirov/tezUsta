import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import type { MessageNewRealtimeEvent, MessageReadRealtimeEvent } from '@tezusta/types';

import { ConversationEventsRegistry } from '../orders/conversation-events.registry';
import type {
  MessageCreatedEvent,
  MessagesReadEvent,
} from '../orders/conversation-events.registry';
import { MESSAGE_NEW_EVENT, MESSAGE_READ_EVENT } from './realtime.events';
import { RealtimeGateway } from './realtime.gateway';
import { orderRoom, userRoom } from './room.types';

/**
 * What puts a committed message and a committed read receipt on the socket
 * (issue #179).
 *
 * **It fills a slot rather than being called**, exactly as
 * `OrderEventsPublisher` does for order transitions: `modules/orders` raises
 * into `ConversationEventsRegistry` after the write commits, and this is one of
 * its subscribers. Nothing in `modules/orders` knows a socket exists.
 *
 * **No new transport and no new room.** A conversation belongs to one order
 * (ADR-0033), and `order:{orderId}` already holds exactly its two parties:
 * the join is authorized from the database (#167) and every committed
 * transition evicts whoever stopped being a party, including at a terminal
 * status. So the conversation's audience is that room, and the Redis adapter
 * carries a publish on one instance to a socket held by another.
 *
 * **Nothing here reads the database.** The event arrives with the presented
 * message, and deciding who may hear it was settled by room membership — the
 * same argument `OrderEventsPublisher` makes for keeping a publish off the
 * cluster round trip.
 */
@Injectable()
export class ConversationEventsPublisher implements OnModuleInit {
  private readonly logger = new Logger(ConversationEventsPublisher.name);

  constructor(
    private readonly registry: ConversationEventsRegistry,
    private readonly gateway: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.registry.register('realtime events', {
      messageCreated: (event) => this.onMessageCreated(event),
      messagesRead: (event) => this.onMessagesRead(event),
    });
  }

  /**
   * One committed message becomes one frame to the other party.
   *
   * **The sender's account is subtracted**, for the reason
   * `MessageNewRealtimeEvent` gives: they reconcile against the `POST`
   * response, and a frame racing it would make their one message two bubbles.
   */
  private onMessageCreated(event: MessageCreatedEvent): Promise<void> {
    const payload: MessageNewRealtimeEvent = {
      orderId: event.orderId,
      message: event.message,
      at: Date.now(),
    };

    this.to(event.orderId, event.senderUserId)?.emit(MESSAGE_NEW_EVENT, payload);
    return Promise.resolve();
  }

  /** One committed receipt becomes one frame to the party whose messages were read. */
  private onMessagesRead(event: MessagesReadEvent): Promise<void> {
    const payload: MessageReadRealtimeEvent = {
      orderId: event.orderId,
      readerKind: event.readerKind,
      throughMessageId: event.throughMessageId,
      readAt: event.readAt.toISOString(),
      at: Date.now(),
    };

    this.to(event.orderId, event.readerUserId)?.emit(MESSAGE_READ_EVENT, payload);
    return Promise.resolve();
  }

  /**
   * The order's room minus one account, or `undefined` before socket.io has
   * attached — see `OrderEventsPublisher#to`, which guards the same window for
   * the same reason.
   */
  private to(orderId: string, exceptUserId: string) {
    const server = this.gateway.server as typeof this.gateway.server | undefined;
    const room = orderRoom(orderId);

    if (server === undefined) {
      this.logger.debug(`nothing published to ${room}: the socket server is not attached yet`);
      return undefined;
    }

    return server.to(room).except(userRoom(exceptUserId));
  }
}
