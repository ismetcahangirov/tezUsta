import { describe, expect, it } from 'vitest';

import { findExpoPublicSecretViolations } from './env-guard';

describe('findExpoPublicSecretViolations', () => {
  it('returns nothing for an environment with no EXPO_PUBLIC_ variables', () => {
    expect(
      findExpoPublicSecretViolations({ DATABASE_URL: 'postgresql://x', NODE_ENV: 'production' }),
    ).toEqual([]);
  });

  it('returns nothing for the two documented client map-key exceptions', () => {
    expect(
      findExpoPublicSecretViolations({
        EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY: 'a',
        EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY: 'b',
      }),
    ).toEqual([]);
  });

  it('does not flag a non-secret EXPO_PUBLIC_ variable', () => {
    expect(
      findExpoPublicSecretViolations({
        EXPO_PUBLIC_API_URL: 'http://localhost:3000',
        EXPO_PUBLIC_WS_URL: 'ws://localhost:3000',
      }),
    ).toEqual([]);
  });

  it.each([
    'EXPO_PUBLIC_JWT_ACCESS_SECRET',
    'EXPO_PUBLIC_JWT_REFRESH_SECRET',
    'EXPO_PUBLIC_SOME_PRIVATE_KEY',
    'EXPO_PUBLIC_ADMIN_PASSWORD',
    'EXPO_PUBLIC_SESSION_TOKEN',
    'EXPO_PUBLIC_DATABASE_URL',
    'EXPO_PUBLIC_REDIS_URL',
    'EXPO_PUBLIC_GOOGLE_MAPS_SERVER_API_KEY',
  ])('flags %s as a secret smuggled behind EXPO_PUBLIC_', (key) => {
    const violations = findExpoPublicSecretViolations({ [key]: 'anything' });

    expect(violations).toEqual([key]);
  });

  it('reports every offending key at once, not just the first', () => {
    const violations = findExpoPublicSecretViolations({
      EXPO_PUBLIC_JWT_ACCESS_SECRET: 'a',
      EXPO_PUBLIC_DATABASE_URL: 'b',
      EXPO_PUBLIC_API_URL: 'fine',
    });

    expect(violations).toContain('EXPO_PUBLIC_JWT_ACCESS_SECRET');
    expect(violations).toContain('EXPO_PUBLIC_DATABASE_URL');
    expect(violations).not.toContain('EXPO_PUBLIC_API_URL');
    expect(violations).toHaveLength(2);
  });

  it('never returns the variable value, only its name', () => {
    const secretValue = 'this-must-never-appear-anywhere';
    const violations = findExpoPublicSecretViolations({ EXPO_PUBLIC_SECRET_KEY: secretValue });

    expect(violations).toEqual(['EXPO_PUBLIC_SECRET_KEY']);
    expect(JSON.stringify(violations)).not.toContain(secretValue);
  });

  it('rejects a plain API key or credential smuggled behind the prefix', () => {
    // Neither name contains SECRET/PRIVATE/PASSWORD/TOKEN, and both are shapes
    // .env.example actually ships. These are the violations the guard exists
    // for, so they must not depend on the author having picked a scary word.
    expect(findExpoPublicSecretViolations({ EXPO_PUBLIC_SMS_API_KEY: 'x' })).toEqual([
      'EXPO_PUBLIC_SMS_API_KEY',
    ]);
    expect(findExpoPublicSecretViolations({ EXPO_PUBLIC_S3_ACCESS_KEY_ID: 'x' })).toEqual([
      'EXPO_PUBLIC_S3_ACCESS_KEY_ID',
    ]);
    expect(findExpoPublicSecretViolations({ EXPO_PUBLIC_S3_CREDENTIAL: 'x' })).toEqual([
      'EXPO_PUBLIC_S3_CREDENTIAL',
    ]);
  });

  it('still admits the two documented map keys after that widening', () => {
    // Both contain 'KEY', so they only pass because the allow-list is checked
    // before the token scan. Widening the token list must not break them.
    expect(
      findExpoPublicSecretViolations({
        EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_API_KEY: 'a',
        EXPO_PUBLIC_GOOGLE_MAPS_IOS_API_KEY: 'b',
      }),
    ).toEqual([]);
  });
});
