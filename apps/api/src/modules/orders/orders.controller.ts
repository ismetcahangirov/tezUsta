import { Body, Controller, Post } from '@nestjs/common';
import type { Order } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { createOrderSchema } from './orders.schema';
import { OrdersService } from './orders.service';

class CreateOrderDto extends createZodDto(createOrderSchema) {}

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
}
