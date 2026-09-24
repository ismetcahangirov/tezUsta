import { useCallback } from 'react';

import { useAppDispatch, useAppSelector } from '../store/hooks';

import type { CallSignalEvent } from './call-machine';
import { ringingCallCleared, selectRingingCall } from './ringing-call-slice';
import { useCallSignalling, useIncomingCallFrames } from './useCallSignalling';
import { usePresentIncomingCall } from './usePresentIncomingCall';

/**
 * Turns a `call:incoming` frame into the incoming call screen (issue #188).
 *
 * Mounted once, at the root, inside the app's one connection
 * (`IncomingCallListener`): a ring has to reach the person whatever screen they
 * are on, which is why the call is a root modal rather than a screen inside the
 * order stack. When a ring is shown is `usePresentIncomingCall`'s — the same
 * rules a confirmed ring push goes through (#189).
 *
 * **A ring that ends before its screen shows is let go of.** Any terminal
 * frame for the ringing id clears the slice, so a screen that mounts late
 * finds no ring and closes instead of showing a call nobody is making.
 */
export function useIncomingCallRouting(): void {
  const dispatch = useAppDispatch();
  const ringing = useAppSelector(selectRingingCall);
  const present = usePresentIncomingCall();

  useIncomingCallFrames(present);

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
