import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import type { Position } from './location-port';

/**
 * The one background location task this app registers (issue #171).
 *
 * Named, not generated: `startLocationUpdatesAsync` and
 * `stopLocationUpdatesAsync` must agree on it across an app restart, and a
 * task left running under a name nothing stops is a master tracked after
 * their order ended — the privacy violation and app-store failure
 * `realtime-architecture.md` § Background location names.
 */
export const BACKGROUND_LOCATION_TASK = 'tezusta.master-location';

type Listener = (position: Position) => void;

/**
 * Who receives what the task delivers, or `null`.
 *
 * **Module state, and deliberately so.** The task body runs outside React —
 * the platform calls it — and the only thing it may do with a position is hand
 * it to the reporter that started it, which owns the backoff, the staleness
 * check and the one send path. A task that sent on its own would be a second
 * reporter with none of that.
 *
 * `null` means nobody is listening: the app was relaunched by the OS for a
 * location event with no master screen mounted. The point is dropped, not
 * sent — the reporter, when it next runs, resumes on its own floor, and a
 * master whose phone was reporting nothing in between is exactly what the
 * staleness warning exists to tell them.
 */
let listener: Listener | null = null;

export function setBackgroundListener(next: Listener | null): void {
  listener = next;
}

/**
 * The newest of a batch, or `null` for an empty one.
 *
 * **This is the batching decision (issue #171).** The platform hands the task
 * several points at once when it has deferred them; only the newest says where
 * the master is, and dispatch and the customer's marker read only the newest.
 * So a batch becomes **one** report, which is what "several points in one
 * request beats several requests" is for — with no change to `POST
 * /masters/me/location`'s one-point contract (#98), because the older points
 * would have been written to a trail that nothing reads and then superseded
 * within the same request.
 *
 * Chosen by timestamp rather than by position in the array, because nothing
 * in `expo-location`'s documentation promises the order.
 */
export function newestOf(locations: readonly LocationObject[]): Position | null {
  let newest: LocationObject | null = null;
  for (const location of locations) {
    if (newest === null || location.timestamp > newest.timestamp) {
      newest = location;
    }
  }
  return newest === null
    ? null
    : { latitude: newest.coords.latitude, longitude: newest.coords.longitude };
}

/**
 * The task body, exported so a test can call it the way the platform does.
 *
 * Silent on error, and on purpose: the error can describe a location, and
 * nothing here may log one (CLAUDE.md §11). A task that fails delivers
 * nothing, and the reporter's staleness check is what notices.
 */
export function handleBackgroundLocations({
  data,
  error,
}: TaskManager.TaskManagerTaskBody<{ locations?: LocationObject[] }>): Promise<void> {
  if (error !== null || listener === null) {
    return Promise.resolve();
  }

  const position = newestOf(data.locations ?? []);
  if (position !== null) {
    listener(position);
  }
  return Promise.resolve();
}

/**
 * Defined at module scope, as `expo-task-manager` requires: when the OS
 * relaunches the app for a location event, the task must exist before any
 * component mounts. `app/_layout.tsx` imports this file for that side effect.
 *
 * Guarded because `defineTask` throws where the native module is absent
 * (React Native Web, which Storybook runs on).
 */
try {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, handleBackgroundLocations);
} catch {
  // No task manager on this platform. `startLocationUpdatesAsync` fails the
  // same way, and the adapter falls back to foreground updates.
}
