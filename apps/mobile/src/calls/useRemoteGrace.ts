import { useEffect } from 'react';

import type { CallEvent, CallState } from './call-machine';

/**
 * How long the other party may be gone from the room before the call ends,
 * in milliseconds.
 *
 * ADR-0034 § 4 asks for "a short grace" and names no number. A peer whose app
 * was killed can flap once while its own reconnection runs, and a phone on a
 * Wi-Fi ↔ mobile handover is gone for a few seconds; much longer than that and
 * the person left on the line is talking to nobody. **Unverified on a device**
 * — the number to revisit when #183 holds a real call.
 */
export const REMOTE_GRACE_MS = 8_000;

/**
 * Whether the grace is running for this state: in the room, and the peer was
 * there and left. Not while reconnecting — this phone cannot see the room
 * then, so the peer's absence says nothing — and not before they ever joined.
 */
export function graceIsRunning(state: CallState): boolean {
  return state.phase === 'active' && state.peer === 'away';
}

/**
 * Ends the call when the other party has been gone from the room for
 * {@link REMOTE_GRACE_MS}, by dispatching `remote-gone-after-grace`.
 *
 * **The timer lives here and not in the reducer**, which stays pure. It is
 * derived from state rather than from the room's events: it runs exactly while
 * {@link graceIsRunning} holds, so a peer who rejoins stops it, a peer who
 * leaves again restarts it from zero, and a reconnection of this phone's own
 * pauses it and re-arms it with a full grace once the call is active again.
 * Nothing about LiveKit is needed to decide any of that.
 *
 * A late firing is harmless: the reducer ends the call only if the peer is
 * still away.
 */
export function useRemoteGrace(
  state: CallState,
  dispatch: (event: CallEvent) => void,
  graceMs: number = REMOTE_GRACE_MS,
): void {
  const running = graceIsRunning(state);

  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setTimeout(() => {
      dispatch({ type: 'remote-gone-after-grace' });
    }, graceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [dispatch, graceMs, running]);
}
