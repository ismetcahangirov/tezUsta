import { describe, expect, it } from 'vitest';

import { averageRating, toPartyRating } from './party-rating';

describe('a party rating', () => {
  it('has no average without reviews', () => {
    expect(toPartyRating(0, 0)).toEqual({ ratingAverage: null, ratingCount: 0 });
  });

  it('rounds the average to two decimals', () => {
    expect(averageRating(14, 3)).toBe(4.67);
    expect(averageRating(10, 3)).toBe(3.33);
    expect(toPartyRating(9, 2)).toEqual({ ratingAverage: 4.5, ratingCount: 2 });
  });
});
