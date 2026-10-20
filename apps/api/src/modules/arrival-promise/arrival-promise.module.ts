import { Module } from '@nestjs/common';

import { RoutingInfraModule } from '../../infra/geo/routing.module';
import { QueueModule } from '../../infra/queue/queue.module';
import { AddressesModule } from '../addresses/addresses.module';
import { MastersModule } from '../masters/masters.module';
import { OrdersModule } from '../orders/orders.module';
import { ArrivalPromiseService } from './arrival-promise.service';

/**
 * The arrival promise's computation (#396, ADR-0055): the job that fixes it
 * after an accept, and the sweep that re-asks for one an accept lost.
 *
 * **A leaf, like `DispatchModule`.** It reads orders, addresses and master
 * positions and calls the routing provider, and nothing imports it: the
 * accept path schedules through `ArrivalPromiseScheduler` in `OrdersModule`,
 * and the realtime publisher hears through `ArrivalPromisesRegistry` there,
 * so no arrow points back here.
 */
@Module({
  imports: [QueueModule, RoutingInfraModule, OrdersModule, AddressesModule, MastersModule],
  providers: [ArrivalPromiseService],
})
export class ArrivalPromiseModule {}
