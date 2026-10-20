import { describe, expect, it } from 'vitest';

import {
  ESTIMATE_DETOUR_FACTOR,
  ESTIMATE_SPEED_KMH,
  estimateDrivingSeconds,
  estimatedRoute,
  straightLineMeters,
} from './driving-estimate';

/** Fountains Square and the Flame Towers: two Baku points about 1.6 km apart. */
const FOUNTAINS_SQUARE = { latitude: 40.37106, longitude: 49.83706 } as const;
const FLAME_TOWERS = { latitude: 40.35965, longitude: 49.82607 } as const;

describe('the arrival estimate (ADR-0055 § 10)', () => {
  it('uses the constants the ADR fixes', () => {
    expect(ESTIMATE_DETOUR_FACTOR).toBe(1.4);
    expect(ESTIMATE_SPEED_KMH).toBe(20);
  });

  it.each([
    // The two figures ADR-0055 § 10 quotes, so the document and the code
    // cannot quietly disagree.
    [3_000, 756],
    [10_000, 2_520],
    [0, 0],
  ])('drives %i m of straight line in %i s', (metres, seconds) => {
    expect(estimateDrivingSeconds(metres)).toBe(seconds);
  });

  it('rounds a fractional second up, in the master’s favour', () => {
    // 1 m × 1.4 at 20 km/h is 0.252 s.
    expect(estimateDrivingSeconds(1)).toBe(1);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses a distance of %d rather than promising nonsense',
    (metres) => {
      expect(() => estimateDrivingSeconds(metres)).toThrow(RangeError);
    },
  );

  it('measures a known Baku distance to within a few metres', () => {
    const metres = straightLineMeters(FOUNTAINS_SQUARE, FLAME_TOWERS);

    expect(metres).toBeGreaterThan(1_560);
    expect(metres).toBeLessThan(1_590);
    expect(straightLineMeters(FLAME_TOWERS, FOUNTAINS_SQUARE)).toBeCloseTo(metres, 6);
  });

  it('turns two points into a route of the estimate’s time and the detoured distance', () => {
    const straightLine = straightLineMeters(FOUNTAINS_SQUARE, FLAME_TOWERS);

    expect(estimatedRoute(FOUNTAINS_SQUARE, FLAME_TOWERS)).toEqual({
      durationSeconds: estimateDrivingSeconds(straightLine),
      distanceMeters: Math.round(straightLine * 1.4),
    });
  });
});
