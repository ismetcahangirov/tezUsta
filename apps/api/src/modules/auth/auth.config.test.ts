import { describe, expect, it } from 'vitest';

import { parseEnv } from '../../infra/config/parse-env';
import { createAuthConfig, MissingAuthSecretError } from './auth.config';

/**
 * Minimal environment `parseEnv` accepts, with neither JWT secret set —
 * `AppConfig.auth.jwtAccessSecret`/`jwtRefreshSecret` are typed
 * `string | undefined` for exactly this reason (EPIC 1 shipped before EPIC 2).
 * Built via the real `parseEnv` rather than a hand-typed `AppConfig` literal,
 * so this test cannot drift from the real schema (`app-config.types.ts`'s own
 * instruction, followed the same way `parse-env.test.ts` does).
 */
const BASE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:15432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

const ACCESS_SECRET = 'x'.repeat(32);
const REFRESH_SECRET = 'y'.repeat(32);

describe('createAuthConfig', () => {
  it('throws MissingAuthSecretError naming JWT_ACCESS_SECRET when it is absent', () => {
    const config = parseEnv(BASE_ENV);
    expect(config.auth.jwtAccessSecret).toBeUndefined();

    expect(() => createAuthConfig(config)).toThrow(MissingAuthSecretError);
    try {
      createAuthConfig(config);
      throw new Error('expected createAuthConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAuthSecretError);
      expect((error as MissingAuthSecretError).message).toContain('JWT_ACCESS_SECRET');
    }
  });

  it('throws MissingAuthSecretError naming JWT_REFRESH_SECRET when only that is absent', () => {
    const config = parseEnv({ ...BASE_ENV, JWT_ACCESS_SECRET: ACCESS_SECRET });
    expect(config.auth.jwtAccessSecret).toBe(ACCESS_SECRET);
    expect(config.auth.jwtRefreshSecret).toBeUndefined();

    try {
      createAuthConfig(config);
      throw new Error('expected createAuthConfig to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingAuthSecretError);
      expect((error as MissingAuthSecretError).message).toContain('JWT_REFRESH_SECRET');
      // And must not be misreported as the access secret being the problem.
      expect((error as MissingAuthSecretError).message).not.toContain(
        'JWT_ACCESS_SECRET is not set',
      );
    }
  });

  it('returns 900 seconds for the default 15m access TTL and 2_592_000_000 ms for the default 30d refresh TTL, when both secrets are present', () => {
    const config = parseEnv({
      ...BASE_ENV,
      JWT_ACCESS_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
    });

    const authConfig = createAuthConfig(config);

    expect(authConfig.accessSecret).toBe(ACCESS_SECRET);
    expect(authConfig.refreshSecret).toBe(REFRESH_SECRET);
    expect(authConfig.accessTtlSeconds).toBe(900);
    expect(authConfig.refreshTtlMs).toBe(2_592_000_000);
  });
});
