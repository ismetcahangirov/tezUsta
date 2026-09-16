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

  it('accepts "0ms" and returns 0 — this parser handles the grammar, not policy', () => {
    // A zero-length duration is a perfectly well-formed string by this
    // function's own grammar; it is `env.schema.ts`'s `duration()` range
    // refinement (`must be between 1m and 1h` / `1h and 90d`) that actually
    // rejects `JWT_ACCESS_TTL=0s`/`JWT_REFRESH_TTL=0s` as catastrophic, not
    // this function. See `parse-env.test.ts`'s
    // "must fall within their documented ranges" tests for that half of the
    // guarantee — the two files are not in tension, they cover different
    // concerns.
    expect(parseDurationMs('0ms')).toBe(0);
  });
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
 * `duration('15m', 60_000, 3_600_000)` field JWT_ACCESS_TTL uses) rather than
 * a copy of the regex pasted into this file, which would only prove this test
 * agrees with itself.
 *
 * `JWT_ACCESS_TTL` now also enforces a **range** (1 minute to 1 hour) on top
 * of the grammar, so `accepted` below is deliberately restricted to values
 * that satisfy both — a grammatically valid but out-of-range value such as
 * `30d` is covered on its own terms by `parse-env.test.ts`'s "must fall
 * within their documented ranges" tests, not here, where the claim under test
 * is grammar agreement, not policy.
 *
 * Empty string is excluded from this comparison: the schema treats an empty
 * variable as "unset" and substitutes its default (`emptyToUndefined` +
 * `.default(...)` in `duration()`), which is configuration-loading behaviour
 * that has no equivalent in `parseDurationMs` — covered separately above,
 * where `parseDurationMs('')` must throw.
 */
describe('agreement with the DURATION_PATTERN regex in env.schema.ts', () => {
  const accepted = ['60000ms', '1m', '30m', '1h', '3600s'];
  const rejected = ['5x', '-1h', '1.5h', '2 days', '15M', 'm', '15', '15 m', '15mm', '+5m'];

  it.each(accepted)('a string the schema accepts (%j) is parseable here', (value) => {
    expect(rawEnvSchema.shape.JWT_ACCESS_TTL.safeParse(value).success).toBe(true);
    expect(() => parseDurationMs(value)).not.toThrow();
  });

  /**
   * `env.schema.ts`'s `duration()` chains `.regex(DURATION_PATTERN).refine(...
   * parseDurationMs ...)`. Zod v4 runs every check in that chain regardless of
   * whether an earlier one already failed, so for a value the regex rejects,
   * the refine callback still runs and calls `parseDurationMs` on the same
   * grammar-invalid string — which throws `InvalidDurationError` rather than
   * returning a boolean. `.safeParse()` does not catch an error thrown out of
   * a refine callback (only a rejected `ZodError`), so it propagates instead
   * of the graceful `{ success: false }` "safe" parse promises. That is a
   * latent bug in `env.schema.ts` independent of the fixes this test suite
   * was written to cover, and out of scope for a test-only change — captured
   * explicitly below rather than swallowed, so a fix (having the refine
   * short-circuit past inputs that already failed the regex) simply makes
   * `schemaRejects` return via the `safeParse` branch instead of the `catch`,
   * and this test keeps passing either way.
   */
  function schemaRejects(value: string): boolean {
    try {
      return !rawEnvSchema.shape.JWT_ACCESS_TTL.safeParse(value).success;
    } catch (error) {
      return error instanceof InvalidDurationError;
    }
  }

  it.each(rejected)('a string the schema rejects (%j) is also rejected here', (value) => {
    expect(schemaRejects(value)).toBe(true);
    expect(() => parseDurationMs(value)).toThrow(InvalidDurationError);
  });
});
