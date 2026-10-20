/**
 * The routing provider boundary — the geocoding boundary's sibling, under the
 * same rule ([ADR-0004](docs/decisions/ADR-0004-location-and-maps.md): no call
 * site imports a vendor SDK, and swapping providers is a one-file change).
 *
 * It exists for exactly one caller: the arrival promise, which asks for the
 * road travel time from the accepting master to the job **once per accept**
 * ([ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)
 * § 7). Matching never routes; it ranks by straight-line distance in PostGIS
 * (`docs/architecture/location-services.md` § Distance and ETA), and nothing
 * here should tempt a second caller onto the dispatch path.
 *
 * Nothing in this file names a vendor, carries a vendor type, or knows that
 * HTTP exists, so the later move to `packages/config` stays a file move
 * (ADR-0016).
 */

/** DI token for the configured {@link RoutingProvider}. */
export const ROUTING_PROVIDER = 'ROUTING_PROVIDER';

/** WGS 84, in degrees. The order matches every other point in this API. */
export interface RoutePoint {
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * A driving route reduced to the two numbers the arrival promise needs.
 *
 * **Use it and drop it.** Google's terms allow a Routes response's coordinates
 * to be cached for 30 days and its place ids kept, and nothing else, so a
 * duration or distance from a real provider must not be written to the
 * database or to a log (ADR-0055 § 7). What the caller keeps is its own
 * promise, derived from this.
 */
export interface RouteEstimate {
  /** Whole seconds, rounded up: a fractional second is the master's, not ours. */
  readonly durationSeconds: number;
  readonly distanceMeters: number;
}

/**
 * One driving route, and the two ways it can fail to produce one, which must
 * not be collapsed (the contract `GeocodingProvider` has):
 *
 * - `null` means the provider answered and there is no road route, for example
 *   an origin with no road to the destination. Final: a retry costs money and
 *   returns the same thing.
 * - **Throwing** means the provider did not answer: network, timeout, quota,
 *   a key without the API enabled. The caller falls back to the estimate in
 *   `driving-estimate.ts`, and an accept never fails because of it.
 */
export interface RoutingProvider {
  drivingRoute(from: RoutePoint, to: RoutePoint): Promise<RouteEstimate | null>;
}
