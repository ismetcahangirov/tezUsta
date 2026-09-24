import type { PartyRating } from '@tezusta/types';

/**
 * Null, not zero, for a party nobody has rated.
 *
 * A UI that renders "no reviews yet" as 0.0 out of 5 tells every customer that
 * every new master is the worst on the platform, which is both false and the
 * fastest way to ensure a new master never gets a first job.
 *
 * Two decimals: the sum and count are exact, so the rounding happens once, on
 * the way out, rather than accumulating in a stored average.
 *
 * Shared by the master's own profile and by the counterpart reads of issue
 * #225, so every surface rounds the same stored pair the same way.
 */
export function averageRating(sum: number, count: number): number | null {
  if (count === 0) {
    return null;
  }
  return Math.round((sum / count) * 100) / 100;
}

/** The stored `rating_sum` / `rating_count` pair as the wire shape (ADR-0042 § 6). */
export function toPartyRating(sum: number, count: number): PartyRating {
  return { ratingAverage: averageRating(sum, count), ratingCount: count };
}
