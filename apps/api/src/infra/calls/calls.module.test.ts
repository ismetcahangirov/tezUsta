import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../config/config.tokens';
import { EnvValidationError, parseEnv } from '../config/parse-env';
import { CALL_MEDIA_PROVIDER } from './call-media.types';
import { CallsModule } from './calls.module';
import { LiveKitCallMediaProvider } from './livekit-call-media.provider';
import {
  StubCallMediaProvider,
  StubCallMediaProviderInProductionError,
} from './stub-call-media.provider';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

const LIVEKIT_ENV = {
  ...BASE_ENV,
  CALLS_PROVIDER: 'livekit',
  LIVEKIT_URL: 'wss://calls.example.com',
  LIVEKIT_API_KEY: 'APIkey123',
  LIVEKIT_API_SECRET: 'l'.repeat(40),
};

@Global()
@Module({})
class EnvConfigModule {
  /**
   * `ConfigModule`'s shape — a global `APP_CONFIG` whose factory parses an
   * environment — over a given environment instead of `process.env`, so
   * nothing here mutates the process and every case sees only its own values.
   */
  static over(env: Record<string, string>): DynamicModule {
    return {
      module: EnvConfigModule,
      providers: [{ provide: APP_CONFIG, useFactory: () => parseEnv(env) }],
      exports: [APP_CONFIG],
    };
  }
}

/**
 * Compiles `CallsModule` the way `AppModule` does at boot: the environment is
 * parsed inside the DI graph, and the provider is built from the result. A bad
 * environment therefore fails `compile()` exactly as it fails
 * `NestFactory.create` — "at startup", in the sense issue #184 means.
 */
function compile(env: Record<string, string>): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [EnvConfigModule.over(env), CallsModule],
  }).compile();
}

describe('CallsModule (issue #184)', () => {
  it('builds the stub by default', async () => {
    const moduleRef = await compile(BASE_ENV);

    expect(moduleRef.get(CALL_MEDIA_PROVIDER)).toBeInstanceOf(StubCallMediaProvider);
  });

  it('builds the LiveKit adapter when LiveKit is selected and configured', async () => {
    const moduleRef = await compile(LIVEKIT_ENV);

    expect(moduleRef.get(CALL_MEDIA_PROVIDER)).toBeInstanceOf(LiveKitCallMediaProvider);
  });

  it.each(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'] as const)(
    'fails to start — not at the first call — when LiveKit is selected without %s',
    async (variable) => {
      const env: Record<string, string> = { ...LIVEKIT_ENV };
      delete env[variable];

      const failure = compile(env);

      await expect(failure).rejects.toThrow(EnvValidationError);
      await expect(failure).rejects.toThrow(`${variable} is required when CALLS_PROVIDER=livekit`);
    },
  );

  it('fails to start when LiveKit is selected with the .env.example placeholder secret', async () => {
    await expect(
      compile({ ...LIVEKIT_ENV, LIVEKIT_API_SECRET: 'CHANGE_ME_generate_a_48_byte_random_value' }),
    ).rejects.toThrow(/LIVEKIT_API_SECRET is still the .env.example placeholder/);
  });

  it('fails to start when production would fall back to the stub', async () => {
    await expect(compile({ ...BASE_ENV, NODE_ENV: 'production' })).rejects.toThrow(
      StubCallMediaProviderInProductionError,
    );
  });
});
