import { describe, expect, it } from 'vitest';

import { distanceBand } from './distance-band';

/**
 * Every boundary, from both sides.
 *
 * A band function is all boundary and no interior: the only way to get it
 * wrong is an off-by-one at a ceiling, and a test that checks the middle of
 * each band would pass with every `<` written as `<=`.
 */
describe('the offer distance band (issue #101)', () => {
  it.each([
    [0, 'under_1km'],
    [999, 'under_1km'],
    [1000, 'from_1_to_2km'],
    [1999, 'from_1_to_2km'],
    [2000, 'from_2_to_3km'],
    [2999, 'from_2_to_3km'],
    [3000, 'from_3_to_5km'],
    [4999, 'from_3_to_5km'],
    [5000, 'from_5_to_10km'],
    [9999, 'from_5_to_10km'],
    [10_000, 'over_10km'],
    [42_000, 'over_10km'],
  ])('puts %d metres in %s', (metres, band) => {
    expect(distanceBand(metres)).toBe(band);
  });

  /**
   * The point of the band, asserted as a property rather than as an example:
   * no output of this function narrows a distance to better than a kilometre,
   * so no set of offer cards narrows a customer's address to better than that
   * either.
   */
  it('never distinguishes two distances less than a kilometre apart within a band', () => {
    expect(distanceBand(1001)).toBe(distanceBand(1999));
    expect(distanceBand(5001)).toBe(distanceBand(9999));
  });
});
