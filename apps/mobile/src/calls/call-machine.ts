import type { Call, CallErrorCode } from '@tezusta/types';

import { endOfCall } from './call-end-reason';
import type { CallEnd } from './call-end-reason';

/**
 * The two call state machines, as pure functions (issue #187, ADR-0034 § 4).
 *
 * **Nothing here imports React or LiveKit**, and that is the point of the
 * file. The hard part of a call client is not the screen; it is that two
 * independent sources — the server's signalling frames and the media room's
 * own events — each deliver late, twice, out of order or not at all. Kept
 * pure, every one of those orderings is a table row in a test rather than a
 * scenario somebody has to reproduce on two phones.
 *
 * **An event that does not apply returns the same state, by reference.** A
 * duplicated `call:accepted`, a frame for another call, a room event for a
 * phase that has no room: each is harmless because it is a no-op, and a no-op
 * the caller can detect with `===` re-renders nothing.
 *
 * **`ended` is terminal.** Nothing moves a call out of it — not a late accept,
 * not a room reconnecting, not a second end. A call that was over is over.
 */

/**
 * Whether the other party is in the media room, as this phone last heard.
 *
 * Three values, not a boolean, because "not there yet" and "was there and
 * left" are different: the first is a caller whose phone is still fetching
 * its credential, the second is the case the grace exists for
 * (`useRemoteGrace`). Only `away` can end a call.
 */
export type PeerPresence = 'awaiting' | 'present' | 'away';

export type CallPhase =
  'permissions' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'reconnecting' | 'ended';

/** Asking for the microphone, before anything is sent. */
export interface PermissionsCallState {
  readonly phase: 'permissions';
  readonly orderId: string;
  readonly callId: null;
}

/**
 * Invited and ringing the other phone. `callId` is null until the invite's ack
 * names the call — until then no frame can be matched to it, so none is.
 */
export interface OutgoingCallPhaseState {
  readonly phase: 'outgoing';
  readonly orderId: string;
  readonly callId: string | null;
}

/** This phone is ringing. */
export interface IncomingCallPhaseState {
  readonly phase: 'incoming';
  readonly orderId: string;
  readonly callId: string;
}

/** Answered; this phone is getting into the media room. */
export interface ConnectingCallState {
  readonly phase: 'connecting';
  readonly orderId: string;
  readonly callId: string;
}

/** In the room, or in it and recovering the connection. */
export interface HeldCallState {
  readonly phase: 'active' | 'reconnecting';
  readonly orderId: string;
  readonly callId: string;
  /** Epoch milliseconds when this phone first got into the room — the call timer's zero. */
  readonly connectedAt: number;
  readonly peer: PeerPresence;
}

export interface EndedCallState {
  readonly phase: 'ended';
  readonly orderId: string;
  /** Null only for an outgoing call that ended before its invite was answered. */
  readonly callId: string | null;
  readonly endReason: CallEnd;
  /** The phase the call ended from, which is what decides what to tell the server. */
  readonly endedFrom: Exclude<CallPhase, 'ended'>;
  /** Null for a call that never got into the room. */
  readonly connectedAt: number | null;
  /**
   * Whether the server already knows the call is over — it said so, or it
   * refused the request that would have continued it. When it does not, the
   * hook holding this state tells it (`useCall.ts`); when it does, telling it
   * again would at best be refused and at worst end somebody else's call.
   */
  readonly serverKnows: boolean;
}

export type OutgoingCallState =
  | PermissionsCallState
  | OutgoingCallPhaseState
  | ConnectingCallState
  | HeldCallState
  | EndedCallState;

export type IncomingCallState =
  IncomingCallPhaseState | ConnectingCallState | HeldCallState | EndedCallState;

export type CallState = OutgoingCallState | IncomingCallState;

/**
 * What the server said, translated from frames and acks by
 * `useCallSignalling`. Each names the call it is about.
 */
export type CallSignalEvent =
  /** The invite's ack: the call as recorded, which may already be `BUSY`. */
  | { readonly type: 'invite-acked'; readonly call: Call }
  | { readonly type: 'invite-refused'; readonly code: CallErrorCode }
  /** This phone's `call:accept` was refused; `call` is present when the server said how it is now. */
  | {
      readonly type: 'accept-refused';
      readonly callId: string;
      readonly code: CallErrorCode;
      readonly call: Call | null;
    }
  /** `call:accepted`. */
  | { readonly type: 'server-accepted'; readonly callId: string }
  /** `call:rejected`, `call:cancelled`, `call:timeout`, `call:busy` or `call:ended`. */
  | { readonly type: 'server-finished'; readonly call: Call };

