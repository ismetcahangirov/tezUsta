import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { AddressesModule } from '../addresses/addresses.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
import { ServicesModule } from '../services/services.module';
import { OrderDispatchRegistry } from './order-dispatch.registry';
import { OrderOffersRepository } from './order-offers.repository';
import { OrderPhotosController } from './order-photos.controller';
import { OrderPhotosRepository } from './order-photos.repository';
import { OrderPhotosService } from './order-photos.service';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

/**
 * Orders (EPIC 6, issue #81) and their problem photos (issue #83).
 *
 * Imports the modules that own what an order (or an order photo) references,
 * rather than reading their tables: `CustomersModule` answers "which customer
 * is this actor?", `AddressesModule` answers "is this address theirs?",
 * `ServicesModule` answers "is this service still offered?", and
 * `MastersModule` answers "is this actor the master assigned to this order?"
 * — needed only for a photo read, since order creation carries no master yet
 * (`docs/architecture/backend-architecture.md` § Module rules). `StorageModule`
 * arrives with issue #83 the same way it arrived in `MastersModule` for issue
 * #38: photos are uploaded straight to object storage through a presigned
 * URL, so this module needs the provider that mints one — and never the bytes
 * (ADR-0005).
 *
 * `OrdersService`, `OrdersRepository` and `OrderPhotosService` are all
 * exported: EPIC 7 dispatches these orders and EPIC 8 transitions them, every
 * one of those writes has to append to the audit trail this module owns, and
 * `admin-order-photos.service.ts` reads a photo through `OrderPhotosService`
 * rather than importing this module's repository directly
 * (`docs/architecture/backend-architecture.md` § Module rules).
 *
 * EPIC 7 (issue #103) adds two more exports and one table. `order_offers`
 * hangs off an order, so this module owns it and `OrderOffersRepository` is
 * the dispatch engine's write side of it. `OrderDispatchRegistry` is the slot
 * the engine fills at boot, and it is the reason this module knows nothing
 * about dispatch: creation announces "this order is searching" into the
 * registry, and what happens next is `DispatchModule`'s business — an arrow
 * that points only one way, so the two modules never import each other.
 */
@Module({
  imports: [
    DatabaseModule,
    CustomersModule,
    AddressesModule,
    ServicesModule,
    MastersModule,
    StorageModule,
  ],
  controllers: [OrdersController, OrderPhotosController],
  providers: [
    OrdersRepository,
    OrdersService,
    OrderOffersRepository,
    OrderPhotosRepository,
    OrderPhotosService,
    OrderDispatchRegistry,
  ],
  exports: [
    OrdersService,
    OrdersRepository,
    OrderOffersRepository,
    OrderPhotosService,
    // For `MaintenanceModule` (#92), which sweeps confirmed-but-never-attached
    // photos. The repository rather than the service: the sweep is not a
    // customer's request and has no actor to authorize.
    OrderPhotosRepository,
    OrderDispatchRegistry,
  ],
})
export class OrdersModule {}
