import { Module } from '@nestjs/common';

import { CacheModule } from '../../infra/cache/cache.module';
import { DatabaseModule } from '../../infra/database/database.module';
import { ServicesController } from './services.controller';
import { ServicesRepository } from './services.repository';
import { ServicesService } from './services.service';

/**
 * The service catalogue (EPIC 3).
 *
 * `ServicesService` is exported because the catalogue is the one thing several
 * later modules have to read: an order references a service (EPIC 6), and a
 * master offers a set of them (EPIC 5). They read it through this service, not
 * by importing `ServicesRepository` or joining the tables themselves — a module
 * owns its data (`docs/architecture/backend-architecture.md` § Module rules),
 * and a join written elsewhere is a second place the `is_active` rule can be
 * forgotten.
 */
@Module({
  imports: [DatabaseModule, CacheModule],
  controllers: [ServicesController],
  providers: [ServicesRepository, ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
