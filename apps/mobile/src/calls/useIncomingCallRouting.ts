import type { Call } from '@tezusta/types';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { useAppDispatch, useAppSelector } from '../store/hooks';

import type { CallSignalEvent } from './call-machine';
import { CALLING_ENABLED } from './calling-enabled';
import {
  ringingCallCleared,
  ringingCallReceived,
  selectCallSurfaceLive,
  selectCallSurfaceOpen,
  selectRingingCall,
} from './ringing-call-slice';
import { useCallSignalling, useIncomingCallFrames } from './useCallSignalling';

/** The incoming call route, presented over whatever is on screen (ADR-0040 § 1). */
export const INCOMING_CALL_ROUTE = '/call/incoming/[callId]';

/**
 * Turns a `call:incoming` frame into the incoming call screen (issue #188).
 *
 * Mounted once, at the root, inside the app's one connection
 * (`IncomingCallListener`): a ring has to reach the person whatever screen they
 * are on, which is why the call is a root modal rather than a screen inside the
 * order stack.
 *
 * - **A second ring while a call screen holds a live call is left alone.** The
 *   server has already answered that caller `busy` (#185); showing it would
 *   only put a second call screen over the first. A duplicated frame for the
 *   ring already showing is left alone for the same reason.
 * - **A ring while an ended call screen is still open replaces it** rather
 *   than stacking a call over a call that is over.
 * - **A ring that ends before its screen shows is let go of.** Any terminal
 *   frame for the ringing id clears the slice, so a screen that mounts late
 *   finds no ring and closes instead of showing a call nobody is making.
 * - **A navigation that throws lets go of the ring**, so a failed push does not
 *   leave a stored ring blocking every ring after it.
 * - **Nothing at all while calling ships dark** (`CALLING_ENABLED`, ADR-0039
 *   § 3).
 */
export function useIncomingCallRouting(): void {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const live = useAppSelector(selectCallSurfaceLive);
  const open = useAppSelector(selectCallSurfaceOpen);
  const ringing = useAppSelector(selectRingingCall);

  // Read through refs so a change of any of these does not re-subscribe to the
  // connection — a subscription torn down between two frames could miss one.
  const state = useRef({ busy: false, open: false });
  useEffect(() => {
    state.current = { busy: live || ringing !== null, open };
  }, [live, open, ringing]);

  const onIncoming = useCallback(
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

  useIncomingCallFrames(onIncoming);

  const ringingId = ringing?.id ?? null;
  const onRingingSignal = useCallback(
    (event: CallSignalEvent) => {
      // Finished, or answered on another of this account's phones: either way
      // it is not ringing here any more. A screen already showing it holds its
      // own copy and shows the end; one that has not mounted yet finds nothing.
      if (
        ringingId !== null &&
        (event.type === 'server-finished' || event.type === 'server-accepted')
      ) {
        dispatch(ringingCallCleared(ringingId));
      }
    },
    [dispatch, ringingId],
  );

  useCallSignalling(ringingId, onRingingSignal);
}

/** The root's ring listener, as a component so it can sit inside `RealtimeProvider`. */
export function IncomingCallListener(): null {
  useIncomingCallRouting();
  return null;
}
