import * as Location from 'expo-location';

import { readLocationPermission } from './location-permission';
import type { LocationPort, Position, WatchOptions, WatchSubscription } from './location-port';

/**
 * The only file in the app that imports `expo-location` (issue #171).
 *
 * Everything else talks to {@link LocationPort}, so the reporter's state
 * machine, its backoff and its staleness detection are testable without a
 * native module — and the day the vendor changes, this file is the diff.
 *
 * **It decides nothing.** No interval, no distance, no retry lives here: those
 * are `location-budget.ts`'s, which is what makes #173 a one-file revision.
 */

/** `expo-location`'s own shape, narrowed to the two numbers this app carries. */
function toPosition(location: Location.LocationObject): Position {
  return { latitude: location.coords.latitude, longitude: location.coords.longitude };
}

/**
 * `Accuracy.Balanced` for a floor, `Accuracy.High` where the customer is
 * watching.
 *
 * Transcribed from the shipped `expo-location@57.0.19` rather than guessed:
 * `Balanced` is documented as "accurate to within one hundred meters" and
 * `High` as "accurate to within ten meters". A parked master does not need
 * ten, and the difference is the GNSS radio staying off.
 */
function accuracyFor(needsFreshFix: boolean): Location.LocationAccuracy {
  return needsFreshFix ? Location.Accuracy.High : Location.Accuracy.Balanced;
}

export const locationAdapter: LocationPort = {
  async permission() {
    return readLocationPermission(await Location.getForegroundPermissionsAsync());
  },

  /**
   * **Foreground only, and deliberately.** Background access is asked for when
   * an order is accepted and never at onboarding, where it is denied
   * (`realtime-architecture.md` § Background location) — and this app has no
   * accept yet, so nothing here may ask for it. Adding
   * `requestBackgroundPermissionsAsync` to this call would be the exact
   * mistake that section warns about.
   */
  async requestPermission() {
    return readLocationPermission(await Location.requestForegroundPermissionsAsync());
  },

  async lastKnown() {
    const location = await Location.getLastKnownPositionAsync();
    return location === null ? null : toPosition(location);
  },

  async current() {
    return toPosition(await Location.getCurrentPositionAsync({ accuracy: accuracyFor(true) }));
  },

  async watch(options: WatchOptions, onMoved): Promise<WatchSubscription> {
    return Location.watchPositionAsync(
      {
        accuracy: accuracyFor(options.needsFreshFix),
        // Omitted rather than passed as 0 when the state has no surplus: a
        // `distanceInterval` of 0 means "every update the platform produces",
        // which is the opposite of no surplus.
        ...(options.distanceMeters === null ? {} : { distanceInterval: options.distanceMeters }),
      },
      (location) => {
        onMoved(toPosition(location));
      },
    );
  },
};
