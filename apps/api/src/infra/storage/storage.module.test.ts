import { Global, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { APP_CONFIG } from '../config/config.tokens';
import { parseEnv } from '../config/parse-env';
import { S3StorageProvider } from './s3-storage.provider';
import { IncompleteS3StorageConfigError } from './storage.config';
import { StorageModule } from './storage.module';
import { STORAGE_PROVIDER } from './storage.types';
import type { StorageProvider } from './storage.types';
import { StubStorageProvider } from './stub-storage.provider';

const BASE_ENV = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

const S3_ENV = {
  ...BASE_ENV,
  STORAGE_PROVIDER: 's3',
  S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
  S3_REGION: 'auto',
  S3_BUCKET: 'tezusta-uploads',
  S3_ACCESS_KEY_ID: 'key-id',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_PUBLIC_MEDIA_BUCKET: 'tezusta-media',
  MEDIA_PUBLIC_BASE_URL: 'https://media.example.com',
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
    imports: [EnvConfigModule.over(env), StorageModule],
  }).compile();
}

describe('StorageModule — the public media bucket (issue #304)', () => {
  it('builds the S3 provider when both buckets and the media domain are configured', async () => {
    const moduleRef = await compile(S3_ENV);
    const storage = moduleRef.get<StorageProvider>(STORAGE_PROVIDER);

    expect(storage).toBeInstanceOf(S3StorageProvider);
    expect(storage.publicUrl('portfolio/r/thumb.webp')).toBe(
      'https://media.example.com/portfolio/r/thumb.webp',
    );
  });

  it.each(['S3_PUBLIC_MEDIA_BUCKET', 'MEDIA_PUBLIC_BASE_URL'] as const)(
    'fails to start — not at the first upload — under s3 without %s',
    async (variable) => {
      const env: Record<string, string> = { ...S3_ENV };
      delete env[variable];

      const failure = compile(env);

      await expect(failure).rejects.toThrow(IncompleteS3StorageConfigError);
      await expect(failure).rejects.toThrow(variable);
    },
  );

  it('names both public values at once when neither is set', async () => {
    const env: Record<string, string> = { ...S3_ENV };
    delete env.S3_PUBLIC_MEDIA_BUCKET;
    delete env.MEDIA_PUBLIC_BASE_URL;

    await expect(compile(env)).rejects.toThrow(
      /S3_PUBLIC_MEDIA_BUCKET, MEDIA_PUBLIC_BASE_URL are not set/,
    );
  });

  it('builds the stub without them, and the stub names URLs on MEDIA_PUBLIC_BASE_URL when it is set', async () => {
    const moduleRef = await compile({
      ...BASE_ENV,
      MEDIA_PUBLIC_BASE_URL: 'http://localhost:9000/media',
    });
    const storage = moduleRef.get<StorageProvider>(STORAGE_PROVIDER);

    expect(storage).toBeInstanceOf(StubStorageProvider);
    expect(storage.publicUrl('a/b.webp')).toBe('http://localhost:9000/media/a/b.webp');
  });
});
