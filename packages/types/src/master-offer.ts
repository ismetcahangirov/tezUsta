import type { Address } from './address.js';

/**
 * How far the job is, as a **band** rather than a figure (issue #101).
 *
 * `docs/product/master-flow.md` is explicit: the offer card carries a distance
 * band, and the exact address is revealed only to the master who accepts. The
 * band is what makes that rule survive contact with arithmetic — a broadcast
 * reaches every eligible master in range, and a precise distance handed to
 * each of them is a trilateration primitive. Three masters who compare "1 847
 * m", "2 103 m" and "962 m" against their own positions locate a customer's
 * front door to within a few metres, and none of them ever took the job.
 *
 * **The boundaries.** One-kilometre steps up to 3 km, then coarser to 10 km,
 * then an open top band:
 *
 * | Band          | Metres        |
 * | ------------- | ------------- |
 * | `under_1km`   | `[0, 1000)`   |
 * | `from_1_to_2km` | `[1000, 2000)` |
 * | `from_2_to_3km` | `[2000, 3000)` |
 * | `from_3_to_5km` | `[3000, 5000)` |
 * | `from_5_to_10km` | `[5000, 10000)` |
 * | `over_10km`   | `[10000, ∞)`  |
 *
 * Fine where the decision actually is and coarse where it is not: ADR-0009
 * starts dispatch at a 3 km radius, so most offers land in the first three
 * bands, and that is where a kilometre changes a master's answer. Past 5 km
 * the question has stopped being "how far" and started being "at all", so a
 * wider band costs the master nothing and gives away less. The top band is
 * open rather than ending at `DISPATCH_MAX_RADIUS_M`, because a tuning change
 * to that ceiling must not be able to produce an offer no band can describe.
 *
 * A band, not two numbers, so the client cannot render a midpoint and
 * reintroduce the precision this exists to remove.
 */
export type OfferDistanceBand =
  | 'under_1km'
  | 'from_1_to_2km'
  | 'from_2_to_3km'
  | 'from_3_to_5km'
  | 'from_5_to_10km'
  | 'over_10km';

/** One problem photo on an offered job, as a short-lived read URL. */
export interface OfferPhoto {
  readonly url: string;
  /** ISO 8601, UTC. The URL stops working here. */
  readonly expiresAt: string;
}

/**
 * One live offer, as the offered master's app sees it.
 *
 * **The five things on the card, and nothing else**
 * (`docs/product/master-flow.md` § Receiving an offer): the service, what the
 * customer says is wrong, the photos, the distance band, and this master's own
 * price. There is deliberately **no address, no customer name, no phone
 * number, and no customer id** — a broadcast goes to every eligible master in
 * range, so anything on this card is handed to everybody who never takes the
 * job (CLAUDE.md §11).
 *
 * There is no `orderId` either. The offer id is the master's handle on the
 * job, and the order's own id is of no use to a master who has not accepted
 * it — while an id that is stable across the whole broadcast is one more
 * thing two masters can correlate offline.
 *
 * `id` and `expiresAt` are the two fields beyond the five, and both are
 * mechanics rather than content: the first is what `accept` and `decline` are
 * addressed by, and the second is what lets the app count down rather than
 * discover on tap that an unactioned offer has lapsed (ADR-0009 requires an
 * offer to expire rather than linger).
 */
export interface MasterOffer {
  readonly id: string;
  readonly serviceId: string;
  /** What the customer says is wrong, in their own words. */
  readonly description: string;
  readonly photos: readonly OfferPhoto[];
  readonly distanceBand: OfferDistanceBand;
  /**
   * **This master's own price** for this service, in minor units, or null when
   * the service is priced after inspection.
   *
   * What the card shows, and deliberately not what the order is billed at:
   * ADR-0013 freezes the price inside the accept statement, from a fresh read
   * of this master's stored price. A card minted three minutes ago is not
   * allowed to set the price of a real job.
   */
  readonly priceMinor: number | null;
  /** ISO 8601, UTC. After this the offer is no longer actionable. */
  readonly expiresAt: string;
}

/** What comes back when a master declines. A decline is permanent (ADR-0009). */
export interface DeclinedOffer {
  readonly offerId: string;
  readonly status: 'declined';
}

/**
 * What the winner of the race is told, and the moment the customer's address
 * stops being secret.
 *
 * The address is here because this response **is** the reveal
 * (`docs/product/master-flow.md` § Accepting): it reaches exactly one master,
 * the one now assigned to the job, and never the ones who lost. It is also
 * readable afterwards through the offer's own address route, so a master who
 * restarts their app does not lose the only copy.
 */
export interface AcceptedOffer {
  readonly offerId: string;
  readonly orderId: string;
  readonly serviceId: string;
  readonly description: string;
  /**
   * The frozen price, in minor units — this master's own stored price, copied
   * in the same statement that assigned them (ADR-0013). **Null, not zero**,
   * for an inspection-priced service: the amount does not exist until somebody
   * has seen the work, and zero is a price.
   */
  readonly priceMinor: number | null;
  /** ISO 8601, UTC. */
  readonly acceptedAt: string;
  /** The exact address, revealed now and not before. */
  readonly address: Address;
}
