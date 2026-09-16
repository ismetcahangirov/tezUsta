import { Module } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DatabaseModule } from '../../infra/database/database.module';
import { UsersModule } from '../users/users.module';
import { ActorService } from './actor.service';
import { AuthController } from './auth.controller';
import { createAuthConfig } from './auth.config';
import { AUTH_CONFIG } from './auth.tokens';
import { SessionsRepository } from './sessions.repository';
import { SessionsService } from './sessions.service';
import { TokenService } from './token.service';

/**
 * Tokens, device sessions, and (from issue #29) OTP.
 *
 * The {@link AUTH_CONFIG} factory is where this module refuses to start
 * without `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET`. `AppConfig` types both
 * as optional because EPIC 1 shipped before anything signed a token;
 * `app-config.types.ts` states the rule that follows — the module that first
 * needs the value fails its own startup if it is still missing. Because the
 * factory runs while Nest builds the injector, that failure happens during
 * `NestFactory.create`, so `main.ts` prints it and exits non-zero rather than
 * the service accepting traffic it cannot authenticate.
 *
 * `TokenService` and `ActorService` are exported because `AppModule` registers
 * `AuthenticationGuard` and `RolesGuard` as `APP_GUARD` providers (issue #27).
 * Nest builds an `APP_GUARD` in the injector context of the module that
 * declares it, so the guards' constructor dependencies must be resolvable from
 * `AppModule` — which is what these exports do. The guards themselves are not
 * providers here: declaring them in both places would give the process two
 * instances, one of which nothing ever calls.
 */
@Module({
  imports: [DatabaseModule, UsersModule],
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_CONFIG,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createAuthConfig(config),
    },
    TokenService,
    SessionsRepository,
    SessionsService,
    ActorService,
  ],
  exports: [TokenService, SessionsService, ActorService],
})
export class AuthModule {}
