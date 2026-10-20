import { Controller, Delete, Get, HttpCode } from '@nestjs/common';
import type { SubscriptionAutoRenewal } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { SubscriptionRenewalService } from './subscription-renewal.service';

/**
 * The calling master's auto-renewal (ADR-0058): whether a saved card will be
 * charged for the next period, and the switch that stops it. Turning it on is
 * a checkout with `autoRenew: true`; there is no other way to save a card.
 */
@Roles('master')
@Controller('masters/me/subscription/auto-renewal')
export class SubscriptionAutoRenewalController {
  constructor(private readonly renewals: SubscriptionRenewalService) {}

  @Get()
  read(@CurrentActor() actor: Actor): Promise<SubscriptionAutoRenewal> {
    return this.renewals.status(actor);
  }

  @RateLimit({ policy: 'subscription-checkout', identifier: rateLimitByUser })
  @HttpCode(204)
  @Delete()
  async disable(@CurrentActor() actor: Actor): Promise<void> {
    await this.renewals.disable(actor);
  }
}
