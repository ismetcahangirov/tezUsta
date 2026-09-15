import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import { ConfigModule } from './infra/config/config.module';
import { DatabaseModule } from './infra/database/database.module';
import { RedisModule } from './infra/redis/redis.module';
import { HealthModule } from './modules/health/health.module';

/**
 * The three globals are registered HERE, as module providers, rather than
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
 */
@Module({
  imports: [ConfigModule, HealthModule, DatabaseModule, RedisModule],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestIdInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useClass: ZodValidationPipe },
  ],
})
export class AppModule {}
