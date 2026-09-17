import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { UsersModule } from '../users/users.module';
import { CustomersController } from './customers.controller';
import { CustomersRepository } from './customers.repository';
import { CustomersService } from './customers.service';

/**
 * The customer role profile (EPIC 4, issue #34).
 *
 * Imports `UsersModule` rather than reaching into `user_roles` itself: this
 * module owns `customers` and nothing else, and the role grant that has to
 * commit alongside a new profile runs through `UsersRepository.grantRole` on
 * the transaction this module opens (`docs/architecture/backend-architecture.md`
 * § Module rules).
 *
 * `CustomersService` is exported because EPIC 4's addresses (issue #35) and
 * EPIC 6's orders both need to resolve "which customer is this actor?" — and
 * must do it through this module, not by querying the table. The repository is
 * not exported, for the same reason.
 */
@Module({
  imports: [DatabaseModule, UsersModule],
  controllers: [CustomersController],
  providers: [CustomersRepository, CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
