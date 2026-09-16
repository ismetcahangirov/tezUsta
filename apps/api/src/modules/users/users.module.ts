import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { UsersRepository } from './users.repository';

/**
 * Identity. It owns `users` and `user_roles`, and every other module reads
 * them through this one rather than importing the repository directly
 * (`docs/architecture/backend-architecture.md` § Module rules: "A module owns
 * its data").
 *
 * Deliberately thin: EPIC 2 needs identity to exist so a session can point at
 * it. Customer and master **profiles** are separate tables owned by their own
 * modules (EPIC 4 and EPIC 5) and are not anticipated here.
 */
@Module({
  imports: [DatabaseModule],
  providers: [UsersRepository],
  exports: [UsersRepository],
})
export class UsersModule {}
