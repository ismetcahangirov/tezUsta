import { useEffect } from 'react';
import { AppState } from 'react-native';

import { useSendHeartbeatMutation } from './master-availability-endpoints';

/**
 * Keeps a master's presence alive while they are online.
 *
 * The server holds liveness as a Redis key with a TTL and the app is what
 * refreshes it. The **interval comes from the server** (`heartbeatSeconds` on
 * the availability response), not from a constant here: a client that chose
 * its own interval would be the thing deciding how long a phantom master stays
 * online, and changing it would mean shipping a release.
 *
 * Three behaviours are deliberate.
 *
 * **It beats immediately on becoming online**, not after one interval. A master
 * who has just flipped the switch expects to be working now, and the toggle
 * already refreshed presence server-side — this makes the app's own loop agree
 * from the first tick rather than leaving a window where it has not proven
 * itself.
 *
 * **It beats again when the app returns to the foreground.** Android freezes
 * background timers, so a master who switched apps for two minutes comes back
 * with lapsed presence; waiting out another interval would leave them visibly
 * offline for up to a minute after they are looking at the screen.
 *
 * **It does not retry a failed beat.** A failure is either "you are offline"
 * or "you are no longer eligible" — a suspension mid-shift — and both are
 * answered by reading the real state rather than by trying again. The
 * mutation's `onQueryStarted` leaves the cache alone on failure and the screen
 * shows the divergence, which is exactly the warning master-flow.md asks for.
 */
export function useAvailabilityHeartbeat(isOnline: boolean, heartbeatSeconds: number): void {
  const [sendHeartbeat] = useSendHeartbeatMutation();

  useEffect(() => {
    if (!isOnline) {
      return;
    }

    // `void` rather than `await`: a heartbeat that rejects is handled by the
    // mutation itself, and an unhandled rejection here would be a crash on a
    // dropped connection.
    const beat = (): void => {
      void sendHeartbeat();
    };

    beat();
    const interval = setInterval(beat, Math.max(heartbeatSeconds, 1) * 1000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        beat();
      }
    });

    return (): void => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [isOnline, heartbeatSeconds, sendHeartbeat]);
}
