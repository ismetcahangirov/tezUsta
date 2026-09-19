import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { PresenceModule } from '../../infra/presence/presence.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { UsersModule } from '../users/users.module';
import { MasterAvailabilityController } from './master-availability.controller';
import { MasterAvailabilityService } from './master-availability.service';
import { MasterLocationController } from './master-location.controller';
import { MasterLocationRepository } from './master-location.repository';
import { MasterLocationService } from './master-location.service';
import { MasterVerificationController } from './master-verification.controller';
import { MasterVerificationRepository } from './master-verification.repository';
import { MasterVerificationService } from './master-verification.service';
import { MastersController } from './masters.controller';
import { MastersRepository } from './masters.repository';
import { MastersService } from './masters.service';

/**
 * Master role profiles and the catalogue services a master offers (issue #37).
 *
 * `UsersModule` is imported for the role grant that runs inside the
 * profile-creation transaction — an account must never exist in the half-state
 * where it has a master profile the guards will not let it use.
 *
 * `StorageModule` arrives with issue #38: verification documents are uploaded
 * straight to object storage through a presigned URL, so this module needs the
 * provider that mints one — and never the bytes (ADR-0005).
 *
 * The services are exported and the repositories are not: EPIC 7 will ask "may
 * this master accept work?", and issue #39's admin surface will ask about a
 * master's documents, and both ask a service rather than the table
 * (`docs/architecture/backend-architecture.md` § Module rules).
 *
 * Issue #98 adds `master_locations` and the endpoint that writes it. It lands
 * here rather than in a module of its own because a position report is
 * inseparable from availability — it refreshes the same presence key, it is
 * refused on the same eligibility rules, and splitting it out would mean two
 * modules owning two halves of "is this master working right now?".
 */
@Module({
  imports: [DatabaseModule, PresenceModule, StorageModule, UsersModule],
  controllers: [
    MastersController,
    MasterVerificationController,
    MasterAvailabilityController,
    MasterLocationController,
  ],
  providers: [
    MastersRepository,
    MastersService,
    MasterVerificationRepository,
    MasterVerificationService,
    MasterAvailabilityService,
    MasterLocationRepository,
    MasterLocationService,
  ],
  exports: [MastersService, MasterVerificationService, MasterAvailabilityService],
})
export class MastersModule {}
