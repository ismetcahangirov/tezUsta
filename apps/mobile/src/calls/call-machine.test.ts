import type { Call, CallEndReason, CallStatus } from '@tezusta/types';

import type { CallEnd } from './call-end-reason';
import {
  incomingCallReducer,
  outgoingCallReducer,
  startIncomingCall,
  startOutgoingCall,
} from './call-machine';
import type {
  CallEvent,
  CallState,
  ConnectingCallState,
  EndedCallState,
  HeldCallState,
  IncomingCallState,
  OutgoingCallState,
  PeerPresence,
} from './call-machine';

const ORDER_ID = 'order-1';
const CALL_ID = 'call-1';
const OTHER_CALL_ID = 'call-2';
const CONNECTED_AT = 1_000;
const ROOM_CONNECTED_AT = 5_000;

function call(status: CallStatus, endReason: CallEndReason | null = null, id = CALL_ID): Call {
  const answered = status === 'ACCEPTED' || endReason === 'hangup';
  return {
    id,
    orderId: ORDER_ID,
    status,
    endReason,
    role: 'caller',
    peer: { kind: 'master', displayName: 'Elvin' },
    startedAt: '2026-09-24T10:00:00.000Z',
    answeredAt: answered ? '2026-09-24T10:00:05.000Z' : null,
    endedAt: status === 'RINGING' || status === 'ACCEPTED' ? null : '2026-09-24T10:01:00.000Z',
  };
}

/**
 * Every event either machine can receive, each about **this** call. The table
 * below says which of them move which phase; every pair it does not name must
 * return the very same state.
 */
const EVENTS = {
  'invite acked, ringing': { type: 'invite-acked', call: call('RINGING') },
  'invite acked, busy': { type: 'invite-acked', call: call('BUSY', 'busy') },
  'invite refused': { type: 'invite-refused', code: 'CALL_RATE_LIMITED' },
  'accept refused, forbidden': {
    type: 'accept-refused',
    callId: CALL_ID,
    code: 'CALL_FORBIDDEN',
    call: null,
  },
  'accept refused, accepted without a credential': {
    type: 'accept-refused',
    callId: CALL_ID,
    code: 'CALL_UNAVAILABLE',
    call: call('ACCEPTED'),
  },
  'accept refused, already cancelled': {
    type: 'accept-refused',
    callId: CALL_ID,
    code: 'CALL_STALE',
    call: call('CANCELLED', 'cancelled'),
  },
  'accept refused, answered on another phone': {
    type: 'accept-refused',
    callId: CALL_ID,
    code: 'CALL_STALE',
    call: call('ACCEPTED'),
  },
  'call:accepted': { type: 'server-accepted', callId: CALL_ID },
  'call:rejected': { type: 'server-finished', call: call('REJECTED', 'declined') },
  'call:cancelled': { type: 'server-finished', call: call('CANCELLED', 'cancelled') },
  'call:timeout': { type: 'server-finished', call: call('TIMED_OUT', 'no_answer') },
  'call:busy': { type: 'server-finished', call: call('BUSY', 'busy') },
  'call:ended, hangup': { type: 'server-finished', call: call('ENDED', 'hangup') },
  'call:ended, room gone': { type: 'server-finished', call: call('ENDED', 'room_gone') },
  'a finish frame for a live call': { type: 'server-finished', call: call('ACCEPTED') },
  'permission granted': { type: 'permission-granted' },
  'permission denied': { type: 'permission-denied' },
  accept: { type: 'accept' },
  decline: { type: 'decline' },
  cancel: { type: 'cancel' },
  hangup: { type: 'hangup' },
  'room connected': { type: 'room-connected', at: ROOM_CONNECTED_AT },
  'room reconnecting': { type: 'room-reconnecting' },
  'room reconnected': { type: 'room-reconnected' },
  'room disconnected (terminal)': { type: 'room-disconnected' },
  'room connect failed': { type: 'room-connect-failed' },
  'remote joined': { type: 'remote-joined' },
  'remote left': { type: 'remote-left' },
  'remote gone after grace': { type: 'remote-gone-after-grace' },
} satisfies Record<string, CallEvent>;

