import { Module } from '@nestjs/common';

import type { AppConfig } from '../../infra/config/app-config.types';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import { DatabaseModule } from '../../infra/database/database.module';
import { UsersModule } from '../users/users.module';
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
 * `TokenService` is exported because the guards (issue #27) verify access
 * tokens without owning session state.
 */
@Module({
  imports: [DatabaseModule, UsersModule],
  providers: [
    {
      provide: AUTH_CONFIG,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createAuthConfig(config),
    },
    TokenService,
    SessionsRepository,
    SessionsService,
  ],
  exports: [TokenService, SessionsService],
})
export class AuthModule {}
