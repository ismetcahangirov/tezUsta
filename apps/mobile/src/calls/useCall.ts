import type { Call, CallJoinCredential } from '@tezusta/types';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { useAppDispatch } from '../store/hooks';

import { callsApi } from './call-endpoints';
import {
  incomingCallReducer,
  outgoingCallReducer,
  startIncomingCall,
  startOutgoingCall,
} from './call-machine';
import type {
  CallEvent,
  CallRoomEvent,
  CallState,
  IncomingCallState,
  OutgoingCallState,
} from './call-machine';
import { useCallRequests, useCallSignalling } from './useCallSignalling';
import type { CallRequests } from './useCallSignalling';
import { useRemoteGrace } from './useRemoteGrace';

/** What both directions expose to a call surface and, later, to the room bridge. */
export interface CallControls<State extends CallState> {
  readonly state: State;
  /**
   * This phone's credential for the call's media room, or null before it has
   * one and after the call ends.
   *
   * **Held in React state and nowhere else** — not the store, not a log, not
   * storage (ADR-0034 § 3). It is a bearer token for the room; the room bridge
   * reads it from here when #183 lets LiveKit into the app.
   */
  readonly credential: CallJoinCredential | null;
  /** Where the room bridge (#187, behind #183) feeds what the room did. */
  readonly roomEvent: (event: CallRoomEvent) => void;
  readonly hangup: () => void;
}

export interface OutgoingCall extends CallControls<OutgoingCallState> {
  /**
   * The other party as the invite's ack named them, or null before it has
   * answered. The screen shows their name from here (#188): an outgoing call
   * is opened from an order, and neither the order nor the job carries it.
   */
  readonly peer: Call['peer'] | null;
  readonly permissionGranted: () => void;
  readonly permissionDenied: () => void;
  readonly cancel: () => void;
}

export interface IncomingCall extends CallControls<IncomingCallState> {
  readonly accept: () => void;
  readonly decline: () => void;
  readonly permissionDenied: () => void;
}

/**
 * The state as of the last commit, for a promise that resolves later and has
 * to know whether the call it was made for is still the one on screen.
 */
function useLatest<Value>(value: Value): { readonly current: Value } {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}

/**
 * What every call does whatever its direction: hear the server, run the
 * grace, fetch a credential, and tell the server about an end it did not
 * cause.
 */
function useCallPlumbing(
  state: CallState,
  dispatch: (event: CallEvent) => void,
  requests: CallRequests,
): {
  readonly credential: CallJoinCredential | null;
  readonly setCredential: (credential: CallJoinCredential) => void;
  readonly fetchCredential: (callId: string) => void;
} {
  const appDispatch = useAppDispatch();
  const latest = useLatest(state);
  const [credential, setHeld] = useState<CallJoinCredential | null>(null);
  const told = useRef(false);

  useCallSignalling(state.callId, dispatch);
  useRemoteGrace(state, dispatch);

  /** Kept only if it is still for the call on screen, and that call is not over. */
  const setCredential = useCallback(
    (next: CallJoinCredential) => {
      const now = latest.current;
      if (now.phase !== 'ended' && now.callId === next.callId) {
        setHeld(next);
      }
    },
    [latest],
  );

  const fetchCredential = useCallback(
    (callId: string) => {
      // `track: false`: the result is never written to the store
      // (`call-endpoints.ts`), only handed back here.
      void appDispatch(callsApi.endpoints.joinCall.initiate(callId, { track: false }))
        .unwrap()
        .then(setCredential, () => {
          if (latest.current.callId === callId) {
            dispatch({ type: 'room-connect-failed' });
          }
        });
    },
    [appDispatch, dispatch, latest, setCredential],
  );

  useEffect(() => {
    if (state.phase !== 'ended') {
      return;
    }
    // Dropped the moment the call is over: a credential outlives nothing it
    // was issued for.
    setHeld(null);

    if (state.serverKnows || state.callId === null || told.current) {
      return;
    }
    told.current = true;
    // The server has to hear about an end it did not cause, or the other
    // phone keeps ringing — or keeps talking to nobody — until a timer or the
    // reaper (#186) notices. Which request says so depends on how far the
    // call had got. Its ack is not waited on: the call is over here either
    // way, and a refusal means the server had already moved on.
    const tell =
      state.endedFrom === 'outgoing'
        ? requests.cancel
        : state.endedFrom === 'incoming'
          ? requests.reject
          : requests.hangup;
    void tell(state.callId);
  }, [requests, state]);

  return { credential, setCredential, fetchCredential };
}

