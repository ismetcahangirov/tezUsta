import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { Conversation, CursorPage, Message } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { ConversationsService } from './conversations.service';
import {
  listMessagesQuerySchema,
  markMessagesReadSchema,
  orderIdParamsSchema,
  sendMessageSchema,
} from './conversations.schema';

class OrderIdParamsDto extends createZodDto(orderIdParamsSchema) {}
class ListMessagesQueryDto extends createZodDto(listMessagesQuerySchema) {}
class SendMessageDto extends createZodDto(sendMessageSchema) {}
class MarkMessagesReadDto extends createZodDto(markMessagesReadSchema) {}

/**
 * The conversation on one order (issue #178).
 *
 * **Four routes under `orders/:orderId`, and no conversation id in any of
 * them.** A conversation is a property of an order
 * ([ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)), so the order is
 * the only identifier a client needs or is given — which also means there is
 * no conversation id to guess at, and no second identifier space for
 * authorization to be got wrong in.
 *
 * `@Roles('customer', 'master')` is a cheap first gate and **not** the
 * authorization, exactly as `orders.controller.ts` says of its own transition
 * route: a role claim in a token is a cache, and whether *this* caller is this
 * order's customer or its currently assigned master is re-read from the
 * database on every request (`conversations.service.ts#requireParty`).
 *
 * **Only `send` is rate-limited, and that is the honest line rather than a
 * gap.** A send writes a row into a transcript that can never be tidied up,
 * and is a channel between two strangers — the abuse surface ADR-0033 names.
 * The three reads are bounded by the page ceiling in `conversations.schema.ts`
 * and return only what the caller is already party to; a poll-shaped budget
 * for them belongs with the socket that replaces polling (#179), where
 * `rate-limit.config.ts` says a per-connection message budget has a different
 * shape from a per-identifier HTTP one.
 */
@Roles('customer', 'master')
@Controller('orders/:orderId')
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  /** The order's current conversation, with the caller's own unread count. */
  @Get('conversation')
  async get(
    @CurrentActor() actor: Actor,
    @Param() params: OrderIdParamsDto,
  ): Promise<Conversation> {
    return this.conversations.getForOrder(actor, params.orderId);
  }

  /**
   * History, newest first, cursor-paginated.
   *
   * **Cursor rather than offset from the start**, and on this surface it is
   * not a preference: a conversation grows at the tail while it is being
   * scrolled back through, so an offset page would skip or repeat a message
   * every time the other party wrote mid-scroll
   * (`docs/architecture/backend-architecture.md` § API conventions).
   */
  @Get('messages')
  async list(
    @CurrentActor() actor: Actor,
    @Param() params: OrderIdParamsDto,
    @Query() query: ListMessagesQueryDto,
  ): Promise<CursorPage<Message>> {
    return this.conversations.listMessages(actor, params.orderId, query);
  }

  /**
   * Writes a message, and answers with it.
   *
   * **The write is HTTP, not a socket frame** (ADR-0033 § 3). The socket
   * announces the change to the other party (#179); this is the request that
   * assigns the id and the timestamp, and it is what survives a reconnect.
   *
   * Rate-limited per user rather than per IP alone: two masters on one carrier
   * NAT are two people, and the budget belongs to the person writing.
   */
  @RateLimit({ policy: 'message-send', identifier: rateLimitByUser })
  @Post('messages')
  async send(
    @CurrentActor() actor: Actor,
    @Param() params: OrderIdParamsDto,
    @Body() body: SendMessageDto,
  ): Promise<Message> {
    return this.conversations.send(actor, params.orderId, body);
  }

  /**
   * Marks the other party's messages read up to the one named, and answers
   * with the conversation so the caller's badge settles in the same round trip.
   *
   * `@HttpCode(200)` because Nest answers a `@Post()` with 201 by default and
   * nothing is created here — the messages already existed and still do.
   */
  @HttpCode(200)
  @Post('messages/read')
  async markRead(
    @CurrentActor() actor: Actor,
    @Param() params: OrderIdParamsDto,
    @Body() body: MarkMessagesReadDto,
  ): Promise<Conversation> {
    return this.conversations.markRead(actor, params.orderId, body);
  }
}
