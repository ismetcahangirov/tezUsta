import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { UsersModule } from '../users/users.module';
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
 * `MastersService` is exported and `MastersRepository` is not: EPIC 7 will ask
 * "may this master accept work?", and it asks the service, not the table
 * (`docs/architecture/backend-architecture.md` § Module rules).
 */
@Module({
  imports: [DatabaseModule, UsersModule],
  controllers: [MastersController],
  providers: [MastersRepository, MastersService],
  exports: [MastersService],
})
export class MastersModule {}
