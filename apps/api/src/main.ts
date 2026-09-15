import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestIdInterceptor } from './common/interceptors/request-id.interceptor';
import { ZodValidationPipe } from './common/pipes/zod-validation.pipe';
import type { AppConfig } from './infra/config/app-config.types';
import { APP_CONFIG } from './infra/config/config.tokens';
import { loadEnvFileIfPresent } from './infra/config/load-env-file';
import { EnvValidationError } from './infra/config/parse-env';

async function bootstrap(): Promise<void> {
  // Local development only — a missing .env is not fatal, and production
  // never reads one (see load-env-file.ts).
  loadEnvFileIfPresent();

  // `abortOnError: false` is load-bearing: Nest's default (`true`) logs a
  // bootstrap failure itself and calls `process.exit(1)` from inside
  // `NestFactory.create`, which would run its own stack-trace dump before
  // this file's `.catch()` below ever sees the error. Turning it off makes
  // `create` reject instead, so this file is what decides what gets printed
  // and that the exit code is non-zero.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    abortOnError: false,
  });

  app.useGlobalInterceptors(new RequestIdInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ZodValidationPipe());

  // Without this, a real SIGTERM/SIGINT (e.g. `docker stop`, a Kubernetes
  // eviction) kills the process immediately and skips every module's
  // `onModuleDestroy` — including DatabaseModule's `pool.end()` and
  // RedisModule's `client.disconnect()` (issue #22). `Test.createTestingModule`
  // based tests already call those hooks via `app.close()` regardless of this
  // line; this is what makes the same cleanup happen outside a test too.
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);

  // Bind to 0.0.0.0, not Fastify's 127.0.0.1 default, so the process is
  // reachable from outside its own container.
  await app.listen(config.runtime.port, config.runtime.host);
  Logger.log(`API listening on http://${config.runtime.host}:${config.runtime.port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // Deliberately console.error, not the Nest Logger: the app never
    // finished bootstrapping, so no logger transport is configured yet, and
    // this is the one place allowed to print configuration problems.
    console.error(error.message);
  } else {
    console.error('Fatal error during bootstrap:', error);
  }
  process.exit(1);
});
