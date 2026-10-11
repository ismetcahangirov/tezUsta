import { Controller, Get } from '@nestjs/common';
import type { MasterSubscription } from '@tezusta/types';

import type { Actor } from '../auth/auth.types';
import { CurrentActor } from '../auth/current-actor.decorator';
import { Roles } from '../auth/roles.decorator';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { MastersService } from './masters.service';

/**
 * The calling master's own subscription (issue #322) — the status, the period
 * end, the grace end and any queued period, for the app to explain (#325).
 *
 * Here rather than in `SubscriptionsModule` because "which master is this
 * actor" is this module's question: the subscription module is handed a master
 * id and never resolves one. 404 for a master with no subscription yet, which
 * is every master verification has not approved.
 */
@Controller('masters/me/subscription')
export class MasterSubscriptionController {
  constructor(
    private readonly masters: MastersService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Roles('master')
  @Get()
  async read(@CurrentActor() actor: Actor): Promise<MasterSubscription> {
    const master = await this.masters.getOwn(actor);
    return this.subscriptions.readOwn(master.id);
  }
}
