import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { ConfigModule } from './infra/config/config.module';
import { DatabaseModule } from './infra/database/database.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuthModule } from './modules/auth/auth.module';
import { AuthenticationGuard } from './modules/auth/authentication.guard';
import { RolesGuard } from './modules/auth/roles.guard';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';

/**
 * The globals are registered HERE, as module providers, rather than
 * through `app.useGlobal*()` in `main.ts`.
 *
 * `main.ts` is not imported by anything, so a global registered there exists
 * only in the shipped binary: a test that builds its own app via
 * `Test.createTestingModule({ imports: [AppModule] })` would not get it.
 * Deleting the `useGlobalFilters` line would then leave every test green while
 * the running service started returning driver text and stack traces to
 * clients — the exact guarantee `all-exceptions.filter.ts` exists to provide,
 * asserted against an app that only existed inside the test file.
 *
 * Registering them as providers makes the wiring part of `AppModule`, so the
 * integration tests exercise the real thing.
 *
 * That reasoning is sharpest for the two `APP_GUARD` entries, and they are why
 * this list must not move: they are what makes the API **secure by default**
 * (issue #27). A route that carries no decorator is protected because these
 * lines exist, so a `main.ts`-only registration would mean every test in the
 * repository exercised an application in which nothing was protected at all.
 *
 * **Order within `providers` is behaviour, not formatting.** Nest runs global
 * guards in registration order, and `RolesGuard` reads the actor that
 * `AuthenticationGuard` attaches; swapping the two lines would make every
 * `@Roles(...)` route reject its own users. The interceptor is listed first for
 * readability only — guards run before interceptors regardless, which is why
 * `ensureRequestId` is idempotent and called from both.
 */
@Module({
  imports: [ConfigModule, HealthModule, DatabaseModule, RedisModule, UsersModule, AuthModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
