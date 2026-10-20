import type { RouteEstimate, RoutePoint } from './routing.types';

/**
 * The arrival promise's fallback, and the stub routing provider's whole answer
 * ([ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)
 * § 10): straight-line distance × a detour factor, driven at an urban speed.
 *
 * **Both constants lean slow, on purpose.** The estimate is used when we have
 * no route, and its error is charged to somebody. Too long, and a master looks
 * early, which costs nobody anything. Too short, and a master is marked late
 * because our routing call failed. So 1.4 sits at the high end of urban
 * circuity, and 20 km/h below a free-flowing city average.
 *
 * Neither is measured. They are replaced from our own accept-to-arrival times
 * (`order_status_history` against `order_offers.distance_m`), not from stored
 * routes, which Google's terms do not let us keep. Constants rather than
 * configuration: changing them is a decision recorded against data, not an
 * operator's knob.
 */
export const ESTIMATE_DETOUR_FACTOR = 1.4;
export const ESTIMATE_SPEED_KMH = 20;

/** The IUGG mean Earth radius, which is what a haversine distance assumes. */
const EARTH_MEAN_RADIUS_M = 6_371_008.8;

const METRES_PER_SECOND = (ESTIMATE_SPEED_KMH * 1000) / 3600;

/**
 * Great-circle distance in metres. Within a city the sphere and PostGIS's
 * spheroid differ by well under a percent, which is noise beside a detour
 * factor; the caller that has PostGIS to hand passes its own `ST_Distance` to
 * {@link estimateDrivingSeconds} instead.
 */
export function straightLineMeters(from: RoutePoint, to: RoutePoint): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;

  return 2 * EARTH_MEAN_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Seconds to drive a straight-line distance, rounded up. 3 km is 756 s
 * (12.6 min) and 10 km is 2 520 s (42 min).
 *
 * A negative or non-finite distance is a caller's bug, not an input to round:
 * it throws rather than promising a master zero seconds.
 */
export function estimateDrivingSeconds(straightLineM: number): number {
  if (!Number.isFinite(straightLineM) || straightLineM < 0) {
    throw new RangeError('A straight-line distance must be a finite, non-negative number.');
  }

  // Rounded to the millisecond before the ceiling, so floating-point dust on
  // an exact answer (4200 / 5.555… is 756, not 756.0000000001) does not cost
  // the master a whole second.
  return Math.ceil(
    Math.round(((straightLineM * ESTIMATE_DETOUR_FACTOR) / METRES_PER_SECOND) * 1000) / 1000,
  );
}

/** The estimate as a route: what the stub answers, and what a fallback stands in for. */
export function estimatedRoute(from: RoutePoint, to: RoutePoint): RouteEstimate {
  const straightLine = straightLineMeters(from, to);

  return {
    durationSeconds: estimateDrivingSeconds(straightLine),
    distanceMeters: Math.round(straightLine * ESTIMATE_DETOUR_FACTOR),
  };
}
