import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { Customer } from '@tezusta/types';
import type { FastifyReply } from 'fastify';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import {
  createCustomerSchema,
  customerIdParamsSchema,
  updateCustomerSchema,
} from './customers.schema';
import { CustomersService } from './customers.service';

class CreateCustomerDto extends createZodDto(createCustomerSchema) {}
class UpdateCustomerDto extends createZodDto(updateCustomerSchema) {}
class CustomerIdParamsDto extends createZodDto(customerIdParamsSchema) {}

/**
 * The customer's own profile.
 *
 * **No route here is `@Public()`, and none of them takes a user id.** A
 * profile is addressed as `me` or by its own id, and in the second case the
 * service checks visibility before answering — so there is no request shape in
 * which a caller names somebody else and is served
 * (`docs/architecture/authentication.md` § Server ownership checks).
 *
 * There is deliberately no `@Roles('customer')` either. The role is granted
 * *by* `POST /customers`, so requiring it would make the first call impossible;
 * and on the read routes it would turn "you have no profile yet" into a 403,
 * which tells a client its account is wrong when in fact its next request is
 * simply `POST /customers`.
 */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  /**
   * Create the caller's profile — or hand back the one they already have.
   *
   * **Idempotent, and the status code is what says so.** A client that retries
   * a POST it never saw the answer to must not end up with two profiles or a
   * 409 it cannot act on; it gets the same profile and a 200 telling it the
   * work was already done. 201 is reserved for the call that actually created
   * the row, which is the only call that created anything.
   *
   * Nest sets the method's default 201 before the handler runs and does not
   * revisit it afterwards, so lowering it here is the supported way to answer
   * with either — verified against the installed `@nestjs/core` rather than
   * assumed (CLAUDE.md §9).
   */
  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body() body: CreateCustomerDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Customer> {
    const { customer, created } = await this.customers.createOrRevive(actor, body);
    if (!created) {
      reply.code(200);
    }
    return customer;
  }

  /**
   * Declared before `:id`. Fastify's router prefers a static segment over a
   * parameter, so the order is not load-bearing — but a reader should not have
   * to know that to be sure `/customers/me` is not being parsed as a profile
   * id and rejected as a malformed uuid.
   */
  @Get('me')
  async getOwn(@CurrentActor() actor: Actor): Promise<Customer> {
    return this.customers.getOwn(actor);
  }

  @Patch('me')
  async updateOwn(
    @CurrentActor() actor: Actor,
    @Body() body: UpdateCustomerDto,
  ): Promise<Customer> {
    return this.customers.updateOwn(actor, body);
  }

  /**
   * Soft delete, and 204 because there is nothing to say. The row stays —
   * orders, payments and reviews reference the customer and must remain
   * accountable — and a later `POST /customers` revives it with its history
   * intact rather than starting a second one.
   */
  @Delete('me')
  @HttpCode(204)
  async deleteOwn(@CurrentActor() actor: Actor): Promise<void> {
    await this.customers.deleteOwn(actor);
  }

  /**
   * Visible to its owner, 404 to everyone else — including for an id that
   * exists. The route is here because a profile needs a stable address for the
   * places an id is what a client holds; making it owner-only from the first
   * commit is what stops it becoming an enumeration surface later, when the
   * question "who else may read this?" gets a longer answer.
   */
  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param() params: CustomerIdParamsDto,
  ): Promise<Customer> {
    return this.customers.getById(actor, params.id);
  }
}
