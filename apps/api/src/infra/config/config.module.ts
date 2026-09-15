import { Global, Module } from '@nestjs/common';

import { APP_CONFIG } from './config.tokens';
import { parseEnv } from './parse-env';

/**
 * Global config module (`docs/architecture/backend-architecture.md` §
 * Configuration): parses and validates `process.env` exactly once, when this
 * provider is first resolved during `NestFactory.create` /
 * `Test.createTestingModule(...).compile()`, and hands out the frozen,
 * typed {@link AppConfig} via {@link APP_CONFIG} to any module that injects
 * it. `@Global()` means a feature module never lists this module as an
 * import to use the config — it imports it once, here, in `AppModule`.
 *
 * This is the ONLY provider in the codebase that reads `process.env` — every
 * other module takes the parsed value instead
 * (`docs/engineering/security.md`: "One schema, and it is the only reader of
 * `process.env`"). If `parseEnv` throws, that rejection propagates out of
 * `NestFactory.create`, which is what lets `main.ts` turn it into a
 * `console.error` + `process.exit(1)` without this module knowing anything
 * about process exit codes.
 */
@Global()
@Module({
  providers: [
    {
      provide: APP_CONFIG,
      useFactory: () => parseEnv(process.env),
    },
  ],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
