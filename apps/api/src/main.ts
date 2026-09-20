import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { FastifyAdapter } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import type { AppConfig } from './infra/config/app-config.types';
import { APP_CONFIG } from './infra/config/config.tokens';
import { loadEnvFileIfPresent } from './infra/config/load-env-file';
import { EnvValidationError } from './infra/config/parse-env';
import { createAppLogger } from './infra/observability/log-levels';

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
  //
  // `bufferLogs` with `autoFlushLogs: false` is what lets `LOG_LEVEL` govern
  // the bootstrap lines too (#129). The logger is an option of `create`, but
  // `APP_CONFIG` does not exist until `create` has built the container — so
  // every line Nest writes on its way up would otherwise be printed before
  // anything had read the variable. Buffered and flushed by hand, they go
  // through the configured logger like everything else, and an operator who
  // set `LOG_LEVEL=warn` does not get twenty `log` lines anyway.
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    abortOnError: false,
    bufferLogs: true,
    autoFlushLogs: false,
  });

  // The global interceptor, filter and pipe are registered by AppModule as
  // APP_INTERCEPTOR / APP_FILTER / APP_PIPE providers, not here — see the
  // comment in app.module.ts. Registering them in this file would leave them
  // out of every test, which is how a leak guarantee rots unnoticed.

  // Without this, a real SIGTERM/SIGINT (e.g. `docker stop`, a Kubernetes
  // eviction) kills the process immediately and skips every module's
  // `onModuleDestroy` — including DatabaseModule's `pool.end()` and
  // RedisModule's `client.disconnect()` (issue #22). `Test.createTestingModule`
  // based tests already call those hooks via `app.close()` regardless of this
  // line; this is what makes the same cleanup happen outside a test too.
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(APP_CONFIG);

  // `LOG_LEVEL`, applied (#129). It was parsed, validated and ignored for
  // five Epics, which is worse than absent: an operator raising it to quiet a
  // flood of expected 401s during an incident got no change in volume and no
  // indication that the knob was inert.
  //
  // This is the one global the application installs from `main.ts` rather
  // than from `AppModule` — the exception `app.module.ts`'s docblock argues
  // against, and it applies because Nest's logger is genuinely not a
  // provider. `Test.createTestingModule` installs its own `TestingLogger`
  // regardless, so no suite's logging behaviour is downstream of this call;
  // the mapping it depends on is unit-tested against a real `ConsoleLogger`
  // in `infra/observability/log-levels.test.ts` instead.
  app.useLogger(createAppLogger(config.observability.logLevel));
  app.flushLogs();

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
