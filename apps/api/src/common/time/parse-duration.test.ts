import { describe, expect, it } from 'vitest';

import { rawEnvSchema } from '../../infra/config/env.schema';
import { InvalidDurationError, parseDurationMs, parseDurationSeconds } from './parse-duration';

describe('parseDurationMs', () => {
  it('converts every unit correctly', () => {
    expect(parseDurationMs('5ms')).toBe(5);
    expect(parseDurationMs('5s')).toBe(5_000);
    expect(parseDurationMs('5m')).toBe(300_000);
    expect(parseDurationMs('5h')).toBe(18_000_000);
    expect(parseDurationMs('5d')).toBe(432_000_000);
  });

  it('converts the two real defaults', () => {
    expect(parseDurationMs('15m')).toBe(15 * 60_000);
    expect(parseDurationMs('30d')).toBe(30 * 86_400_000);
  });

  it.each(['', '15', 'm', '-1h', '1.5h', '2 days', '15M'])(
    'rejects %j with InvalidDurationError',
    (value) => {
      expect(() => parseDurationMs(value)).toThrow(InvalidDurationError);
    },
  );
});

describe('parseDurationSeconds', () => {
  it('truncates rather than rounds, as documented', () => {
    // 1500ms truncates to 1 second, not 2 — Math.floor, not Math.round.
    expect(parseDurationSeconds('1500ms')).toBe(1);
    expect(parseDurationSeconds('999ms')).toBe(0);
  });

  it('matches the millisecond value for the two real defaults', () => {
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('30d')).toBe(2_592_000);
  });
});

/**
 * `DURATION_PATTERN` in `infra/config/env.schema.ts` is not exported — by
 * design, it is private schema-building detail — so agreement is checked
 * through the schema it builds (`rawEnvSchema.shape.JWT_ACCESS_TTL`, the exact
 * `duration('15m')` field JWT_ACCESS_TTL uses) rather than a copy of the
 * regex pasted into this file, which would only prove this test agrees with
 * itself.
 *
 * Empty string is excluded from this comparison: the schema treats an empty
 * variable as "unset" and substitutes its default (`emptyToUndefined` +
 * `.default(...)` in `duration()`), which is configuration-loading behaviour
 * that has no equivalent in `parseDurationMs` — covered separately above,
 * where `parseDurationMs('')` must throw.
 */
describe('agreement with the DURATION_PATTERN regex in env.schema.ts', () => {
  const accepted = ['0ms', '1ms', '15m', '30d', '3600s', '999d', '1h', '10s', '100h'];
  const rejected = ['5x', '-1h', '1.5h', '2 days', '15M', 'm', '15', '15 m', '15mm', '+5m'];

  it.each(accepted)('a string the schema accepts (%j) is parseable here', (value) => {
    expect(rawEnvSchema.shape.JWT_ACCESS_TTL.safeParse(value).success).toBe(true);
    expect(() => parseDurationMs(value)).not.toThrow();
  });

  it.each(rejected)('a string the schema rejects (%j) is also rejected here', (value) => {
    expect(rawEnvSchema.shape.JWT_ACCESS_TTL.safeParse(value).success).toBe(false);
    expect(() => parseDurationMs(value)).toThrow(InvalidDurationError);
  });
});
