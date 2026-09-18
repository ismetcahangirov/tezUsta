import { Module } from '@nestjs/common';

import type { AppConfig } from '../config/app-config.types';
import { APP_CONFIG } from '../config/config.tokens';
import { S3StorageProvider } from './s3-storage.provider';
import { requireS3StorageConfig } from './storage.config';
import { STORAGE_PROVIDER } from './storage.types';
import type { StorageProvider } from './storage.types';
import { StubStorageProvider } from './stub-storage.provider';

/**
 * Chooses the {@link StorageProvider} implementation from validated
 * configuration — the same shape `SmsModule` and `GeocodingModule` take.
 *
 * `STORAGE_PROVIDER` is an enum in `env.schema.ts`, which is what makes the
 * `switch` exhaustive and removes the need for a defensive `default`. The
 * stub refuses to construct under `NODE_ENV=production`, so a production
 * deploy that forgot to configure storage fails during `NestFactory.create`,
 * with a message naming the variable, rather than on the first upload.
 */
function createStorageProvider(config: AppConfig): StorageProvider {
  switch (config.storage.provider) {
    case 's3':
      return new S3StorageProvider(requireS3StorageConfig(config));
    case 'stub':
      return new StubStorageProvider(config.runtime.nodeEnv);
  }
}

@Module({
  providers: [
    {
      provide: STORAGE_PROVIDER,
      inject: [APP_CONFIG],
      useFactory: createStorageProvider,
    },
  ],
  exports: [STORAGE_PROVIDER],
})
export class StorageModule {}