/** What the person holding the phone did. */
export type CallUserEvent =
  | { readonly type: 'permission-granted' }
  | { readonly type: 'permission-denied' }
  | { readonly type: 'accept' }
  | { readonly type: 'decline' }
  | { readonly type: 'cancel' }
  | { readonly type: 'hangup' };

/**
 * What the media room did — fed by the room bridge once #183 lets LiveKit into
 * the app (ADR-0038). Scoped to one call's room, so none carries a call id.
 *
 * **`room-disconnected` is LiveKit's terminal `Disconnected` event, and only
 * that.** The connection *state* passes through disconnected between
 * reconnection attempts — backgrounding, a network blip, a Wi-Fi ↔ mobile
 * handover — and the bridge reports those as `room-reconnecting`. Ending a
 * call there kills calls WebRTC would have recovered (ADR-0034 § 4).
 *
 * **`remote-gone-after-grace` is the bridge's, after its timer**
 * (`useRemoteGrace`), not LiveKit's. A peer whose app was killed can flap once
 * during its own reconnect window, so `remote-left` only marks them away and
 * this is what ends the call.
 */
export type CallRoomEvent =
  | { readonly type: 'room-connected'; readonly at: number }
  | { readonly type: 'room-reconnecting' }
  | { readonly type: 'room-reconnected' }
  | { readonly type: 'room-disconnected' }
  | { readonly type: 'room-connect-failed' }
  | { readonly type: 'remote-joined' }
  | { readonly type: 'remote-left' }
  | { readonly type: 'remote-gone-after-grace' };

export type CallEvent = CallSignalEvent | CallUserEvent | CallRoomEvent;

/** A call this phone is about to place, before the microphone is settled. */
export function startOutgoingCall(orderId: string): PermissionsCallState {
  return { phase: 'permissions', orderId, callId: null };
}

/** A call ringing on this phone, from its `call:incoming` frame. */
export function startIncomingCall(call: Call): IncomingCallPhaseState {
  return { phase: 'incoming', orderId: call.orderId, callId: call.id };
}

type LiveCallState = Exclude<CallState, EndedCallState>;
type InCallState = ConnectingCallState | HeldCallState;
type InCallResult = InCallState | EndedCallState;

function ended(
  state: LiveCallState,
  endReason: CallEnd,
  serverKnows: boolean,
  callId: string | null = state.callId,
): EndedCallState {
  return {
    phase: 'ended',
    orderId: state.orderId,
    callId,
    endReason,
    endedFrom: state.phase,
    connectedAt:
      state.phase === 'active' || state.phase === 'reconnecting' ? state.connectedAt : null,
    serverKnows,
  };
}

/** The server finished this call: ended in the server's words, or ignored if it is not this call. */
function finishedByServer<State extends LiveCallState>(
  state: State,
  call: Call,
): State | EndedCallState {
  if (state.callId === null || call.id !== state.callId) {
    return state;
  }
  const endReason = endOfCall(call);
  return endReason === null ? state : ended(state, endReason, true);
}

/** The other party's presence in the room, while this phone is in it. */
function presence(state: HeldCallState, event: CallEvent): HeldCallState | EndedCallState {
  switch (event.type) {
    case 'remote-joined':
      return state.peer === 'present' ? state : { ...state, peer: 'present' };
    case 'remote-left':
      return state.peer === 'present' ? { ...state, peer: 'away' } : state;
    case 'remote-gone-after-grace':
      // Only from `active`: while this phone is itself reconnecting it cannot
      // tell a peer who left from a room it cannot see. The grace re-arms when
      // the call is active again and the peer is still away.
      return state.phase === 'active' && state.peer === 'away'
        ? ended(state, 'dropped', false)
        : state;
    default:
      return state;
  }
}

/**
 * Everything after the answer, shared by both directions: getting into the
 * room, holding the call, and every way it can end from there.
 */
function inCall(state: InCallState, event: CallEvent): InCallResult {
  switch (event.type) {
    case 'server-finished':
      // The server's word ends the call with no room event at all — or the
      // screen sits open on a room whose teardown never reached this phone.
      return finishedByServer(state, event.call);
    case 'hangup':
      return ended(state, 'completed', false);
    case 'room-disconnected':
      return ended(state, state.phase === 'connecting' ? 'connect_failed' : 'dropped', false);
    default:
      break;
  }

  if (state.phase === 'connecting') {
    switch (event.type) {
      case 'room-connected':
        return {
          phase: 'active',
          orderId: state.orderId,
          callId: state.callId,
          connectedAt: event.at,
          peer: 'awaiting',
        };
      case 'room-connect-failed':
        return ended(state, 'connect_failed', false);
      default:
        return state;
    }
  }

  switch (event.type) {
    case 'room-reconnecting':
      return state.phase === 'active' ? { ...state, phase: 'reconnecting' } : state;
    case 'room-reconnected':
      return state.phase === 'reconnecting' ? { ...state, phase: 'active' } : state;
    default:
      return presence(state, event);
  }
}

