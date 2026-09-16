import { Module } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DatabaseModule } from '../../infra/database/database.module';
import { RateLimitModule } from '../../infra/rate-limit/rate-limit.module';
import { SmsModule } from '../../infra/sms/sms.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from './auth.module';
import { OtpController } from './otp.controller';
import { createOtpConfig } from './otp.config';
import { OtpRepository } from './otp.repository';
import { OtpService } from './otp.service';
import { OTP_CONFIG } from './otp.tokens';

/**
 * Phone + OTP sign-in (issue #29): the `otp_challenges` table, the two public
 * endpoints, and the sender wiring behind them.
 *
 * Separate from {@link AuthModule} rather than folded into it, because the two
 * own different data and have different lifetimes. `AuthModule` owns tokens
 * and device sessions, which every authenticated request in the system
 * depends on; this module owns a short-lived credential that exists only
 * between a request and a verification, and which nothing else in the API ever
 * reads. Keeping it separate also means the day a second credential path
 * exists — the admin form (EPIC 13, ADR-0014) — it sits alongside this one
 * rather than inside a module that has already grown to mean "everything
 * about authentication".
 *
 * It imports `AuthModule` for {@link SessionsService} rather than reaching for
 * `SessionsRepository`: OTP verification proves a phone number and then asks
 * the sessions layer to open a session, which is the one place that re-reads
 * account status and roles before minting anything
 * (`docs/architecture/backend-architecture.md` § Module rules — "cross-module
 * reads go through the owning module's service"). The dependency runs one way
 * only, so there is no cycle for `no-circular` to fail on.
 *
 * The {@link OTP_CONFIG} factory is where this module refuses to start without
 * `OTP_CODE_PEPPER`, mirroring `AuthModule`'s treatment of the JWT secrets and
 * `RateLimitModule`'s of the rate-limit pepper, for the reason
 * `app-config.types.ts` states: the module that first needs an optional value
 * is the one responsible for failing its own startup when it is missing.
 * Because the factory runs while Nest builds the injector, that failure
 * happens during `NestFactory.create` — the deploy stops instead of accepting
 * sign-ins it cannot store safely.
 */
@Module({
  imports: [AuthModule, DatabaseModule, RateLimitModule, SmsModule, UsersModule],
  controllers: [OtpController],
  providers: [
    {
      provide: OTP_CONFIG,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createOtpConfig(config),
    },
    OtpRepository,
    OtpService,
  ],
})
export class OtpModule {}