/**
 * A call this phone places on one order (issue #187).
 *
 * The call surface asks for the microphone and reports the answer; everything
 * after that — the invite, matching the server's frames to the call, the
 * credential once answered, the grace, telling the server about an end it did
 * not cause — happens here, driven by the reducer's state rather than by the
 * order the surface happens to call things in.
 */
export function useOutgoingCall(orderId: string): OutgoingCall {
  const [state, dispatch] = useReducer(outgoingCallReducer, orderId, startOutgoingCall);
  const requests = useCallRequests();
  const latest = useLatest(state);
  const { credential, fetchCredential } = useCallPlumbing(state, dispatch, requests);
  const invited = useRef(false);
  const joining = useRef<string | null>(null);
  const [peer, setPeer] = useState<Call['peer'] | null>(null);

  useEffect(() => {
    if (state.phase !== 'outgoing' || state.callId !== null || invited.current) {
      return;
    }
    invited.current = true;
    void requests.invite(state.orderId).then((ack) => {
      if (!ack.ok) {
        dispatch({ type: 'invite-refused', code: ack.code });
        return;
      }
      setPeer(ack.call.peer);
      if (latest.current.phase === 'ended') {
        // Cancelled while the invite was in flight. The reducer cannot hear
        // this ack any more — `ended` is terminal — so the ring the server
        // just started is stopped from here.
        if (ack.call.status === 'RINGING') {
          void requests.cancel(ack.call.id);
        }
        return;
      }
      dispatch({ type: 'invite-acked', call: ack.call });
    });
  }, [latest, requests, state]);

  useEffect(() => {
    // The caller learns of the answer from `call:accepted`, which goes to
    // every device and so carries no credential; this device asks for one.
    if (state.phase !== 'connecting' || joining.current === state.callId) {
      return;
    }
    joining.current = state.callId;
    fetchCredential(state.callId);
  }, [fetchCredential, state]);

  const actions = useMemo(
    () => ({
      permissionGranted: () => dispatch({ type: 'permission-granted' }),
      permissionDenied: () => dispatch({ type: 'permission-denied' }),
      cancel: () => dispatch({ type: 'cancel' }),
      hangup: () => dispatch({ type: 'hangup' }),
      roomEvent: (event: CallRoomEvent) => dispatch(event),
    }),
    [],
  );

  return { state, credential, peer, ...actions };
}

/**
 * A call ringing on this phone, from its `call:incoming` frame (issue #187).
 *
 * Accepting sends `call:accept`, whose ack is the one frame that ever carries
 * a credential. If the call was accepted but the credential could not be
 * minted (`CALL_UNAVAILABLE` with the call), it is fetched from
 * `POST /calls/:id/join` instead.
 */
export function useIncomingCall(call: Call): IncomingCall {
  const [state, dispatch] = useReducer(incomingCallReducer, call, startIncomingCall);
  const requests = useCallRequests();
  const { credential, setCredential, fetchCredential } = useCallPlumbing(state, dispatch, requests);
  const answered = useRef(false);

  useEffect(() => {
    if (state.phase !== 'connecting' || answered.current) {
      return;
    }
    answered.current = true;
    const { callId } = state;
    void requests.accept(callId).then((ack) => {
      if (ack.ok) {
        setCredential(ack.credential);
        return;
      }
      const now = ack.call ?? null;
      dispatch({ type: 'accept-refused', callId, code: ack.code, call: now });
      if (ack.code === 'CALL_UNAVAILABLE' && now?.status === 'ACCEPTED') {
        fetchCredential(callId);
      }
    });
  }, [fetchCredential, requests, setCredential, state]);

  const actions = useMemo(
    () => ({
      accept: () => dispatch({ type: 'accept' }),
      decline: () => dispatch({ type: 'decline' }),
      permissionDenied: () => dispatch({ type: 'permission-denied' }),
      hangup: () => dispatch({ type: 'hangup' }),
      roomEvent: (event: CallRoomEvent) => dispatch(event),
    }),
    [],
  );

  return { state, credential, ...actions };
}
