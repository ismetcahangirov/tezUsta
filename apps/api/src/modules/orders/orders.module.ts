import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { AddressesModule } from '../addresses/addresses.module';
import { CustomersModule } from '../customers/customers.module';
import { MastersModule } from '../masters/masters.module';
import { ServicesModule } from '../services/services.module';
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
  providers: [OrdersRepository, OrdersService, OrderPhotosRepository, OrderPhotosService],
  exports: [OrdersService, OrdersRepository, OrderPhotosService],
})
export class OrdersModule {}
