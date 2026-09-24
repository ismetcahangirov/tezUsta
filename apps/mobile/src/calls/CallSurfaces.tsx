import type { Call, CallPartyKind } from '@tezusta/types';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { dismissCallNotifications } from '../notifications/push-adapter';
import { useAppDispatch } from '../store/hooks';

import { CALL_COPY as copy } from './call-copy';
import type { CallPhase } from './call-machine';
import { CallScreen } from './CallScreen';
import { callSurfaceClosed, callSurfaceShown, ringingCallCleared } from './ringing-call-slice';
import { useIncomingCall, useOutgoingCall } from './useCall';
import { useCallServiceName } from './useCallServiceName';
import { isHeld, useHoldCallScreen } from './useHoldCallScreen';
import { useMicrophonePermission } from './useMicrophonePermission';

/** The other side of the order from `viewer`. */
function otherSide(viewer: CallPartyKind): CallPartyKind {
  return viewer === 'customer' ? 'master' : 'customer';
}

/**
 * Mute and speaker, as local toggles.
 *
 * **They change nothing about the audio yet** (ADR-0039): there is no room
 * until the bridge lands, and the bridge is what will mute the published track
 * and route the output. Until then they are the screen's state and nothing
 * else — held here, not in the reducer, because neither is a fact about the
 * call the server or the other phone could disagree with.
 */
function useLocalToggles() {
  const [muted, setMuted] = useState(false);
  const [speakerOn, setSpeakerOn] = useState(false);
  return {
    muted,
    speakerOn,
    onToggleMute: useCallback(() => {
      setMuted((value) => !value);
    }, []),
    onToggleSpeaker: useCallback(() => {
      setSpeakerOn((value) => !value);
    }, []),
  };
}

/**
 * Puts this screen on record with the root (`useIncomingCallRouting`): live
 * while its call is past the microphone question and not over, so a second
 * ring is left alone; open but not live once it has ended, so a new ring
 * replaces it. Keyed by a token this screen owns, so closing it can only
 * withdraw its own record — never a newer screen's.
 */
function useCallSurfaceRecord(phase: CallPhase): void {
  const dispatch = useAppDispatch();
  const token = useId();
  // One predicate with the hold on the back button (`isHeld`), so the root's
  // idea of "live" and the screen's refusal to leave can never disagree.
  const live = isHeld(phase);

  useEffect(() => {
    dispatch(callSurfaceShown({ token, live }));
  }, [dispatch, live, token]);

  useEffect(
    () => () => {
      dispatch(callSurfaceClosed(token));
    },
    [dispatch, token],
  );
}

export interface OutgoingCallSurfaceProps {
  readonly orderId: string;
  /** This phone's side of the order. */
  readonly viewer: CallPartyKind;
  readonly onClose: () => void;
}

/**
 * A call this phone is placing, from the order it is about (issue #188).
 *
 * **The microphone is asked first, and nothing is sent until it answers.** The
 * reducer starts in `permissions`, a phase that exists for this and that is
 * reached only by the person tapping the call button — so asking here is asking
 * at the moment the question was earned, not on some unrelated mount. A refusal
 * is handed to the reducer as `permission-denied`, which ends the call as
 * `permission_denied` with no invite ever sent.
 */
export function OutgoingCallSurface({
  orderId,
  viewer,
  onClose,
}: OutgoingCallSurfaceProps): React.JSX.Element {
  const call = useOutgoingCall(orderId);
  const microphone = useMicrophonePermission();
  const toggles = useLocalToggles();
  const serviceName = useCallServiceName(orderId, viewer);
  const asked = useRef(false);
  const { state, permissionGranted, permissionDenied } = call;

  useCallSurfaceRecord(state.phase);
  useHoldCallScreen(state.phase);

  useEffect(() => {
    if (state.phase !== 'permissions' || asked.current) {
      return;
    }
    asked.current = true;
    void microphone.request().then((granted) => {
      // A cancel while the prompt was up has already ended the call, and the
      // reducer ignores either answer from `ended`.
      if (granted) {
        permissionGranted();
      } else {
        permissionDenied();
      }
    });
  }, [microphone, permissionDenied, permissionGranted, state.phase]);

  return (
    <CallScreen
      state={state}
      peerName={call.peer?.displayName ?? copy.peerFallback[otherSide(viewer)]}
      serviceName={serviceName}
      {...toggles}
      onCancel={call.cancel}
      onHangup={call.hangup}
      onClose={onClose}
    />
  );
}

export interface IncomingCallSurfaceProps {
  /** The ringing call, as the `call:incoming` frame described it. */
  readonly call: Call;
  readonly onClose: () => void;
}

/**
 * A call ringing this phone (issue #188).
 *
 * **The microphone is asked on accept, never on mount.** A phone that rings and
 * immediately raises a permission dialog over the caller's name has asked the
 * wrong question at the wrong moment, and declining needs no microphone at
 * all. Granted, the answer goes to the server; refused, the reducer ends the
 * call as `permission_denied`, the hook tells the server it was declined, and
 * no room is ever opened.
 */
export function IncomingCallSurface({
  call,
  onClose,
}: IncomingCallSurfaceProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const incoming = useIncomingCall(call);
  const microphone = useMicrophonePermission();
  const toggles = useLocalToggles();
  const viewer = otherSide(call.peer.kind);
  const serviceName = useCallServiceName(call.orderId, viewer);
  const [accepting, setAccepting] = useState(false);
  const { state, accept, permissionDenied } = incoming;

  useCallSurfaceRecord(state.phase);
  useHoldCallScreen(state.phase);

  useEffect(() => {
    // The ring is over the moment the call is: the slice lets go of it, and
    // this screen keeps showing the ended state from its own copy until it is
    // closed (ADR-0040 § 5).
    if (state.phase === 'ended') {
      dispatch(ringingCallCleared(call.id));
    }
  }, [call.id, dispatch, state.phase]);

  useEffect(
    () => () => {
      dispatch(ringingCallCleared(call.id));
    },
    [call.id, dispatch],
  );

  const ringing = state.phase === 'incoming';
  useEffect(() => {
    // Answered, declined, or over some other way: this phone has stopped
    // ringing, so its ring notification comes down too (ADR-0039 § 6, #189).
    // The root also dismisses on every `call:*` frame; this covers the answer
    // or decline made here even if that frame never arrives.
    if (!ringing) {
      void dismissCallNotifications(call.id);
    }
  }, [call.id, ringing]);

  const onAccept = useCallback(() => {
    setAccepting(true);
    void microphone.request().then((granted) => {
      setAccepting(false);
      if (granted) {
        accept();
      } else {
        permissionDenied();
      }
    });
  }, [accept, microphone, permissionDenied]);

  return (
    <CallScreen
      state={state}
      peerName={call.peer.displayName ?? copy.peerFallback[call.peer.kind]}
      serviceName={serviceName}
      {...toggles}
      accepting={accepting}
      onAccept={onAccept}
      onDecline={incoming.decline}
      onHangup={incoming.hangup}
      onClose={onClose}
    />
  );
}
