import type { Call } from '@tezusta/types';
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { useAppStore } from '../store/hooks';

import { CALLING_ENABLED } from './calling-enabled';
import {
  ringingCallCleared,
  ringingCallReceived,
  selectCallSurfaceLive,
  selectCallSurfaceOpen,
  selectRingingCall,
} from './ringing-call-slice';

/** The incoming call route, presented over whatever is on screen (ADR-0040 § 1). */
export const INCOMING_CALL_ROUTE = '/call/incoming/[callId]';

/**
 * Presents a ringing call: stores it in the `ringingCall` slice and opens the
 * incoming screen for it.
 *
 * **The one path to the incoming screen**, shared by the socket's
 * `call:incoming` (`useIncomingCallRouting`) and a ring push confirmed with
 * the server (`useNotificationRouting`, #189), so the two can never disagree
 * about when a ring is shown:
 *
 * - **Not while a call screen holds a live call**, and not twice for a ring
 *   already stored — the server has already answered a second caller `busy`.
 * - **Over an ended call screen, by replacing it** rather than stacking.
 * - **A navigation that throws lets go of the ring**, so it does not block
 *   every ring after it.
 * - **Nothing while calling ships dark** (`CALLING_ENABLED`, ADR-0039 § 3), and
 *   nothing for a call this account placed.
 *
 * **The store is read at the moment of the call, not a copy of it.** The
 * callers are two independent event sources — a push arrival and a socket
 * frame can land in the same tick — and a per-caller copy synced in an effect
 * would let each see "nothing ringing" and push its own screen. The ring is
 * written to the store before the navigation, so whichever call comes second
 * reads it and stops.
 */
export function usePresentIncomingCall(): (call: Call) => void {
  const store = useAppStore();
  const router = useRouter();

  return useCallback(
    (call: Call) => {
      if (!CALLING_ENABLED || call.role !== 'callee') {
        return;
      }
      const state = store.getState();
      if (selectCallSurfaceLive(state) || selectRingingCall(state) !== null) {
        return;
      }
      const replacing = selectCallSurfaceOpen(state);
      store.dispatch(ringingCallReceived(call));
      const target = { pathname: INCOMING_CALL_ROUTE, params: { callId: call.id } };
      try {
        if (replacing) {
          router.replace(target);
        } else {
          router.push(target);
        }
      } catch {
        // No navigator to present it on — the ring is let go of rather than
        // left in the slice, where it would make every later ring look busy.
        store.dispatch(ringingCallCleared(call.id));
      }
    },
    [router, store],
  );
}
