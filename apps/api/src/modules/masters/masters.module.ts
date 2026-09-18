import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { UsersModule } from '../users/users.module';
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
 */
@Module({
  imports: [DatabaseModule, StorageModule, UsersModule],
  controllers: [MastersController, MasterVerificationController],
  providers: [
    MastersRepository,
    MastersService,
    MasterVerificationRepository,
    MasterVerificationService,
  ],
  exports: [MastersService, MasterVerificationService],
})
export class MastersModule {}
