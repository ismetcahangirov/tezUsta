import { Module } from '@nestjs/common';

import { CLOCK, systemClock } from '../../common/time/clock';
import { DatabaseModule } from '../../infra/database/database.module';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsRepository } from './subscriptions.repository';
import { SubscriptionsService } from './subscriptions.service';

/**
 * The master subscription (ADR-0046, issue #322).
 *
 * **It imports no domain module.** `MastersModule` imports it — for the
 * availability gate, the master's own `GET /masters/me/subscription`, and the
 * accept re-check — and `AdminModule` imports it to start a trial inside the
 * approval transaction. The arrow only points this way, so this module never
 * learns what a master profile or an admin is beyond the ids it is given.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [SubscriptionsController],
  providers: [
    SubscriptionsRepository,
    SubscriptionsService,
    { provide: CLOCK, useValue: systemClock },
  ],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
