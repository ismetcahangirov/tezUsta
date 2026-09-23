import * as Location from 'expo-location';

import { BACKGROUND_LOCATION_TASK, setBackgroundListener } from './background-task';
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
   * **Foreground only, and deliberately.** Background access has its own
   * call, {@link LocationPort.requestBackgroundPermission}, asked when an
   * order is accepted and never at onboarding, where it is denied
   * (`realtime-architecture.md` § Background location). Folding it into this
   * call would ask a master going online for "Always" — the exact mistake
   * that section warns about.
   */
  async requestPermission() {
    return readLocationPermission(await Location.requestForegroundPermissionsAsync());
  },

  async backgroundPermission() {
    return readLocationPermission(await Location.getBackgroundPermissionsAsync());
  },

  async requestBackgroundPermission() {
    return readLocationPermission(await Location.requestBackgroundPermissionsAsync());
  },

  async lastKnown() {
    const location = await Location.getLastKnownPositionAsync();
    return location === null ? null : toPosition(location);
  },

  async current() {
    return toPosition(await Location.getCurrentPositionAsync({ accuracy: accuracyFor(true) }));
  },

  async watch(options: WatchOptions, onMoved): Promise<WatchSubscription> {
    if (options.background) {
      try {
        return await watchInBackground(options, onMoved);
      } catch {
        // No background session to be had — permission withdrawn in settings
        // since it was read, or a platform without a task manager. Degrade to
        // foreground updates rather than to nothing: the master is on a job
        // and the customer is watching, so what the app can still send while
        // open is worth sending.
      }
    }

    // A foreground subscription never runs beside a background session. One
    // left behind by a previous run — the app killed on iOS mid-job, a crash
    // between start and stop — would otherwise keep a master tracked after
    // their order ended.
    await stopBackgroundSession();

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

/** Ends the background session, if one is running. Idempotent. */
async function stopBackgroundSession(): Promise<void> {
  setBackgroundListener(null);
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
    }
  } catch {
    // No task manager on this platform, so there is no session to stop.
  }
}

/**
 * The same subscription, delivered through the background task (issue #171).
 *
 * **The distance filter is the same one**, so the surplus costs what it costs
 * in the foreground. The floor is still the reporter's timer: on Android the
 * foreground service keeps the JS thread alive, so the timer keeps firing; on
 * iOS a backgrounded app's timers are suspended and only movement wakes it —
 * which, for a master driving to a job, is the stretch that matters.
 *
 * - `foregroundService` is what Android requires to receive locations in the
 *   background at all, and its notification is the honest part: the master
 *   can see, in their shade, that the app is sharing where they are.
 *   `killServiceOnDestroy` so that swiping the app away ends it.
 * - `showsBackgroundLocationIndicator` for the same honesty on iOS.
 * - `pausesUpdatesAutomatically: false` because a master stopped at a red
 *   light is exactly who iOS would otherwise pause.
 */
async function watchInBackground(
  options: WatchOptions,
  onMoved: (position: Position) => void,
): Promise<WatchSubscription> {
  setBackgroundListener(onMoved);

  try {
    await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
      accuracy: accuracyFor(options.needsFreshFix),
      ...(options.distanceMeters === null ? {} : { distanceInterval: options.distanceMeters }),
      showsBackgroundLocationIndicator: true,
      pausesUpdatesAutomatically: false,
      activityType: Location.ActivityType.OtherNavigation,
      foregroundService: {
        notificationTitle: BACKGROUND_NOTIFICATION.title,
        notificationBody: BACKGROUND_NOTIFICATION.body,
        killServiceOnDestroy: true,
      },
    });
  } catch (error) {
    setBackgroundListener(null);
    throw error;
  }

  return {
    remove: stopBackgroundSession,
  };
}

/**
 * The Android foreground-service notification, shown for as long as the
 * background session runs. **Placeholder copy**, listed for the owner with
 * the rest (CLAUDE.md §17).
 */
const BACKGROUND_NOTIFICATION = {
  title: 'TezUsta sifarişdə',
  body: 'Müştəri yolda olduğunuzu görür. Sifariş bitəndə dayanır.',
} as const;
