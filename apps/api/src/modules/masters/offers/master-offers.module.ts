import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../../infra/database/database.module';
import { AddressesModule } from '../../addresses/addresses.module';
import { OrdersModule } from '../../orders/orders.module';
import { MastersModule } from '../masters.module';
import { MasterJobsController } from './master-jobs.controller';
import { MasterOffersController } from './master-offers.controller';
import { MasterOffersRepository } from './master-offers.repository';
import { MasterJobsService } from './master-jobs.service';
import { MasterOffersService } from './master-offers.service';

/**
 * The master's side of dispatch (issue #101): the offer feed, decline, and
 * accept.
 *
 * **A module of its own rather than more providers inside `MastersModule`,
 * and the reason is a dependency direction.** This surface needs `orders` —
 * the conditional `UPDATE` that claims one, the audit trail, the problem
 * photos — and `OrdersModule` already imports `MastersModule` to answer "is
 * this actor the master assigned to this order?". Putting the accept path
 * inside `MastersModule` would make those two modules import each other, which
 * Nest survives with `forwardRef` and `no-circular` does not survive at all
 * (CLAUDE.md §14). As a leaf that imports both, the graph stays acyclic and
 * nothing needs a `forwardRef`.
 *
 * It still lives *under* `masters/` because that is whose surface it is: every
 * route is `/masters/me/offers/...`, and the eligibility predicate it
 * re-evaluates is `MastersModule`'s to own.
 *
 * `MasterOffersRepository` is not exported. `order_offers` has two writers —
 * this one, which moves a row a master responded to, and the dispatch engine,
 * which creates and expires them — and neither should be able to reach the
 * other's SQL.
 */
@Module({
  imports: [DatabaseModule, MastersModule, OrdersModule, AddressesModule],
  controllers: [MasterOffersController, MasterJobsController],
  providers: [MasterOffersRepository, MasterOffersService, MasterJobsService],
})
export class MasterOffersModule {}
