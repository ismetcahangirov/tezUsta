import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../config/config.tokens';
import { parseEnv } from '../config/parse-env';
import { BillingInfraModule } from './billing.module';
import { BILLING_PROVIDER } from './billing.types';
import { createPaymentTokenBox, MissingBillingTokenKeyError } from './payment-token-box';
import { StubBillingProvider, StubBillingProviderInProductionError } from './stub-billing.provider';

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

function compile(env: Record<string, string>): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [EnvConfigModule.over(env), BillingInfraModule],
  }).compile();
}

describe('BillingInfraModule (issue #323)', () => {
  it('builds the stub by default', async () => {
    const moduleRef = await compile(BASE_ENV);

    expect(moduleRef.get(BILLING_PROVIDER)).toBeInstanceOf(StubBillingProvider);
  });

  it('refuses to start in production without the token key (#424)', () => {
    const config = parseEnv({ ...BASE_ENV, NODE_ENV: 'production' });

    expect(() => createPaymentTokenBox(config)).toThrow(MissingBillingTokenKeyError);
  });

  it('refuses a return URL that is not https (#424)', () => {
    expect(() => parseEnv({ ...BASE_ENV, BILLING_RETURN_URL: 'http://tezusta.az/return' })).toThrow(
      /BILLING_RETURN_URL/,
    );
    expect(
      parseEnv({ ...BASE_ENV, BILLING_RETURN_URL: 'https://tezusta.az/return' }).billing.returnUrl,
    ).toBe('https://tezusta.az/return');
  });

  it('fails to start in production while the provider is the stub', async () => {
    await expect(compile({ ...BASE_ENV, NODE_ENV: 'production' })).rejects.toThrow(
      StubBillingProviderInProductionError,
    );
  });

  it('refuses a provider that does not exist', () => {
    expect(() => parseEnv({ ...BASE_ENV, BILLING_PROVIDER: 'payriff' })).toThrow(
      /BILLING_PROVIDER/,
    );
  });
});
