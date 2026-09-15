import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import type { AppConfig } from './app-config.types';
import { ConfigModule } from './config.module';
import { APP_CONFIG } from './config.tokens';

describe('ConfigModule', () => {
  it('provides the parsed AppConfig under the APP_CONFIG token when process.env is valid', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousRedisUrl = process.env.REDIS_URL;
    process.env.DATABASE_URL = 'postgresql://tezusta:tezusta@localhost:5432/tezusta_test';
    process.env.REDIS_URL = 'redis://localhost:6379';

    try {
      const moduleRef = await Test.createTestingModule({ imports: [ConfigModule] }).compile();
      const config = moduleRef.get<AppConfig>(APP_CONFIG);

      expect(config.database.url).toBe(process.env.DATABASE_URL);
      expect(config.redis.url).toBe(process.env.REDIS_URL);
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.runtime)).toBe(true);
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
      if (previousRedisUrl === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = previousRedisUrl;
      }
    }
  });

  it('fails module compilation when a required variable is missing from process.env', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      await expect(
        Test.createTestingModule({ imports: [ConfigModule] }).compile(),
      ).rejects.toThrow();
    } finally {
      if (previousDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
});
