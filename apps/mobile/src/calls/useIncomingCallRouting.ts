import type { Call } from '@tezusta/types';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';

import { useAppDispatch, useAppSelector } from '../store/hooks';

import { CALLING_ENABLED } from './calling-enabled';
import {
  ringingCallReceived,
  selectCallSurfaceLive,
  selectRingingCall,
} from './ringing-call-slice';
import { useIncomingCallFrames } from './useCallSignalling';

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
 * **A second ring while a call is on screen is left alone.** The server has
 * already answered that caller `busy` (#185) — this account is on a live call —
 * so showing it would only put a second call screen over the first. The same
 * holds for a ring already being shown: a duplicated frame does not push the
 * screen twice.
 *
 * **Nothing at all while calling ships dark** (`CALLING_ENABLED`, ADR-0039
 * § 3). No build can place a call yet, so none should ring; if one somehow
 * did, a screen that could only ever reach `connecting` would be worse than
 * silence.
 */
export function useIncomingCallRouting(): void {
  const dispatch = useAppDispatch();
  const router = useRouter();
  const live = useAppSelector(selectCallSurfaceLive);
  const ringing = useAppSelector(selectRingingCall);

  // Read through refs so a change of either does not re-subscribe to the
  // connection — a subscription torn down between two frames could miss one.
  const busy = useRef(false);
  useEffect(() => {
    busy.current = live || ringing !== null;
  }, [live, ringing]);

  const onIncoming = useCallback(
    (call: Call) => {
      if (!CALLING_ENABLED || call.role !== 'callee' || busy.current) {
        return;
      }
      busy.current = true;
      dispatch(ringingCallReceived(call));
      router.push({ pathname: INCOMING_CALL_ROUTE, params: { callId: call.id } });
    },
    [dispatch, router],
  );

  useIncomingCallFrames(onIncoming);
}

/** The root's ring listener, as a component so it can sit inside `RealtimeProvider`. */
export function IncomingCallListener(): null {
  useIncomingCallRouting();
  return null;
}
