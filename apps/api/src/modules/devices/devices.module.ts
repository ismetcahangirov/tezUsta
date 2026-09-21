import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { DevicesController } from './devices.controller';
import { DevicesRepository } from './devices.repository';
import { DevicesService } from './devices.service';

/**
 * The device registry (EPIC 10, issue #140).
 *
 * Imports nothing but `DatabaseModule`, because a device hangs off the
 * account rather than off a role profile — there is no `CustomersModule` here,
 * and deliberately so: a phone belongs to a person, not to one of their two
 * roles.
 *
 * `DevicesService` is exported because the notifications worker (issue #141)
 * has to resolve "every live device of this user" through this module rather
 * than by querying the table. The repository is not exported, for the same
 * reason `AddressesModule` keeps its own private.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [DevicesController],
  providers: [DevicesRepository, DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
