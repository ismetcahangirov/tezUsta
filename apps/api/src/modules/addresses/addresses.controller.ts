import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import type { Address } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { AddressesService } from './addresses.service';
import {
  addressIdParamsSchema,
  createAddressSchema,
  updateAddressSchema,
} from './addresses.schema';

class CreateAddressDto extends createZodDto(createAddressSchema) {}
class UpdateAddressDto extends createZodDto(updateAddressSchema) {}
class AddressIdParamsDto extends createZodDto(addressIdParamsSchema) {}

/**
 * A customer's saved addresses.
 *
 * **No route here is `@Public()`, and none of them names a customer.** The
 * owner is always the caller's own profile, resolved from the actor, so the
 * only id a client can send is an address id — and that one is checked against
 * the caller before anything is returned.
 *
 * A home address is the most sensitive thing this API stores
 * (`docs/engineering/security.md` § PII and privacy). Nothing here is logged,
 * and in particular no coordinate is: the error path carries a request id and a
 * stable code, never the body that produced it.
 */
@Controller('addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  /**
   * 404 rather than 422 for a caller who has no customer profile. They are
   * authenticated, so this is not a 401; they are not forbidden from having
   * addresses, so it is not a 403; there is simply no customer for the address
   * to belong to, and the client's next request is `POST /customers`.
   */
  @Post()
  async create(@CurrentActor() actor: Actor, @Body() body: CreateAddressDto): Promise<Address> {
    return this.addresses.create(actor, body);
  }

  /**
   * A plain array, not a cursor page. A customer keeps a handful of addresses
   * and the whole list is one screen; paginating it would add a round trip and
   * a cursor to every first render for no benefit. What makes that safe is the
   * per-customer cap in `addresses.schema.ts` — the response is bounded because
   * the table is, not because the endpoint hopes it is.
   */
  @Get()
  async list(@CurrentActor() actor: Actor): Promise<Address[]> {
    return this.addresses.list(actor);
  }

  @Get(':id')
  async getById(
    @CurrentActor() actor: Actor,
    @Param() params: AddressIdParamsDto,
  ): Promise<Address> {
    return this.addresses.getById(actor, params.id);
  }

  @Patch(':id')
  async update(
    @CurrentActor() actor: Actor,
    @Param() params: AddressIdParamsDto,
    @Body() body: UpdateAddressDto,
  ): Promise<Address> {
    return this.addresses.update(actor, params.id, body);
  }

  /**
   * Soft delete, 204. The row survives because an order references the address
   * it was placed for, and a customer tidying their list must not rewrite the
   * history of work already done there. If the deleted address was the default,
   * the oldest survivor takes its place in the same transaction.
   */
  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentActor() actor: Actor, @Param() params: AddressIdParamsDto): Promise<void> {
    await this.addresses.delete(actor, params.id);
  }
}
