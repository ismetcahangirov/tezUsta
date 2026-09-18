import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Res } from '@nestjs/common';
import type { Master, MasterService as MasterServiceContract } from '@tezusta/types';
import type { FastifyReply } from 'fastify';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  addMasterServiceSchema,
  createMasterSchema,
  masterIdParamsSchema,
  masterServiceParamsSchema,
  updateMasterSchema,
  updateMasterServiceSchema,
} from './masters.schema';
import { MastersService } from './masters.service';

class CreateMasterDto extends createZodDto(createMasterSchema) {}
class UpdateMasterDto extends createZodDto(updateMasterSchema) {}
class MasterIdParamsDto extends createZodDto(masterIdParamsSchema) {}
class MasterServiceParamsDto extends createZodDto(masterServiceParamsSchema) {}
class AddMasterServiceDto extends createZodDto(addMasterServiceSchema) {}
class UpdateMasterServiceDto extends createZodDto(updateMasterServiceSchema) {}

/**
 * The master's own surface. Everything here is scoped to the caller.
 *
 * **Admin review lives somewhere else entirely** — `docs/product/admin-flow.md`
 * is explicit that admin endpoints are a separate, separately-guarded surface
 * and never a role flag on a customer-facing route. Verifying, rejecting and
 * suspending a master are therefore issue #39's `/admin/masters`, not another
 * method on this controller.
 */
@Controller('masters')
export class MastersController {
  constructor(private readonly masters: MastersService) {}

  /**
   * Deliberately carries **no** `@Roles('master')`. This route is what grants
   * the role, so gating it on the role would make a master profile
   * unobtainable — the same bootstrapping problem `POST /customers` has.
   *
   * Answers 201 on a fresh profile and 200 when one already existed, so a
   * retried POST over a flaky connection is a normal outcome rather than a
   * conflict the client has to interpret.
   */
  @Post()
  async create(
    @CurrentActor() actor: Actor,
    @Body() body: CreateMasterDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Master> {
    const { master, created } = await this.masters.createOrRevive(actor, body);
    if (!created) {
      reply.code(200);
    }
    return master;
  }

  @Roles('master')
  @Get('me')
  async getOwn(@CurrentActor() actor: Actor): Promise<Master> {
    return this.masters.getOwn(actor);
  }

  @Roles('master')
  @Patch('me')
  async updateOwn(@CurrentActor() actor: Actor, @Body() body: UpdateMasterDto): Promise<Master> {
    return this.masters.updateOwn(actor, body);
  }

  /**
   * Soft delete. The `master` role is left in place: a profile that can be
   * revived by `POST /masters` needs the role that reaches these routes, and
   * revoking it would make the revival unreachable through the API that
   * performs it.
   */
  @Roles('master')
  @Delete('me')
  @HttpCode(204)
  async deleteOwn(@CurrentActor() actor: Actor): Promise<void> {
    await this.masters.deleteOwn(actor);
  }

  @Roles('master')
  @Get('me/services')
  async listServices(@CurrentActor() actor: Actor): Promise<MasterServiceContract[]> {
    return this.masters.listServices(actor);
  }

  @Roles('master')
  @Post('me/services')
  async addService(
    @CurrentActor() actor: Actor,
    @Body() body: AddMasterServiceDto,
  ): Promise<MasterServiceContract> {
    return this.masters.addService(actor, body);
  }

  @Roles('master')
  @Patch('me/services/:serviceId')
  async updateService(
    @CurrentActor() actor: Actor,
    @Param() params: MasterServiceParamsDto,
    @Body() body: UpdateMasterServiceDto,
  ): Promise<MasterServiceContract> {
    return this.masters.updateService(actor, params.serviceId, body);
  }

  @Roles('master')
  @Delete('me/services/:serviceId')
  @HttpCode(204)
  async removeService(
    @CurrentActor() actor: Actor,
    @Param() params: MasterServiceParamsDto,
  ): Promise<void> {
    await this.masters.removeService(actor, params.serviceId);
  }

  /**
   * Declared last so the literal `me` routes above are read first. Fastify's
   * router prefers a static segment over a parametric one regardless of
   * declaration order, so this is for the human reading the file, not for the
   * router.
   */
  @Get(':id')
  async getById(@CurrentActor() actor: Actor, @Param() params: MasterIdParamsDto): Promise<Master> {
    return this.masters.getById(actor, params.id);
  }
}
