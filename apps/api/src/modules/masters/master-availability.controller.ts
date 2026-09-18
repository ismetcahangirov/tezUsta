import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import type { MasterAvailability } from '@tezusta/types';

import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { heartbeatSchema, setAvailabilitySchema } from './master-availability.schema';
import { MasterAvailabilityService } from './master-availability.service';

class SetAvailabilityDto extends createZodDto(setAvailabilitySchema) {}
class HeartbeatDto extends createZodDto(heartbeatSchema) {}

/**
 * The master's availability toggle and its heartbeat (issue #40).
 *
 * Every response is the **whole** availability state, never an empty 204.
 * `docs/product/master-flow.md` requires the toggle to be unambiguous, and a
 * client that has to infer its own state from the request it just sent is a
 * client that will eventually be wrong about whether its user is working.
 *
 * The heartbeat is HTTP rather than a WebSocket ping, and that is not a
 * placeholder. There is no socket yet — the gateway is EPIC 9 — and
 * `docs/architecture/realtime-architecture.md` is explicit that the socket is
 * for the five events that need pushing, not for everything that repeats. When
 * the gateway lands a ping can refresh the same presence key; this endpoint
 * stays as the path that works when the socket does not.
 */
@Controller('masters/me/availability')
export class MasterAvailabilityController {
  constructor(private readonly availability: MasterAvailabilityService) {}

  @Roles('master')
  @Get()
  async read(@CurrentActor() actor: Actor): Promise<MasterAvailability> {
    return this.availability.read(actor);
  }

  /**
   * `@HttpCode(200)` because Nest answers a `@Post()` with 201 by default and
   * nothing here is created. A toggle is a statement of intent about a row
   * that already exists, and 201 would tell every client — and every proxy
   * reading status codes — that a resource came into being.
   */
  @Roles('master')
  @HttpCode(200)
  @Post()
  async set(
    @CurrentActor() actor: Actor,
    @Body() body: SetAvailabilityDto,
  ): Promise<MasterAvailability> {
    return this.availability.set(actor, body.isAvailable);
  }

  @Roles('master')
  @HttpCode(200)
  @Post('heartbeat')
  async heartbeat(
    @CurrentActor() actor: Actor,
    @Body() _body: HeartbeatDto,
  ): Promise<MasterAvailability> {
    return this.availability.heartbeat(actor);
  }
}
