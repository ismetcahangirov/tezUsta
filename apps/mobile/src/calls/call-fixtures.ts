import type { Call, CallStatus } from '@tezusta/types';

import type { CallEnd } from './call-end-reason';
import {
  incomingCallReducer,
  outgoingCallReducer,
  startIncomingCall,
  startOutgoingCall,
} from './call-machine';
import type { CallEvent, CallState, IncomingCallState, OutgoingCallState } from './call-machine';

/**
 * Call states for stories and tests, **reached by driving the reducers**
 * rather than written out as objects (CLAUDE.md §13, #188). A fixture that
 * typed a state by hand could describe one the machine can never be in; one
 * produced by the machine cannot.
 *
 * Not a test file and not production code: imported by `*.stories.tsx` and
 * `*.test.tsx` only, which the project graph's rules allow for a non-test
 * module under `src/`.
 */

export const FIXTURE_ORDER_ID = 'order-1';
export const FIXTURE_CALL_ID = 'call-1';
/** When the fixtures' calls got into the room, epoch milliseconds. */
export const FIXTURE_CONNECTED_AT = 1_000_000;

export function fixtureCall(status: CallStatus, overrides: Partial<Call> = {}): Call {
  return {
    id: FIXTURE_CALL_ID,
    orderId: FIXTURE_ORDER_ID,
    status,
    endReason: null,
    role: 'callee',
    peer: { kind: 'master', displayName: 'Elvin Məmmədov' },
    startedAt: '2026-09-24T10:00:00.000Z',
    answeredAt: null,
    endedAt: null,
    ...overrides,
  };
}

function outgoing(...events: CallEvent[]): OutgoingCallState {
  return events.reduce(outgoingCallReducer, startOutgoingCall(FIXTURE_ORDER_ID));
}

function incoming(...events: CallEvent[]): IncomingCallState {
  return events.reduce(incomingCallReducer, startIncomingCall(fixtureCall('RINGING')));
}

const CONNECTED: CallEvent = { type: 'room-connected', at: FIXTURE_CONNECTED_AT };

/** One state per phase the screen draws. */
export const CALL_PHASES = {
  permissions: outgoing(),
  outgoing: outgoing(
    { type: 'permission-granted' },
    { type: 'invite-acked', call: fixtureCall('RINGING', { role: 'caller' }) },
  ),
  incoming: incoming(),
  connecting: incoming({ type: 'accept' }),
  active: incoming({ type: 'accept' }, CONNECTED, { type: 'remote-joined' }),
  reconnecting: incoming(
    { type: 'accept' },
    CONNECTED,
    { type: 'remote-joined' },
    { type: 'room-reconnecting' },
  ),
} satisfies Record<string, CallState>;

/** One ended call per end reason, each reached the way a real call reaches it. */
export const ENDED_CALLS: Record<CallEnd, CallState> = {
  completed: incoming({ type: 'accept' }, CONNECTED, { type: 'hangup' }),
  declined: incoming({ type: 'decline' }),
  no_answer: outgoing(
    { type: 'permission-granted' },
    { type: 'invite-acked', call: fixtureCall('RINGING', { role: 'caller' }) },
    { type: 'server-finished', call: fixtureCall('TIMED_OUT', { role: 'caller' }) },
  ),
  busy: outgoing(
    { type: 'permission-granted' },
    { type: 'invite-acked', call: fixtureCall('BUSY', { role: 'caller' }) },
  ),
  cancelled: outgoing({ type: 'cancel' }),
  permission_denied: outgoing({ type: 'permission-denied' }),
  connect_failed: incoming({ type: 'accept' }, { type: 'room-connect-failed' }),
  dropped: incoming({ type: 'accept' }, CONNECTED, { type: 'room-disconnected' }),
  error: outgoing(
    { type: 'permission-granted' },
    { type: 'invite-refused', code: 'CALL_UNAVAILABLE' },
  ),
};