type EventName = keyof typeof EVENTS;
const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

function held(phase: 'active' | 'reconnecting', peer: PeerPresence): HeldCallState {
  return { phase, orderId: ORDER_ID, callId: CALL_ID, connectedAt: CONNECTED_AT, peer };
}

const CONNECTING = { phase: 'connecting', orderId: ORDER_ID, callId: CALL_ID } as const;

const ENDED: EndedCallState = {
  phase: 'ended',
  orderId: ORDER_ID,
  callId: CALL_ID,
  endReason: 'completed',
  endedFrom: 'active',
  connectedAt: CONNECTED_AT,
  serverKnows: false,
};

function ended(
  from: Exclude<CallState, EndedCallState>,
  endReason: CallEnd,
  serverKnows: boolean,
  callId: string | null = from.callId,
): EndedCallState {
  return {
    phase: 'ended',
    orderId: ORDER_ID,
    callId,
    endReason,
    endedFrom: from.phase,
    connectedAt: from.phase === 'active' || from.phase === 'reconnecting' ? from.connectedAt : null,
    serverKnows,
  };
}

type Expectations<State> = Partial<Record<EventName, State>>;

/** The phases both machines share, from the answer on. */
type AfterAnswerState = ConnectingCallState | HeldCallState | EndedCallState;

/** The server's five finishing frames, which end any live, named call in its own words. */
function finishedByServer(from: Exclude<CallState, EndedCallState>): Expectations<CallState> {
  return {
    'call:rejected': ended(from, 'declined', true),
    'call:cancelled': ended(from, 'cancelled', true),
    'call:timeout': ended(from, 'no_answer', true),
    'call:busy': ended(from, 'busy', true),
    'call:ended, hangup': ended(from, 'completed', true),
    'call:ended, room gone': ended(from, 'dropped', true),
  };
}

/** What every answered call does, whichever way it was placed. */
function afterAnswer(): readonly (readonly [string, AfterAnswerState, Expectations<CallState>])[] {
  const activeAwaiting = held('active', 'awaiting');
  const activePresent = held('active', 'present');
  const activeAway = held('active', 'away');
  const reconnectingPresent = held('reconnecting', 'present');
  const reconnectingAway = held('reconnecting', 'away');
  const reconnectingAwaiting = held('reconnecting', 'awaiting');

  const inRoom = (from: HeldCallState): Expectations<CallState> => ({
    ...finishedByServer(from),
    hangup: ended(from, 'completed', false),
    'room disconnected (terminal)': ended(from, 'dropped', false),
  });

  return [
    [
      'connecting',
      CONNECTING,
      {
        ...finishedByServer(CONNECTING),
        hangup: ended(CONNECTING, 'completed', false),
        'room connected': { ...held('active', 'awaiting'), connectedAt: ROOM_CONNECTED_AT },
        'room connect failed': ended(CONNECTING, 'connect_failed', false),
        'room disconnected (terminal)': ended(CONNECTING, 'connect_failed', false),
      },
    ],
    [
      'active, peer not yet in',
      activeAwaiting,
      {
        ...inRoom(activeAwaiting),
        'room reconnecting': reconnectingAwaiting,
        'remote joined': activePresent,
      },
    ],
    [
      'active, peer present',
      activePresent,
      {
        ...inRoom(activePresent),
        'room reconnecting': reconnectingPresent,
        'remote left': activeAway,
      },
    ],
    [
      'active, peer away',
      activeAway,
      {
        ...inRoom(activeAway),
        'room reconnecting': reconnectingAway,
        'remote joined': activePresent,
        'remote gone after grace': ended(activeAway, 'dropped', false),
      },
    ],
    [
      'reconnecting, peer present',
      reconnectingPresent,
      {
        ...inRoom(reconnectingPresent),
        'room reconnected': activePresent,
        'remote left': reconnectingAway,
      },
    ],
    [
      'reconnecting, peer away',
      reconnectingAway,
      {
        ...inRoom(reconnectingAway),
        'room reconnected': activeAway,
        'remote joined': reconnectingPresent,
      },
    ],
    ['ended', ENDED, {}],
  ];
}