/**
 * The outgoing call: `permissions → outgoing → connecting → active ⇄
 * reconnecting`, and `ended` from any of them.
 */
export function outgoingCallReducer(state: OutgoingCallState, event: CallEvent): OutgoingCallState {
  switch (state.phase) {
    case 'permissions':
      switch (event.type) {
        case 'permission-granted':
          return { phase: 'outgoing', orderId: state.orderId, callId: null };
        case 'permission-denied':
          // Nothing was sent, so there is nothing for the server to know.
          return ended(state, 'permission_denied', true);
        case 'cancel':
          return ended(state, 'cancelled', true);
        default:
          return state;
      }

    case 'outgoing':
      switch (event.type) {
        case 'invite-acked':
          return acknowledged(state, event.call);
        case 'invite-refused':
          return state.callId === null ? ended(state, 'error', true) : state;
        case 'server-accepted':
          return state.callId !== null && event.callId === state.callId
            ? { phase: 'connecting', orderId: state.orderId, callId: state.callId }
            : state;
        case 'server-finished':
          return finishedByServer(state, event.call);
        case 'cancel':
          return ended(state, 'cancelled', false);
        default:
          return state;
      }

    case 'connecting':
    case 'active':
    case 'reconnecting':
      return inCall(state, event);

    case 'ended':
      return state;
  }
}

/**
 * The invite's ack, which is the only thing that names the call. Only the
 * first one counts, and only for this order.
 */
function acknowledged(state: OutgoingCallPhaseState, call: Call): OutgoingCallState {
  if (state.callId !== null || call.orderId !== state.orderId) {
    return state;
  }
  switch (call.status) {
    case 'RINGING':
      return { ...state, callId: call.id };
    case 'ACCEPTED':
      // Not an order the server produces — the ack leaves before anyone could
      // answer — but the status is the fact, and it says answered.
      return { phase: 'connecting', orderId: state.orderId, callId: call.id };
    default:
      // `BUSY` above all: a valid invite refused because somebody is already
      // on a call. It never rang, and the row says so.
      return ended(state, endOfCall(call) ?? 'error', true, call.id);
  }
}

/**
 * The incoming call: `incoming → connecting → active ⇄ reconnecting`, and
 * `ended` from any of them.
 */
export function incomingCallReducer(state: IncomingCallState, event: CallEvent): IncomingCallState {
  switch (state.phase) {
    case 'incoming':
      switch (event.type) {
        case 'accept':
          return { phase: 'connecting', orderId: state.orderId, callId: state.callId };
        case 'decline':
          return ended(state, 'declined', false);
        case 'permission-denied':
          // Refusing the microphone on a ringing phone is a decline the
          // server has to hear, or the caller listens to it ring out.
          return ended(state, 'permission_denied', false);
        case 'server-accepted':
          // Answered, but not here: this account's other phone took it
          // (every device hears `call:accepted`, so the rest stop ringing).
          // Not missed and not refused — the call is being held.
          return event.callId === state.callId ? ended(state, 'completed', true) : state;
        case 'server-finished':
          return finishedByServer(state, event.call);
        default:
          return state;
      }

    case 'connecting':
      if (event.type === 'accept-refused') {
        return event.callId === state.callId ? acceptRefused(state, event) : state;
      }
      // A `call:accepted` here is this phone's own answer coming back, and
      // changes nothing — `inCall` has no case for it.
      return inCall(state, event);

    case 'active':
    case 'reconnecting':
      return inCall(state, event);

    case 'ended':
      return state;
  }
}

/**
 * This phone's answer was refused. The server knows every one of these
 * outcomes already, so none is followed by another request.
 */
function acceptRefused(
  state: ConnectingCallState,
  event: Extract<CallSignalEvent, { type: 'accept-refused' }>,
): IncomingCallState {
  const { call } = event;
  if (call === null) {
    return ended(state, 'error', true);
  }
  switch (call.status) {
    case 'ACCEPTED':
      // `CALL_UNAVAILABLE` with the call: accepted, and only the credential
      // is missing — the hook fetches it from `POST /calls/:id/join`. Any
      // other code with an accepted call is `CALL_STALE`: another of this
      // account's phones answered first, and this one must not hang it up.
      return event.code === 'CALL_UNAVAILABLE' ? state : ended(state, 'completed', true);
    case 'RINGING':
      return ended(state, 'error', true);
    default:
      return ended(state, endOfCall(call) ?? 'error', true);
  }
}
