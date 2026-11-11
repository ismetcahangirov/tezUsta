import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../infra/database/database.module';
import { EmailModule } from '../../infra/email/email.module';
import { RateLimitModule } from '../../infra/rate-limit/rate-limit.module';
import { StorageModule } from '../../infra/storage/storage.module';
import { AdminModule } from '../admin/admin.module';
import { OtpModule } from '../auth/otp.module';
import { AccountRecoveryCancelController } from './account-recovery-cancel.controller';
import { AccountRecoveryPhotosRepository } from './account-recovery-photos.repository';
import { AccountRecoveryPhotosService } from './account-recovery-photos.service';
import { AccountRecoveryRepository } from './account-recovery.repository';
import { AccountRecoveryService } from './account-recovery.service';
import { AdminAccountRecoveryController } from './admin-account-recovery.controller';

/**
 * Support-mediated account recovery (#515,
 * [ADR-0074](docs/decisions/ADR-0074-account-recovery-and-email-change.md)
 * §§ 2–5).
 *
 * Its own module rather than more of `AdminModule`: it needs the code flow and
 * the address mover from `OtpModule` and the audit log from `AdminModule`, and
 * it owns a public route that is not an admin route at all.
 */
@Module({
  imports: [AdminModule, DatabaseModule, EmailModule, OtpModule, RateLimitModule, StorageModule],
  controllers: [AdminAccountRecoveryController, AccountRecoveryCancelController],
  providers: [
    AccountRecoveryRepository,
    AccountRecoveryService,
    AccountRecoveryPhotosRepository,
    AccountRecoveryPhotosService,
  ],
  // The maintenance sweep clears presigns nobody confirmed.
  exports: [AccountRecoveryPhotosRepository],
})
export class AccountRecoveryModule {}
