import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../config/config.tokens';
import { EnvValidationError, parseEnv } from '../config/parse-env';
import { CDN_PURGER } from './cdn-purger.types';
import { CdnModule } from './cdn.module';
import { CloudflareCdnPurger } from './cloudflare-cdn-purger';
import { StubCdnPurger, StubCdnPurgerInProductionError } from './stub-cdn-purger';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

const CLOUDFLARE_ENV = {
  ...BASE_ENV,
  CDN_PURGE_PROVIDER: 'cloudflare',
  CLOUDFLARE_ZONE_ID: '0123456789abcdef0123456789abcdef',
  CLOUDFLARE_PURGE_API_TOKEN: 't'.repeat(40),
};

@Global()
@Module({})
class EnvConfigModule {
  /** `ConfigModule`'s shape over a given environment, as `calls.module.test.ts` builds it. */
  static over(env: Record<string, string>): DynamicModule {
    return {
      module: EnvConfigModule,
      providers: [{ provide: APP_CONFIG, useFactory: () => parseEnv(env) }],
      exports: [APP_CONFIG],
    };
  }
}

function compile(env: Record<string, string>): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [EnvConfigModule.over(env), CdnModule],
  }).compile();
}

describe('CdnModule (issue #304)', () => {
  it('builds the stub by default', async () => {
    const moduleRef = await compile(BASE_ENV);

    expect(moduleRef.get(CDN_PURGER)).toBeInstanceOf(StubCdnPurger);
  });

  it('builds the Cloudflare purger when it is selected and configured', async () => {
    const moduleRef = await compile(CLOUDFLARE_ENV);

    expect(moduleRef.get(CDN_PURGER)).toBeInstanceOf(CloudflareCdnPurger);
  });

  it.each(['CLOUDFLARE_ZONE_ID', 'CLOUDFLARE_PURGE_API_TOKEN'] as const)(
    'fails to start under cloudflare without %s',
    async (variable) => {
      const env: Record<string, string> = { ...CLOUDFLARE_ENV };
      delete env[variable];

      const failure = compile(env);

      await expect(failure).rejects.toThrow(EnvValidationError);
      await expect(failure).rejects.toThrow(
        `${variable} is required when CDN_PURGE_PROVIDER=cloudflare`,
      );
    },
  );

  it('fails to start when production would fall back to the stub', async () => {
    await expect(compile({ ...BASE_ENV, NODE_ENV: 'production' })).rejects.toThrow(
      StubCdnPurgerInProductionError,
    );
  });

  it('refuses the purge token behind EXPO_PUBLIC_, where the app bundle would ship it', () => {
    expect(() =>
      parseEnv({ ...CLOUDFLARE_ENV, EXPO_PUBLIC_CLOUDFLARE_PURGE_API_TOKEN: 'leaked' }),
    ).toThrow(/EXPO_PUBLIC_CLOUDFLARE_PURGE_API_TOKEN/);
  });
});

describe('StubCdnPurger (issue #304)', () => {
  it('records every URL it is asked to purge, in order', async () => {
    const purger = new StubCdnPurger('test');

    await purger.purgeUrls(['https://m.example.com/a', 'https://m.example.com/b']);
    await purger.purgeUrls(['https://m.example.com/a']);

    expect(purger.purged()).toEqual([
      'https://m.example.com/a',
      'https://m.example.com/b',
      'https://m.example.com/a',
    ]);
  });

  it('refuses to construct in production', () => {
    expect(() => new StubCdnPurger('production')).toThrow(StubCdnPurgerInProductionError);
  });
});
