import type { ColorScheme } from '../theme';

/**
 * The contract between the tracking screen and whatever draws the map
 * ([ADR-0035](../../../../docs/decisions/ADR-0035-customer-tracking-map.md)).
 *
 * **No vendor type crosses it** (CLAUDE.md §2). `react-native-maps` is imported
 * by `map-surface.tsx` and nowhere else, the way `expo-location` is imported by
 * `location-adapter.ts` and nowhere else — so the rest of the feature is
 * testable without a native view, Storybook can substitute a web stand-in, and
 * a change of map library is a change to one file.
 */

/** A point on the map, in WGS84 degrees. */
export interface MapPoint {
  readonly latitude: number;
  readonly longitude: number;
}

export interface MapMarkerSpec {
  readonly point: MapPoint;
  /** Read by a screen reader. The marker's colour never carries its meaning. */
  readonly label: string;
}

export interface MasterMarkerSpec extends MapMarkerSpec {
  /**
   * `live` draws the marker in the accent; `stale` draws it muted. Nothing else
   * about the marker changes, and a stale marker is never animated — that is
   * decided above this component, by `planMarkerMove`.
   */
  readonly appearance: 'live' | 'stale';
}

export interface MapSurfaceProps {
  /** Where the order is going: the customer's own saved address. */
  readonly destination: MapMarkerSpec | null;
  /**
   * The master's **reported** point. While `appearance` is `live` the surface
   * draws the marker travelling to it from where it was drawn before
   * (`useGlidingPosition`); otherwise it is placed on it. The glide lives
   * inside the surface, on the marker, so a tick re-renders one marker rather
   * than the whole map.
   */
  readonly master: MasterMarkerSpec | null;
  /**
   * The points the camera keeps in view. A new value moves the camera; the
   * gliding marker does not, because it is not in this list — it moves the
   * camera once per report, not four times a second.
   */
  readonly frame: readonly MapPoint[];
  readonly scheme: ColorScheme;
  readonly accessibilityLabel: string;
}
