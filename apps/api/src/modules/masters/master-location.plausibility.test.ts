import { describe, expect, it } from 'vitest';

import { isImplausibleJump } from './master-location.plausibility';

/** The defaults ADR-0044 settles on. */
const LIMITS = { maxSpeedKmh: 200, jumpFloorMeters: 1_000 };

describe('isImplausibleJump (issue #274, ADR-0044)', () => {
  it('refuses a 50 km jump ten seconds after the previous fix', () => {
    expect(isImplausibleJump({ distanceMeters: 50_000, elapsedSeconds: 10 }, LIMITS)).toBe(true);
  });

  it('accepts city driving: 600 m in 30 s is 72 km/h', () => {
    expect(isImplausibleJump({ distanceMeters: 600, elapsedSeconds: 30 }, LIMITS)).toBe(false);
  });

  it('accepts motorway driving: 10 km in five minutes is 120 km/h', () => {
    expect(isImplausibleJump({ distanceMeters: 10_000, elapsedSeconds: 300 }, LIMITS)).toBe(false);
  });

  it('accepts a jump below the floor however fast it looks', () => {
    // GPS jitter: a fix that wanders 400 m between two reports one second
    // apart is 1 440 km/h on paper and nothing at all in practice.
    expect(isImplausibleJump({ distanceMeters: 400, elapsedSeconds: 1 }, LIMITS)).toBe(false);
  });

  it('treats the floor itself as jitter, and one metre past it as a jump', () => {
    expect(isImplausibleJump({ distanceMeters: 1_000, elapsedSeconds: 0 }, LIMITS)).toBe(false);
    expect(isImplausibleJump({ distanceMeters: 1_001, elapsedSeconds: 0 }, LIMITS)).toBe(true);
  });

  it('refuses a same-instant jump past the floor instead of dividing by zero', () => {
    expect(isImplausibleJump({ distanceMeters: 5_000, elapsedSeconds: 0 }, LIMITS)).toBe(true);
  });

  it('allows a longer jump the longer the gap: the pin loosens with time', () => {
    // 50 km needs 900 s at 200 km/h. One second short is refused, the
    // boundary itself is not.
    expect(isImplausibleJump({ distanceMeters: 50_000, elapsedSeconds: 899 }, LIMITS)).toBe(true);
    expect(isImplausibleJump({ distanceMeters: 50_000, elapsedSeconds: 900 }, LIMITS)).toBe(false);
  });

  it('reads the limits it is given rather than its own', () => {
    const strict = { maxSpeedKmh: 50, jumpFloorMeters: 200 };
    // 600 m in 30 s (72 km/h) is fine at the default and too fast at 50 km/h.
    expect(isImplausibleJump({ distanceMeters: 600, elapsedSeconds: 30 }, strict)).toBe(true);
  });
});
