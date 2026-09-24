import type { Call, CallRealtimeEventName } from '@tezusta/types';

import { CALL_EVENTS } from '../realtime/realtime-events';

import { signalForFrame } from './useCallSignalling';

const CALL: Call = {
  id: 'call-1',
  orderId: 'order-1',
  status: 'ENDED',
  endReason: 'hangup',
  role: 'callee',
  peer: { kind: 'customer', displayName: 'Aysel' },
  startedAt: '2026-09-24T10:00:00.000Z',
  answeredAt: '2026-09-24T10:00:05.000Z',
  endedAt: '2026-09-24T10:01:00.000Z',
};

function frame(name: CallRealtimeEventName, call: Call = CALL) {
  return { name, payload: { call, at: 1 } };
}

/** How each of the server's seven call frames reaches a reducer (issue #187). */
describe('translating call frames', () => {
  it('listens for every frame the server can send', () => {
    expect([...CALL_EVENTS].sort()).toEqual(
      [
        'call:accepted',
        'call:busy',
        'call:cancelled',
        'call:ended',
        'call:incoming',
        'call:rejected',
        'call:timeout',
      ].sort(),
    );
  });

  it('turns call:accepted into the server accepting this call', () => {
    expect(signalForFrame(frame('call:accepted'), 'call-1')).toEqual({
      type: 'server-accepted',
      callId: 'call-1',
    });
  });

  it.each(['call:rejected', 'call:cancelled', 'call:timeout', 'call:busy', 'call:ended'] as const)(
    'turns %s into the server finishing the call, carrying the call as it now is',
    (name) => {
      expect(signalForFrame(frame(name), 'call-1')).toEqual({
        type: 'server-finished',
        call: CALL,
      });
    },
  );

  it('does not treat a ring as news about a call already on screen', () => {
    expect(signalForFrame(frame('call:incoming'), 'call-1')).toBeNull();
  });

  it.each(CALL_EVENTS)('ignores %s about another call', (name) => {
    expect(signalForFrame(frame(name, { ...CALL, id: 'call-2' }), 'call-1')).toBeNull();
  });
});
