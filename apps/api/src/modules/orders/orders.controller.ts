import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { CursorPage, Order } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderIdParamsSchema,
  transitionOrderSchema,
} from './orders.schema';
import { OrdersService } from './orders.service';

class CreateOrderDto extends createZodDto(createOrderSchema) {}
class ListOrdersQueryDto extends createZodDto(listOrdersQuerySchema) {}
class OrderIdParamsDto extends createZodDto(orderIdParamsSchema) {}
class TransitionOrderDto extends createZodDto(transitionOrderSchema) {}

/**
 * Orders.
 *
 * **Nothing here is `@Public()`, and no route names a customer.** The owner is
 * the caller's own profile, resolved from the actor; the only ids a client
 * sends are the ones it is allowed to have — a service from the public
 * catalogue and an address of its own.
 *
 * An order carries a home address and a description of what is wrong inside
 * it. Neither is logged (`docs/engineering/security.md` § PII and privacy);
 * the error path carries a request id and a stable code, never the body that
 * produced it.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Creates an order, or returns the one an identical earlier attempt created.
   *
   * **201 on both paths, with the same body.** A retry is not a different
   * outcome from the client's point of view — it pressed the button once — and
   * answering 200 the second time would tell it that something else happened,
   * which is exactly the distinction idempotency exists to erase.
   *
   * Rate-limited per user rather than per IP alone: a household behind one
   * mobile NAT is several customers, and every created order rings real
   * masters' phones (ADR-0009).
   */
  @Post()
  @RateLimit({ policy: 'order-creation', identifier: rateLimitByUser })
  async create(@CurrentActor() actor: Actor, @Body() body: CreateOrderDto): Promise<Order> {
    return this.orders.create(actor, body);
  }

  /**
   * The caller's own orders, newest first.
   *
   * **Cursor-paginated from the start**, not offset: a customer creating an
   * order while paging would otherwise see the second page repeat a row the
   * first page already showed (`docs/architecture/backend-architecture.md`
   * § API conventions).
   *
   * Declared before `:id` — Fastify matches a static segment ahead of a
   * parameterised one either way, but the reading order matters to whoever
   * adds the next route.
   */
  @Get()
  async list(
    @CurrentActor() actor: Actor,
    @Query() query: ListOrdersQueryDto,
  ): Promise<CursorPage<Order>> {
    return this.orders.list(actor, query);
  }

  /** 404 for an order that is not the caller's — never 403. */
  @Get(':id')
  async getById(@CurrentActor() actor: Actor, @Param() params: OrderIdParamsDto): Promise<Order> {
    return this.orders.getById(actor, params.id);
  }

  /**
   * The assigned master moves their own job forward or sends it back out, and
   * the customer cancels their own order (issues #134, #135 and #136, EPIC 8).
   *
   * **One route taking a target, rather than `/depart`, `/arrive`, `/start`,
   * `/complete`, `/cancel` and `/redispatch`.** `assertOrderTransition` then
   * runs in exactly one place. Six routes would carry six copies of the edge
   * check and the actor check, and the seventh edge somebody adds later would
   * be the one that forgets a copy — while the transition table, which
   * `backend-architecture.md` calls the implementation of the lifecycle
   * diagram, stays the single authority.
   *
   * **One route for both parties, rather than a customer-facing twin.** The
   * two would differ only in who the service resolves the caller to, which is
   * a question the order row answers either way — and a separate cancel route
   * would be a second place for "is this order yours" to be got wrong, on the
   * one edge where getting it wrong ends somebody else's job.
   *
   * `@Roles('master', 'customer')` is a cheap first gate and **not** the
   * authorization: a role claim in a token is a cache, not an authority, and
   * whether *this* caller is this order's customer or its assigned master is
   * re-read from the database on every request
   * (`orders.service.ts#transition`).
   *
   * `@HttpCode(200)` because Nest answers a `@Post()` with 201 by default, and
   * nothing here is created: the order already existed and still does.
   *
   * Rate-limited per user rather than per IP alone — a master on a mobile
   * network shares an IP with strangers, and this budget is about one client
   * stuck in a retry loop, not about a neighbourhood.
   */
  @Roles('master', 'customer')
  @HttpCode(200)
  @RateLimit({ policy: 'order-transition', identifier: rateLimitByUser })
  @Post(':id/transitions')
  async transition(
    @CurrentActor() actor: Actor,
    @Param() params: OrderIdParamsDto,
    @Body() body: TransitionOrderDto,
  ): Promise<Order> {
    return this.orders.transition(actor, params.id, body);
  }
}
