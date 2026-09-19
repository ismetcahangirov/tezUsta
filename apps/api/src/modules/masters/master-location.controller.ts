import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import type { MasterLocationReceipt } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { reportLocationSchema } from './master-location.schema';
import { MasterLocationService } from './master-location.service';

class ReportLocationDto extends createZodDto(reportLocationSchema) {}

/**
 * Where a master reports their position (issue #98).
 *
 * `/masters/me/location`, with no id anywhere in it. The master is the caller,
 * resolved from the actor: a route that can be *asked* whose position to
 * record is a route that can be asked the wrong name, and this is the one
 * table where being asked the wrong name means writing one person's movements
 * under another person's id.
 */
@Controller('masters/me/location')
export class MasterLocationController {
  constructor(private readonly location: MasterLocationService) {}

  /**
   * `@HttpCode(200)` rather than Nest's default 201 for a `@Post()`. A row is
   * genuinely appended, but nothing addressable comes into being — there is no
   * URL for a position, and never will be, because the trail is not readable
   * over HTTP by anybody. 201 plus no `Location` header would tell every proxy
   * and client that a resource exists to go and fetch.
   *
   * Rate-limited per user, under a budget sized from the documented location
   * update interval: the server is the authority on how often a master's app
   * may report, and this decorator is where that authority is actually applied
   * (`docs/architecture/realtime-architecture.md` § Location update budget).
   */
  @Roles('master')
  @RateLimit({ policy: 'location-report', identifier: rateLimitByUser })
  @HttpCode(200)
  @Post()
  async report(
    @CurrentActor() actor: Actor,
    @Body() body: ReportLocationDto,
  ): Promise<MasterLocationReceipt> {
    return this.location.report(actor, body);
  }
}
