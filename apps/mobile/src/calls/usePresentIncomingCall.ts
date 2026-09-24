import type { Call } from '@tezusta/types';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { useAppDispatch, useAppSelector } from '../store/hooks';

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
 * - **Not while a call screen holds a live call**, and not twice for the ring
 *   already showing — the server has already answered a second caller `busy`.
 * - **Over an ended call screen, by replacing it** rather than stacking.
 * - **A navigation that throws lets go of the ring**, so it does not block
 *   every ring after it.
 * - **Nothing while calling ships dark** (`CALLING_ENABLED`, ADR-0039 § 3), and
 *   nothing for a call this account placed.
 */
export function usePresentIncomingCall(): (call: Call) => void {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const live = useAppSelector(selectCallSurfaceLive);
  const open = useAppSelector(selectCallSurfaceOpen);
  const ringing = useAppSelector(selectRingingCall);

  // Read through a ref so the callback is stable: a subscriber holding it is
  // not torn down and re-attached — and able to miss a frame — on every change.
  const state = useRef({ busy: false, open: false });
  useEffect(() => {
    state.current = { busy: live || ringing !== null, open };
  }, [live, open, ringing]);

  return useCallback(
    (call: Call) => {
      if (!CALLING_ENABLED || call.role !== 'callee' || state.current.busy) {
        return;
      }
      const replacing = state.current.open;
      state.current = { busy: true, open: true };
      dispatch(ringingCallReceived(call));
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
        state.current = { busy: false, open: replacing };
        dispatch(ringingCallCleared(call.id));
      }
    },
    [dispatch, router],
  );
}
