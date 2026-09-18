import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { AddressesModule } from '../addresses/addresses.module';
import { CustomersModule } from '../customers/customers.module';
import { ServicesModule } from '../services/services.module';
import { OrdersController } from './orders.controller';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';

/**
 * Orders (EPIC 6, issue #81).
 *
 * Imports the three modules that own what an order references, rather than
 * reading their tables: `CustomersModule` answers "which customer is this
 * actor?", `AddressesModule` answers "is this address theirs?" and
 * `ServicesModule` answers "is this service still offered?"
 * (`docs/architecture/backend-architecture.md` § Module rules). Each of those
 * questions already has one answer, and querying around them would create a
 * second.
 *
 * `OrdersService` and `OrdersRepository` are both exported: EPIC 7 dispatches
 * these orders and EPIC 8 transitions them, and every one of those writes has
 * to append to the audit trail this module owns.
 */
@Module({
  imports: [DatabaseModule, CustomersModule, AddressesModule, ServicesModule],
  controllers: [OrdersController],
  providers: [OrdersRepository, OrdersService],
  exports: [OrdersService, OrdersRepository],
})
export class OrdersModule {}
