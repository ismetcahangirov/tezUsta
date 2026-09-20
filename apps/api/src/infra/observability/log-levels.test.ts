import type { MockInstance } from 'vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppLogLevel } from '../config/app-config.types';
import { parseEnv } from '../config/parse-env';
import { EnvValidationError } from '../config/parse-env';
import { spyOnEveryLogSink } from '../../../test/support/log-sink';
import { createAppLogger, logLevelsFor } from './log-levels';

/**
 * `LOG_LEVEL`, applied (issue #129).
 *
 * The variable was parsed, validated, range-checked and then ignored, which
 * is worse than absent: an operator raising it during an incident got no
 * change in volume and no indication that the knob was inert. These
 * assertions are what make it real, and they run against a **real
 * `ConsoleLogger`** — the object `main.ts` installs — rather than against the
 * mapping alone, because a correct map installed into nothing would pass an
 * assertion about the map.
 */
const VALID_ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://tezusta:tezusta@localhost:5432/tezusta',
  REDIS_URL: 'redis://localhost:6379',
};

describe('logLevelsFor', () => {
  it('is a threshold: every level at or above the chosen one, and nothing below', () => {
    expect(logLevelsFor('debug')).toEqual(['verbose', 'debug', 'log', 'warn', 'error', 'fatal']);
    expect(logLevelsFor('info')).toEqual(['log', 'warn', 'error', 'fatal']);
    expect(logLevelsFor('warn')).toEqual(['warn', 'error', 'fatal']);
    expect(logLevelsFor('error')).toEqual(['error', 'fatal']);
  });

  it('never silences `fatal`, at any threshold', () => {
    // Nest's option is an enabled-set, not a floor, so `['error']` would drop
    // `fatal` — the one line that can never be worth hiding.
    for (const threshold of ['debug', 'info', 'warn', 'error'] as const) {
      expect(logLevelsFor(threshold)).toContain('fatal');
    }
  });

  it('keeps `warn` at every threshold but `error`', () => {
    // Expected client errors and rate-limit triggers are logged at `warn`
    // (#56). `docs/engineering/security.md` § Logging requires the triggers to
    // stay logged, which is why `error` is refused in production below rather
    // than merely documented.
    expect(logLevelsFor('debug')).toContain('warn');
    expect(logLevelsFor('info')).toContain('warn');
    expect(logLevelsFor('warn')).toContain('warn');
    expect(logLevelsFor('error')).not.toContain('warn');
  });
});

describe('createAppLogger, against a real ConsoleLogger', () => {
  let sink: string[];
  let spies: MockInstance[];

  beforeEach(() => {
    sink = [];
    spies = spyOnEveryLogSink(sink);
  });

  afterEach(() => {
    for (const spy of spies) {
      spy.mockRestore();
    }
  });

  function write(threshold: AppLogLevel): string {
    const logger = createAppLogger(threshold);
    logger.debug('line-at-debug');
    logger.log('line-at-log');
    logger.warn('line-at-warn');
    logger.error('line-at-error');
    logger.fatal('line-at-fatal');
    return sink.join('\n');
  }

  it('writes a line at or above the configured level and drops one below it', () => {
    const written = write('warn');

    // Positive control first: a "not written" assertion passes for free
    // against a logger that writes nothing at all, which is the exact failure
    // issue #127 exists to stop.
    expect(written).toContain('line-at-warn');
    expect(written).toContain('line-at-error');
    expect(written).toContain('line-at-fatal');

    expect(written).not.toContain('line-at-debug');
    expect(written).not.toContain('line-at-log');
  });

  it('prints every level at the `debug` threshold — what the process printed before #129', () => {
    const written = write('debug');

    for (const fragment of [
      'line-at-debug',
      'line-at-log',
      'line-at-warn',
      'line-at-error',
      'line-at-fatal',
    ]) {
      expect(written).toContain(fragment);
    }
  });

  it('keeps the security-relevant lines under the production default', () => {
    // `info` is what `NODE_ENV=production` resolves to with no LOG_LEVEL set.
    // A rate-limit trigger and an authentication failure are both `warn`
    // (`rate-limit.guard.ts`, `authentication.guard.ts`), so the production
    // default must not be a mapping that drops them.
    const production = parseEnv({ ...VALID_ENV, NODE_ENV: 'production' });
    expect(production.observability.logLevel).toBe('info');

    const logger = createAppLogger(production.observability.logLevel);
    logger.warn('rate limit exceeded: policy=otp-request');
    logger.warn('authentication rejected: session_revoked');

    const written = sink.join('\n');
    expect(written).toContain('rate limit exceeded');
    expect(written).toContain('authentication rejected');
  });
});

describe('LOG_LEVEL in the environment schema (issue #129)', () => {
  it('defaults to `debug` outside production, so local development keeps what it had', () => {
    expect(parseEnv(VALID_ENV).observability.logLevel).toBe('debug');
    expect(parseEnv({ ...VALID_ENV, NODE_ENV: 'test' }).observability.logLevel).toBe('debug');
  });

  it('defaults to `info` in production', () => {
    expect(parseEnv({ ...VALID_ENV, NODE_ENV: 'production' }).observability.logLevel).toBe('info');
  });

  it('carries an explicit value through, in every environment', () => {
    expect(parseEnv({ ...VALID_ENV, LOG_LEVEL: 'warn' }).observability.logLevel).toBe('warn');
    expect(
      parseEnv({ ...VALID_ENV, NODE_ENV: 'production', LOG_LEVEL: 'warn' }).observability.logLevel,
    ).toBe('warn');
    expect(parseEnv({ ...VALID_ENV, LOG_LEVEL: 'error' }).observability.logLevel).toBe('error');
  });

  it('refuses LOG_LEVEL=error in production, because rate-limit triggers live at `warn`', () => {
    const env = { ...VALID_ENV, NODE_ENV: 'production', LOG_LEVEL: 'error' };

    expect(() => parseEnv(env)).toThrow(EnvValidationError);
    try {
      parseEnv(env);
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).issues.join('\n')).toMatch(/LOG_LEVEL .*"warn"/s);
    }
  });

  it('rejects a level that is not one of the four', () => {
    expect(() => parseEnv({ ...VALID_ENV, LOG_LEVEL: 'trace' })).toThrow(EnvValidationError);
  });
});
