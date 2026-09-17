import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { CustomersModule } from '../customers/customers.module';
import { AddressesController } from './addresses.controller';
import { AddressesRepository } from './addresses.repository';
import { AddressesService } from './addresses.service';

/**
 * Saved customer addresses (EPIC 4, issue #35).
 *
 * Imports `CustomersModule` rather than reading `customers` itself: an address
 * hangs off the customer profile, and "which customer is this actor?" is a
 * question that module owns the answer to
 * (`docs/architecture/backend-architecture.md` § Module rules). Going through
 * `CustomersService` also means the "caller has no customer profile" 404 is
 * decided in one place instead of being re-derived here.
 *
 * `AddressesService` is exported because EPIC 6 creates orders against a saved
 * address and must resolve one through this module rather than by querying the
 * table. The repository is not exported, for the same reason.
 */
@Module({
  imports: [DatabaseModule, CustomersModule],
  controllers: [AddressesController],
  providers: [AddressesRepository, AddressesService],
  exports: [AddressesService],
})
export class AddressesModule {}
