import { describe, expect, it } from 'vitest';

import { databaseErrorCode, describeDatabaseFailure, isUniqueViolation } from './database-error';

/**
 * The two shapes this module exists to read, reproduced from the shipped
 * sources rather than imagined.
 *
 * `pg`'s `DatabaseError` carries the SQLSTATE and a `detail` that quotes the
 * failing row; `drizzle-orm@0.45.2` wraps it and builds its own message by
 * interpolating the bound parameters (`pg-core/session.js` →
 * `errors.js`). Between them they put a phone number in three places, which is
 * why `all-exceptions.filter.ts` may not simply log `exception.stack`
 * (issue #63) and why a `catch` may not read `code` off the throwable
 * (issue #70).
 */
const PHONE = '+994501112233';

function driverError(code: string, overrides: Record<string, string> = {}): Error {
  return Object.assign(new Error(`duplicate key value violates unique constraint "users_x"`), {
    code,
    severity: 'ERROR',
    detail: `Key (phone_e164)=(${PHONE}) already exists.`,
    schema: 'public',
    table: 'users',
    constraint: 'users_phone_e164_live_unique',
    routine: '_bt_check_unique',
    ...overrides,
  });
}

function wrapped(cause: Error): Error {
  const query = 'insert into "users" ("id", "phone_e164") values ($1, $2)';
  const wrapper = new Error(`Failed query: ${query}\nparams: ${PHONE}`, { cause });
  return Object.assign(wrapper, { query, params: ['01a0', PHONE] });
}

describe('databaseErrorCode', () => {
  it('reads the SQLSTATE through the query layer that wraps it', () => {
    expect(databaseErrorCode(wrapped(driverError('23505')))).toBe('23505');
  });

  it('reads it off an unwrapped driver error too', () => {
    expect(databaseErrorCode(driverError('40P01'))).toBe('40P01');
  });

  it('is undefined for an error that never reached the database', () => {
    expect(databaseErrorCode(new Error('boom'))).toBeUndefined();
  });

  it('does not mistake a Node error code for a SQLSTATE', () => {
    // `ECONNREFUSED` is also on a `code` property. A SQLSTATE is exactly five
    // characters, which is what separates the two without importing `pg`.
    const socket = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

    expect(databaseErrorCode(socket)).toBeUndefined();
    expect(isUniqueViolation(socket)).toBe(false);
  });

  it('terminates on a cause chain that points back at itself', () => {
    const looping: Error & { cause?: unknown } = new Error('looping');
    looping.cause = looping;

    expect(databaseErrorCode(looping)).toBeUndefined();
  });
});

describe('isUniqueViolation', () => {
  it('is true for a wrapped 23505 and false for anything else', () => {
    expect(isUniqueViolation(wrapped(driverError('23505')))).toBe(true);
    expect(isUniqueViolation(wrapped(driverError('40001')))).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});

describe('describeDatabaseFailure', () => {
  it('names the statement without naming a single bound value', () => {
    const description = describeDatabaseFailure(wrapped(driverError('23505')));

    expect(description).not.toBeNull();
    const text = description ?? '';

    // The parameter, the wrapper's interpolated message, and the driver's
    // `detail` are three separate routes to the same phone number. All three
    // are closed.
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain('Failed query');
    expect(text).not.toContain('already exists');

    // And the failure is still diagnosable: which error, which constraint,
    // which statement.
    expect(text).toContain('23505');
    expect(text).toContain('users_phone_e164_live_unique');
    expect(text).toContain('insert into "users"');
  });

  it('keeps the stack frames and drops the header line they hang off', () => {
    const text = describeDatabaseFailure(wrapped(driverError('23505'))) ?? '';

    expect(text).toContain('    at ');
    // V8 builds `stack` as the message followed by the frames, so a fix that
    // logged `stack` wholesale would put the interpolated message back.
    expect(text.startsWith('Error:')).toBe(false);
  });

  it('describes an unwrapped driver error, minus its message', () => {
    const text = describeDatabaseFailure(
      driverError('23514', { constraint: 'services_pricing_shape' }),
    );

    expect(text).toContain('23514');
    expect(text).toContain('services_pricing_shape');
    expect(text).not.toContain(PHONE);
  });

  it('returns null for an error that is not a database error', () => {
    // The caller falls back to the full stack, so nothing that is not a
    // database failure loses any detail to this module.
    expect(describeDatabaseFailure(new TypeError('x is not a function'))).toBeNull();
    expect(describeDatabaseFailure('a string')).toBeNull();
  });
});
