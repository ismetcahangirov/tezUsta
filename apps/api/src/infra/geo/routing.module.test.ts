import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../config/config.tokens';
import { parseEnv } from '../config/parse-env';
import { MissingGoogleMapsApiKeyError } from './geocoding.module';
import { GoogleRoutesProvider } from './google-routes.provider';
import { RoutingInfraModule } from './routing.module';
import { ROUTING_PROVIDER } from './routing.types';
import { StubRoutingProvider, StubRoutingProviderInProductionError } from './stub-routing.provider';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

@Global()
@Module({})
class EnvConfigModule {
  /** A global `APP_CONFIG` parsed from the given environment, never `process.env`. */
  static over(env: Record<string, string>): DynamicModule {
    return {
      module: EnvConfigModule,
      providers: [{ provide: APP_CONFIG, useFactory: () => parseEnv(env) }],
      exports: [APP_CONFIG],
    };
  }
}

/** Compiles the module as `AppModule` would, so a bad environment fails at boot. */
function compile(env: Record<string, string>): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [EnvConfigModule.over(env), RoutingInfraModule],
  }).compile();
}

describe('RoutingInfraModule (issue #395)', () => {
  it('builds the stub by default', async () => {
    const moduleRef = await compile(BASE_ENV);

    expect(moduleRef.get(ROUTING_PROVIDER)).toBeInstanceOf(StubRoutingProvider);
  });

  it('builds the Google Routes provider when Google is selected with a key', async () => {
    const moduleRef = await compile({
      ...BASE_ENV,
      MAPS_PROVIDER: 'google',
      GOOGLE_MAPS_SERVER_API_KEY: 'server-key',
    });

    expect(moduleRef.get(ROUTING_PROVIDER)).toBeInstanceOf(GoogleRoutesProvider);
  });

  it('fails to start, naming the variable, when Google is selected without a key', async () => {
    const failure = compile({ ...BASE_ENV, MAPS_PROVIDER: 'google' });

    await expect(failure).rejects.toThrow(MissingGoogleMapsApiKeyError);
    await expect(failure).rejects.toThrow(/GOOGLE_MAPS_SERVER_API_KEY/);
  });

  it('fails to start when production would fall back to the stub', async () => {
    await expect(compile({ ...BASE_ENV, NODE_ENV: 'production' })).rejects.toThrow(
      StubRoutingProviderInProductionError,
    );
  });
});
