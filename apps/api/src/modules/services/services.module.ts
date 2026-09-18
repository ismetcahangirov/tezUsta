import { Module } from '@nestjs/common';

import { CacheModule } from '../../infra/cache/cache.module';
import { DatabaseModule } from '../../infra/database/database.module';
import { MastersModule } from '../masters/masters.module';
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
 *
 * `MastersModule` arrives with issue #84: the indicative price-range read
 * joins `master_services` and `masters`, tables `MastersModule` owns, so this
 * module reaches them through its exported `MastersService`
 * (`MastersService.getEligiblePriceRange`) rather than importing
 * `MastersRepository` — the same rule that keeps `ServicesRepository` the only
 * place `is_active` is filtered for the catalogue, applied the other way.
 * `MastersModule` imports nothing that reaches back here, so this stays a
 * one-directional edge.
 */
@Module({
  imports: [DatabaseModule, CacheModule, MastersModule],
  controllers: [ServicesController],
  providers: [ServicesRepository, ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
