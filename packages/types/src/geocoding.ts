/**
 * Geocoding, as the API answers it.
 *
 * **Every outcome is a 200 with a `status`, including "the provider is down".**
 * That is deliberate and it is the whole of EPIC 4's "a denied location
 * permission still permits manual address entry — the flow does not dead-end".
 * A 503 would put the degradation in the client's error handler, where it is
 * one forgotten `catch` away from a spinner that never stops; a discriminated
 * union puts it in the same `switch` that already handles "no such place", so
 * the manual-entry path is the default rather than the exception.
 *
 * It is also honest about what happened: the request succeeded. TezUsta
 * answered it. What TezUsta has to say is that Google did not answer, which is
 * information, not a server error — and it should page nobody.
 */

/** A point, as forward geocoding resolves it. */
export interface GeocodedLocation {
  readonly latitude: number;
  readonly longitude: number;
  /** The provider's stable id for the place, or null where it has no such concept. */
  readonly placeId: string | null;
}

/**
 * What reverse geocoding can pre-fill a new saved address with.
 *
 * `entrance`, `floor` and `apartment` are absent on purpose: no geocoder knows
 * which entrance of a Baku block a door is behind — that is precisely why those
 * fields exist on a saved address — and a guessed value is worse than an empty
 * one, because the customer will not notice it is wrong until a master is
 * standing at the wrong stairwell.
 */
export interface ReverseGeocodedAddress extends GeocodedLocation {
  readonly formattedAddress: string;
  readonly streetNumber: string | null;
  readonly street: string | null;
  /** Rayon / district, where the provider distinguishes one. */
  readonly district: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
}

/**
 * `no-result` and `unavailable` are different answers and must stay different.
 * "There is no such address" is final and the customer should check what they
 * typed; "we could not ask" is temporary and the customer should carry on and
 * drop the pin themselves. Collapsing them would tell people their street does
 * not exist whenever Google has a bad minute.
 */
export type ForwardGeocodeResult =
  | ({ readonly status: 'ok' } & GeocodedLocation)
  | { readonly status: 'no-result' }
  | { readonly status: 'unavailable' };

export type ReverseGeocodeResult =
  | { readonly status: 'ok'; readonly address: ReverseGeocodedAddress }
  | { readonly status: 'no-result' }
  | { readonly status: 'unavailable' };
