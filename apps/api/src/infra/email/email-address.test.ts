import { describe, expect, it } from 'vitest';

import { EMAIL_MAX_LENGTH, maskEmail, normaliseEmail } from './email-address';

describe('normaliseEmail', () => {
  it('trims and lower-cases, so one person is always one string', () => {
    expect(normaliseEmail('  Ali.Veli@Example.COM ')).toEqual({
      ok: true,
      email: 'ali.veli@example.com',
    });
  });

  it('keeps a +tag and dots as they are: no provider-specific folding (ADR-0072 § 3)', () => {
    expect(normaliseEmail('a.li+usta@gmail.com')).toEqual({
      ok: true,
      email: 'a.li+usta@gmail.com',
    });
  });

  it.each([
    '',
    '   ',
    'ali',
    'ali@',
    '@example.com',
    'ali@example',
    'ali @example.com',
    'a@b@c.com',
  ])('refuses %j', (input) => {
    expect(normaliseEmail(input)).toEqual({ ok: false });
  });

  it('refuses an address longer than RFC 5321 allows', () => {
    const local = 'a'.repeat(EMAIL_MAX_LENGTH);
    expect(normaliseEmail(`${local}@example.com`)).toEqual({ ok: false });
  });
});

describe('maskEmail', () => {
  it('shows the first letter and the domain only', () => {
    expect(maskEmail('ali.veli@gmail.com')).toBe('a•••@gmail.com');
  });

  it('never echoes a malformed value back', () => {
    expect(maskEmail('not-an-address')).toBe('•••');
  });
});
