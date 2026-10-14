import { Controller, Get, Headers, Param, Query } from '@nestjs/common';
import type { CursorPage, MasterPublicProfile, PortfolioPost } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { parseAcceptLanguage } from '../../common/i18n/accept-language';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { masterIdParamsSchema, publicPortfolioQuerySchema } from './portfolio.schema';
import { PublicProfileService } from './public-profile.service';

class MasterIdParamsDto extends createZodDto(masterIdParamsSchema) {}
class PortfolioQueryDto extends createZodDto(publicPortfolioQuerySchema) {}

/**
 * A master's public profile and feed (#310). Separate routes from the owner's
 * `GET /masters/:id`, so the owner's view and the public one never share a
 * serializer. Any signed-in caller may ask; ADR-0045 § 2 decides who is
 * answered, and everyone else gets 404. `profile-read` bounds how fast one
 * account can try ids.
 */
@Controller('masters/:masterId')
export class PublicProfileController {
  constructor(private readonly profiles: PublicProfileService) {}

  @RateLimit({ policy: 'profile-read', identifier: rateLimitByUser })
  @Get('profile')
  async profile(
    @CurrentActor() actor: Actor,
    @Param() params: MasterIdParamsDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<MasterPublicProfile> {
    return this.profiles.getProfile(actor, params.masterId, parseAcceptLanguage(acceptLanguage));
  }

  @RateLimit({ policy: 'profile-read', identifier: rateLimitByUser })
  @Get('portfolio')
  async portfolio(
    @CurrentActor() actor: Actor,
    @Param() params: MasterIdParamsDto,
    @Query() query: PortfolioQueryDto,
    @Headers('accept-language') acceptLanguage: string | undefined,
  ): Promise<CursorPage<PortfolioPost>> {
    return this.profiles.getPortfolio(
      actor,
      params.masterId,
      query,
      parseAcceptLanguage(acceptLanguage),
    );
  }
}