const OUTGOING_PENDING = { phase: 'outgoing', orderId: ORDER_ID, callId: null } as const;
const OUTGOING_RINGING = { phase: 'outgoing', orderId: ORDER_ID, callId: CALL_ID } as const;
const PERMISSIONS = startOutgoingCall(ORDER_ID);
const INCOMING = startIncomingCall(call('RINGING'));

const OUTGOING_TABLE: readonly (readonly [string, OutgoingCallState, Expectations<CallState>])[] = [
  [
    'permissions',
    PERMISSIONS,
    {
      'permission granted': OUTGOING_PENDING,
      'permission denied': ended(PERMISSIONS, 'permission_denied', true),
      cancel: ended(PERMISSIONS, 'cancelled', true),
    },
  ],
  [
    'outgoing, invite unanswered',
    OUTGOING_PENDING,
    {
      'invite acked, ringing': OUTGOING_RINGING,
      'invite acked, busy': ended(OUTGOING_PENDING, 'busy', true, CALL_ID),
      'invite refused': ended(OUTGOING_PENDING, 'error', true),
      cancel: ended(OUTGOING_PENDING, 'cancelled', false),
    },
  ],
  [
    'outgoing, ringing',
    OUTGOING_RINGING,
    {
      ...finishedByServer(OUTGOING_RINGING),
      'call:accepted': CONNECTING,
      cancel: ended(OUTGOING_RINGING, 'cancelled', false),
    },
  ],
  ...afterAnswer(),
];

const INCOMING_TABLE: readonly (readonly [string, IncomingCallState, Expectations<CallState>])[] = [
  [
    'incoming',
    INCOMING,
    {
      ...finishedByServer(INCOMING),
      accept: CONNECTING,
      decline: ended(INCOMING, 'declined', false),
      'permission denied': ended(INCOMING, 'permission_denied', false),
      'call:accepted': ended(INCOMING, 'completed', true),
    },
  ],
  ...afterAnswer().map(
    ([name, state, expected]) =>
      [
        name,
        state,
        name === 'connecting'
          ? {
              ...expected,
              'accept refused, forbidden': ended(CONNECTING, 'error', true),
              'accept refused, already cancelled': ended(CONNECTING, 'cancelled', true),
              'accept refused, answered on another phone': ended(CONNECTING, 'completed', true),
            }
          : expected,
      ] as const,
  ),
];

/**
 * Every phase × every event, both machines (issue #187 § Acceptance
 * criteria): a legal transition lands exactly where the table says, and
 * everything else is a no-op that returns **the same reference** — which is
 * what makes a late or duplicated frame harmless rather than merely
 * usually-harmless.
 */
function exhaustively<State extends CallState>(
  machine: string,
  reducer: (state: State, event: CallEvent) => State,
  table: readonly (readonly [string, State, Expectations<CallState>])[],
): void {
  describe(machine, () => {
    describe.each(table)('in %s', (_phase, state, expected) => {
      it.each(EVENT_NAMES)('on %s', (name) => {
        const next = reducer(state, EVENTS[name]);
        const target = expected[name];

        if (target === undefined) {
          expect(next).toBe(state);
        } else {
          expect(next).not.toBe(state);
          expect(next).toEqual(target);
        }
      });

      it('ignores every frame and ack about another call', () => {
        const elsewhere: readonly CallEvent[] = [
          { type: 'server-accepted', callId: OTHER_CALL_ID },
          { type: 'server-finished', call: call('ENDED', 'hangup', OTHER_CALL_ID) },
          { type: 'server-finished', call: call('REJECTED', 'declined', OTHER_CALL_ID) },
          { type: 'accept-refused', callId: OTHER_CALL_ID, code: 'CALL_FORBIDDEN', call: null },
        ];

        for (const event of elsewhere) {
          expect(reducer(state, event)).toBe(state);
        }
      });
    });
  });
}

exhaustively('the outgoing call', outgoingCallReducer, OUTGOING_TABLE);
exhaustively('the incoming call', incomingCallReducer, INCOMING_TABLE);

