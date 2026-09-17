/**
 * The geocoding provider boundary ([ADR-0004](docs/decisions/ADR-0004-location-and-maps.md):
 * "Access sits behind a **provider interface** so the choice stays reversible…
 * **No call site imports a vendor SDK directly.** Swapping providers must be a
 * one-file change, not a search-and-replace across the app").
 *
 * The provider is decided — Google Maps Platform — and the interface is not
 * therefore decoration. Maps pricing and terms change on Google's schedule, not
 * ours, and the day a cheaper or better-covering provider appears the cost of
 * moving should be writing one file, not auditing the codebase for
 * `googleapis`. `geocoding.boundary.test.ts` enforces that mechanically rather
 * than by review.
 *
 * ADR-0004 originally placed this interface in `packages/config`; ADR-0016
 * superseded that clause, so it lives here until a second consumer exists.
 * Nothing in this file names a vendor, carries a vendor type, or knows that
 * HTTP exists — which is what keeps that later move a file move.
 */

/** DI token for the configured {@link GeocodingProvider}. */
export const GEOCODING_PROVIDER = 'GEOCODING_PROVIDER';

/**
 * What forward geocoding produces: a point, and the provider's own stable id
 * for the place when it has one.
 *
 * **Coordinates and nothing else**, and that is a licensing constraint rather
 * than a design preference. Google's Maps Service Specific Terms §6.3.1 permit
 * caching "latitude (lat) and longitude (lng) values from the Geocoding API for
 * up to 30 consecutive calendar days"; §6.3.2 permits keeping a
 * `formatted_address` only where the cache is "logically isolated to the
 * specific End User it is associated with and must not be used across multiple
 * End Users". A shared server-side cache can therefore hold the point and not
 * the prose — see `geocode-cache.repository.ts`.
 */
export interface GeocodedPoint {
  readonly latitude: number;
  readonly longitude: number;
  /**
   * Cacheable indefinitely and across users, unlike everything else here — the
   * terms treat a place id as an identifier rather than as content. Null when
   * the provider has no such concept, which is what keeps this interface from
   * being Google-shaped.
   */
  readonly placeId: string | null;
}

/**
 * What reverse geocoding produces: enough to pre-fill a new saved address.
 *
 * The field set is chosen to map onto `addresses`, not onto any provider's
 * response. `entrance`, `floor` and `apartment` are deliberately absent: no
 * geocoder knows which entrance of a Baku block a door is behind, that is
 * exactly why those fields exist, and inventing them from a response would be
 * worse than leaving them for the customer to fill in
 * (`docs/architecture/location-services.md` § Azerbaijani addresses).
 */
export interface StructuredAddress {
  readonly formattedAddress: string;
  readonly streetNumber: string | null;
  readonly street: string | null;
  /** Rayon / district, where the provider distinguishes one. */
  readonly district: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly placeId: string | null;
}

/**
 * Forward and reverse geocoding, and the two ways each can fail to produce an
 * answer — which are **not** the same and must not be collapsed.
 *
 * - `null` means the provider answered and there is no such place. That is a
 *   final answer: retrying it costs money and returns the same thing.
 * - **Throwing** means the provider did not answer — network, quota, outage,
 *   misconfiguration. The caller degrades to manual entry
 *   (`GeocodingService`), and the customer's flow does not dead-end.
 *
 * An implementation that returned `null` for an outage would turn "Google is
 * down" into "your address does not exist", which is the single most
 * misleading thing this boundary could do.
 */
export interface GeocodingProvider {
  forward(address: string): Promise<GeocodedPoint | null>;
  reverse(latitude: number, longitude: number): Promise<StructuredAddress | null>;
}
