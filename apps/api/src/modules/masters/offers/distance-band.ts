import type { OfferDistanceBand } from '@tezusta/types';

/**
 * The band boundaries, in metres, lowest first. Each entry is the **exclusive
 * upper bound** of its band.
 *
 * The reasoning for these particular numbers lives on `OfferDistanceBand` in
 * `packages/types`, next to the contract a client renders — it is a product
 * fact, not an implementation detail of this function.
 */
const BAND_CEILINGS: readonly (readonly [number, OfferDistanceBand])[] = [
  [1000, 'under_1km'],
  [2000, 'from_1_to_2km'],
  [3000, 'from_2_to_3km'],
  [5000, 'from_3_to_5km'],
  [10000, 'from_5_to_10km'],
];

/** Everything at or past the last ceiling. Open-ended on purpose. */
const TOP_BAND: OfferDistanceBand = 'over_10km';

/**
 * The band an offer card shows, from the distance the broadcast recorded.
 *
 * **This is the only place a distance in metres is allowed to become something
 * a master sees.** `order_offers.distance_m` is stored so the platform knows
 * what it quoted, and the offer card carries a band instead
 * (`docs/product/master-flow.md`, CLAUDE.md §11) — three masters comparing
 * precise distances against their own known positions trilaterate a customer's
 * front door, and most of them never take the job.
 *
 * A negative distance cannot reach here — `order_offers_distance_non_negative`
 * is a CHECK — and would read as the nearest band anyway, which is the safe
 * direction for a value that should not exist.
 */
export function distanceBand(distanceM: number): OfferDistanceBand {
  for (const [ceiling, band] of BAND_CEILINGS) {
    if (distanceM < ceiling) {
      return band;
    }
  }
  return TOP_BAND;
}
