import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateOtpCode, renderOtpMessage } from './otp-code';

/**
 * A sample big enough that a generator which never emits some digit, or which
 * emits a short code now and then, fails here rather than in production. Small
 * enough to stay a millisecond-scale unit test.
 */
const SAMPLE = 5000;

describe('generateOtpCode', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('produces exactly the requested number of digits, and nothing else', () => {
    for (let index = 0; index < SAMPLE; index += 1) {
      expect(generateOtpCode(6)).toMatch(/^\d{6}$/);
    }
  });

  it('keeps leading zeros instead of silently shortening the code', () => {
    // The failure this guards is a numeric implementation: `randomInt(0, 1e6)`
    // can return 42, and `String(42)` is a two-digit code that is 10,000 times
    // easier to guess than the six the ADR specifies. Over this many draws a
    // generator that dropped leading zeros would produce at least one short
    // code with overwhelming probability (~0.1% of six-digit values start with
    // a zero, so ~5 of them here).
    const codes = Array.from({ length: SAMPLE }, () => generateOtpCode(6));

    expect(codes.every((code) => code.length === 6)).toBe(true);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('never calls Math.random, which is predictable', () => {
    // ADR-0008 § Security requirements names this directly. Asserted as
    // behaviour rather than trusted to a code review, because swapping
    // `randomInt` for `Math.random` is a one-word edit that changes nothing
    // any other test in this file can see.
    const mathRandom = vi.spyOn(Math, 'random');

    for (let index = 0; index < 100; index += 1) {
      generateOtpCode(6);
    }

    expect(mathRandom).not.toHaveBeenCalled();
  });

  it('draws every digit, so no position is stuck or unreachable', () => {
    const seen = new Set<string>();
    for (let index = 0; index < SAMPLE; index += 1) {
      for (const digit of generateOtpCode(6)) {
        seen.add(digit);
      }
    }

    expect([...seen].sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('does not repeat itself', () => {
    // Not a randomness proof — that is what `randomInt` is for. It catches the
    // one failure a shape check cannot: a generator that returns a constant,
    // or one seeded once per process.
    const codes = new Set(Array.from({ length: 1000 }, () => generateOtpCode(6)));

    // 1000 draws from 10^6 values: the birthday bound puts the expected number
    // of collisions below one, so anything under 990 distinct means the source
    // is not what it claims to be.
    expect(codes.size).toBeGreaterThan(990);
  });

  it('refuses a length that would make every verification succeed', () => {
    expect(() => generateOtpCode(0)).toThrow(RangeError);
    expect(() => generateOtpCode(-1)).toThrow(RangeError);
    expect(() => generateOtpCode(1.5)).toThrow(RangeError);
  });
});

describe('renderOtpMessage', () => {
  it('leads with the code, so it is readable from a lock-screen notification', () => {
    const message = renderOtpMessage('123456', 5);

    expect(message.startsWith('123456')).toBe(true);
    expect(message).toContain('5 minutes');
  });

  it('carries nothing that identifies the recipient', () => {
    const message = renderOtpMessage('123456', 5);

    // An SMS body crosses an operator's network and lands on a lock screen.
    // The code has to be there; a phone number, an account id or a link would
    // be information handed to whoever is holding the handset, which is not
    // necessarily the account's owner.
    expect(message).not.toMatch(/\+994/);
    expect(message).not.toMatch(/https?:/);
  });
});
