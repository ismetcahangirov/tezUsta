import { Body, Controller, Post } from '@nestjs/common';
import type { SubscriptionCheckout } from '@tezusta/types';

import { RateLimit } from '../../common/decorators/rate-limit.decorator';
import { createZodDto } from '../../common/pipes/zod-validation.pipe';
import { rateLimitByUser } from '../../infra/rate-limit/rate-limit-by-user';
import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { WebSurface } from '../auth/web-surface.decorator';
import { startCheckoutSchema } from './billing.schema';
import { SubscriptionCheckoutService } from './subscription-checkout.service';

class StartCheckoutDto extends createZodDto(startCheckoutSchema) {}

/**
 * `POST /masters/me/subscription/checkout` — open a hosted checkout for one
 * period (issue #323).
 *
 * **Not called by the app.** ADR-0046 § 7 sells the subscription outside it:
 * the web purchase page (#334) is this endpoint's client. The app shows the
 * subscription's status and nothing that leads here.
 *
 * Rate-limited per account: each call that gets past the checks opens a
 * session at the provider.
 */
@Controller('masters/me/subscription/checkout')
export class SubscriptionCheckoutController {
  constructor(private readonly checkouts: SubscriptionCheckoutService) {}

  @Roles('master')
  // The web subscription page is where a checkout starts (ADR-0061 § 3).
  @WebSurface()
  @RateLimit({ policy: 'subscription-checkout', identifier: rateLimitByUser })
  @Post()
  start(
    @CurrentActor() actor: Actor,
    @Body() body: StartCheckoutDto,
  ): Promise<SubscriptionCheckout> {
    return this.checkouts.start(actor, body.billingPeriod, body.autoRenew);
  }
}
