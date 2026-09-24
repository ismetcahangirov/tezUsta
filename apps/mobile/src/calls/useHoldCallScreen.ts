import { usePreventRemove } from 'expo-router/react-navigation';

import type { CallPhase } from './call-machine';

/**
 * Keeps a call screen on screen while its call is live (#188 review, item 3).
 *
 * The routes already turn gestures off (`app/_layout.tsx`), but Android's
 * hardware back is not a gesture: it would pop the modal and leave the other
 * phone ringing, or talking to nobody. React Navigation's `usePreventRemove`
 * — re-exported by the installed `expo-router@57.0.21` from
 * `expo-router/react-navigation` — holds every removal of this screen while
 * the call is live, the hardware back included. The call ends through its own
 * controls, and the ended screen closes normally.
 *
 * `useCall.ts` has a second net under this one: if a screen goes away anyway,
 * the hook tells the server once, by how far the call had got.
 */
/**
 * **The same predicate as the screen's `live` record** (`CallSurfaces.tsx`):
 * past the microphone question and not over. Holding during `permissions`
 * too would silently refuse the root's `router.replace` when a ring arrives
 * while the question is still up — the root sees no live call there — and the
 * ring would be lost. Nothing has been sent in `permissions`, so letting the
 * screen go costs nothing.
 */
export function isHeld(phase: CallPhase): boolean {
  return phase !== 'permissions' && phase !== 'ended';
}

export function useHoldCallScreen(phase: CallPhase): void {
  usePreventRemove(isHeld(phase), () => {
    // Deliberately nothing: the removal is refused, and the screen's own
    // cancel, decline and hang-up are the ways out of a live call.
  });
}
