import { Controller, Get } from '@nestjs/common';
import type { SubscriptionOffer } from '@tezusta/types';

import { Roles } from '../auth/roles.decorator';
import { SubscriptionsService } from './subscriptions.service';

/**
 * The subscription as it is offered (ADR-0046 § 5, issue #322).
 *
 * Any signed-in master may read it. It carries the prices, which the app does
 * **not** render: the subscription is sold outside the app (ADR-0046 § 7,
 * #325). The web purchase page and the admin panel are what show them.
 */
@Controller('subscription')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Roles('master')
  @Get()
  async offer(): Promise<SubscriptionOffer> {
    return this.subscriptions.offer();
  }
}
