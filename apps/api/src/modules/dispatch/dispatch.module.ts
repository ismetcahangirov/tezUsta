import { Module } from '@nestjs/common';

import { QueueModule } from '../../infra/queue/queue.module';
import { AddressesModule } from '../addresses/addresses.module';
import { MastersModule } from '../masters/masters.module';
import { OrdersModule } from '../orders/orders.module';
import { DispatchService } from './dispatch.service';

/**
 * The dispatch engine (EPIC 7, issue #103).
 *
 * **Every import points one way: into the modules that own the data, and never
 * back.** `OrdersModule` owns the order and its audit trail, `AddressesModule`
 * owns where the work is, `MastersModule` owns who is eligible, and
 * `QueueModule` owns "run this later". Nothing here is read by querying
 * somebody else's table (`backend-architecture.md` § Module rules).
 *
 * Order creation reaches the engine through `OrderDispatchRegistry`, a slot
 * `OrdersModule` offers and this module fills at `onModuleInit`. That
 * indirection is what keeps the arrow single-headed: if `OrdersModule`
 * imported this one to announce a search, the two would import each other and
 * `no-circular` would fail the build — with `forwardRef` as the only escape,
 * which swaps a cycle CI can see for one only production can.
 *
 * **There is no controller, deliberately.** Dispatch is driven by the clock
 * and by order creation, not by a request. The master-facing half — the offer
 * feed, decline and accept — is issue #101 and lives with the masters.
 */
@Module({
  imports: [QueueModule, OrdersModule, AddressesModule, MastersModule],
  providers: [DispatchService],
  exports: [DispatchService],
})
export class DispatchModule {}
