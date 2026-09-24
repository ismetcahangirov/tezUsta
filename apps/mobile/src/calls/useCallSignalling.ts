import type { Call, CallRefusal, CallRequestName } from '@tezusta/types';
import { useCallback, useEffect, useMemo } from 'react';

import { unavailableCallRefusal } from '../realtime/realtime-connection';
import type { CallFrame, CallRequestMap } from '../realtime/realtime-events';
import { useRealtimeConnection } from '../realtime/RealtimeProvider';

import type { CallSignalEvent } from './call-machine';

/**
 * The reducer event one inbound frame means for the call with `callId`, or
 * `null` when it means nothing to it.
 *
 * **Matched on the call id, always.** Frames go to every device an account
 * holds (`realtime-architecture.md` § Call signalling), so a phone can hear a
 * frame for a call it is not showing — its own previous call ending late, or
 * a second call on another order. The reducers check the id too; this is the
 * first of two locks, not the only one.
 *
 * `call:incoming` is never an event for a call already being shown: a ring
 * starts a call ({@link useIncomingCallFrames}), it does not move one.
 */
export function signalForFrame(frame: CallFrame, callId: string): CallSignalEvent | null {
  const { call } = frame.payload;
  if (call.id !== callId) {
    return null;
  }
  switch (frame.name) {
    case 'call:incoming':
      return null;
    case 'call:accepted':
      return { type: 'server-accepted', callId: call.id };
    case 'call:rejected':
    case 'call:cancelled':
    case 'call:timeout':
    case 'call:busy':
    case 'call:ended':
      return { type: 'server-finished', call };
  }
}

/**
 * Feeds the call with `callId` every frame the server sends about it, as
 * reducer events. Nothing while `callId` is null — an invite not yet answered
 * names no call, and a frame cannot be matched to one that has no id.
 *
 * With no connection (a test, or a network that blocks WebSocket) it hears
 * nothing, which is what a lost frame costs anyway: the server's own timers
 * and `POST /calls/:id/join` are what a call leans on when the socket is gone.
 */
export function useCallSignalling(
  callId: string | null,
  onEvent: (event: CallSignalEvent) => void,
): void {
  const connection = useRealtimeConnection();

  useEffect(() => {
    if (connection === null || callId === null) {
      return;
    }
    return connection.subscribeToCalls((frame) => {
      const event = signalForFrame(frame, callId);
      if (event !== null) {
        onEvent(event);
      }
    });
  }, [callId, connection, onEvent]);
}

/**
 * Calls `onIncoming` with every call that starts ringing this phone — the one
 * thing that creates an incoming call's state (`startIncomingCall`).
 *
 * What to do with a second ring while a call is on screen is the call
 * surface's question (#188); the server already answers the caller `busy`.
 */
export function useIncomingCallFrames(onIncoming: (call: Call) => void): void {
  const connection = useRealtimeConnection();

  useEffect(() => {
    if (connection === null) {
      return;
    }
    return connection.subscribeToCalls((frame) => {
      if (frame.name === 'call:incoming') {
        onIncoming(frame.payload.call);
      }
    });
  }, [connection, onIncoming]);
}

type Ack<Name extends CallRequestName> = CallRequestMap[Name]['ack'] | CallRefusal;

/** The five requests a phone may make about a call, each resolving with its ack. */
export interface CallRequests {
  readonly invite: (orderId: string) => Promise<Ack<'call:invite'>>;
  readonly accept: (callId: string) => Promise<Ack<'call:accept'>>;
  readonly reject: (callId: string) => Promise<Ack<'call:reject'>>;
  readonly cancel: (callId: string) => Promise<Ack<'call:cancel'>>;
  readonly hangup: (callId: string) => Promise<Ack<'call:hangup'>>;
}

/**
 * The call requests over the app's one socket. None rejects: a refusal, a
 * missing connection and an ack that never came all resolve as a
 * `CallRefusal` (`RealtimeConnection.requestCall`).
 */
export function useCallRequests(): CallRequests {
  const connection = useRealtimeConnection();

  const request = useCallback(
    <Name extends CallRequestName>(
      name: Name,
      body: CallRequestMap[Name]['request'],
    ): Promise<Ack<Name>> =>
      connection === null
        ? Promise.resolve(unavailableCallRefusal())
        : connection.requestCall(name, body),
    [connection],
  );

  return useMemo(
    () => ({
      invite: (orderId) => request('call:invite', { orderId }),
      accept: (callId) => request('call:accept', { callId }),
      reject: (callId) => request('call:reject', { callId }),
      cancel: (callId) => request('call:cancel', { callId }),
      hangup: (callId) => request('call:hangup', { callId }),
    }),
    [request],
  );
}