describe('late, duplicated and out-of-order', () => {
  function run<State extends CallState>(
    reducer: (state: State, event: CallEvent) => State,
    state: State,
    events: readonly CallEvent[],
  ): State {
    return events.reduce(reducer, state);
  }

  it('a duplicated call:accepted changes nothing', () => {
    const answered = outgoingCallReducer(OUTGOING_RINGING, EVENTS['call:accepted']);

    expect(answered.phase).toBe('connecting');
    expect(outgoingCallReducer(answered, EVENTS['call:accepted'])).toBe(answered);
  });

  it('this phone’s own call:accepted, coming back after it answered, changes nothing', () => {
    const answering = incomingCallReducer(INCOMING, EVENTS.accept);

    expect(incomingCallReducer(answering, EVENTS['call:accepted'])).toBe(answering);
  });

  it('call:ended ends a held call with no room event at all', () => {
    const next = outgoingCallReducer(held('active', 'present'), EVENTS['call:ended, hangup']);

    expect(next).toMatchObject({ phase: 'ended', endReason: 'completed', serverKnows: true });
  });

  it('a transient disconnect followed by a reconnect leaves the call active', () => {
    const start = held('active', 'present');
    const next = run(outgoingCallReducer, start as OutgoingCallState, [
      EVENTS['room reconnecting'],
      EVENTS['room reconnecting'],
      EVENTS['room reconnected'],
    ]);

    expect(next).toEqual(start);
  });

  it('only the terminal disconnect ends a reconnecting call, as dropped', () => {
    const next = run(incomingCallReducer, held('active', 'present') as IncomingCallState, [
      EVENTS['room reconnecting'],
      EVENTS['room disconnected (terminal)'],
    ]);

    expect(next).toMatchObject({ phase: 'ended', endReason: 'dropped', serverKnows: false });
  });

  it('a remote leaving and rejoining within the grace leaves the call active', () => {
    const start = held('active', 'present');
    const next = run(incomingCallReducer, start as IncomingCallState, [
      EVENTS['remote left'],
      EVENTS['remote joined'],
      // The grace timer fired late, after the rejoin: nothing to end.
      EVENTS['remote gone after grace'],
    ]);

    expect(next).toEqual(start);
  });

  it('an accept that arrives after the call finished does not revive it', () => {
    const next = run(outgoingCallReducer, OUTGOING_RINGING as OutgoingCallState, [
      EVENTS['call:timeout'],
      EVENTS['call:accepted'],
      EVENTS['room connected'],
    ]);

    expect(next).toMatchObject({ phase: 'ended', endReason: 'no_answer' });
  });

  it('an invite ack that arrives after the caller cancelled is not heard', () => {
    const cancelled = outgoingCallReducer(OUTGOING_PENDING, EVENTS.cancel);

    expect(outgoingCallReducer(cancelled, EVENTS['invite acked, ringing'])).toBe(cancelled);
  });

  it('a second invite ack does not rename the call', () => {
    const ringing = outgoingCallReducer(OUTGOING_PENDING, EVENTS['invite acked, ringing']);
    const another: CallEvent = { type: 'invite-acked', call: call('RINGING', null, OTHER_CALL_ID) };

    expect(outgoingCallReducer(ringing, another)).toBe(ringing);
  });

  it('an invite ack for another order is not this call', () => {
    const stranger: CallEvent = {
      type: 'invite-acked',
      call: { ...call('RINGING', null, OTHER_CALL_ID), orderId: 'order-2' },
    };

    expect(outgoingCallReducer(OUTGOING_PENDING, stranger)).toBe(OUTGOING_PENDING);
  });

  it('keeps the call’s start time across a reconnection and into its end', () => {
    const next = run(outgoingCallReducer, CONNECTING as OutgoingCallState, [
      EVENTS['room connected'],
      EVENTS['room reconnecting'],
      EVENTS['room reconnected'],
      EVENTS.hangup,
    ]);

    expect(next).toMatchObject({
      phase: 'ended',
      endReason: 'completed',
      connectedAt: ROOM_CONNECTED_AT,
    });
  });
});
