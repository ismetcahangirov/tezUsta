import type { Call, CallEndReason, CallStatus } from '@tezusta/types';

import { endFromServerReason, endOfCall } from './call-end-reason';
import type { CallEnd } from './call-end-reason';

function call(status: CallStatus, endReason: CallEndReason | null, answered: boolean): Call {
  return {
    id: 'call-1',
    orderId: 'order-1',
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
 * What the person holding the phone is told for each thing the server can say
 * (issue #187). Every server reason is a row, answered and not, so a reason
 * added to the server's union without a decision here fails the type check in
 * `call-end-reason.ts` and a changed decision fails a row here.
 */
describe('the end of a call, in the app’s words', () => {
  const rows: readonly (readonly [CallEndReason, boolean, CallEnd])[] = [
    ['declined', false, 'declined'],
    ['cancelled', false, 'cancelled'],
    ['no_answer', false, 'no_answer'],
    ['busy', false, 'busy'],
    ['hangup', true, 'completed'],
    // The order closed while the call rang: the ring stops, as a cancel does.
    ['order_closed', false, 'cancelled'],
    // The order closed while the call was held: over, as a hangup is.
    ['order_closed', true, 'completed'],
    ['room_gone', true, 'dropped'],
    ['room_gone', false, 'dropped'],
    ['reaped', true, 'dropped'],
    ['reaped', false, 'dropped'],
  ];

  it.each(rows)('the server’s %s (answered: %s) is %s', (reason, answered, expected) => {
    expect(endFromServerReason(reason, answered)).toBe(expected);
  });

  it('covers every reason the server can give', () => {
    const covered = new Set(rows.map(([reason]) => reason));
    const all: readonly CallEndReason[] = [
      'declined',
      'cancelled',
      'no_answer',
      'busy',
      'hangup',
      'order_closed',
      'room_gone',
      'reaped',
    ];

    expect([...covered].sort()).toEqual([...all].sort());
  });

  it.each([
    ['REJECTED', 'declined', false, 'declined'],
    ['CANCELLED', 'cancelled', false, 'cancelled'],
    ['TIMED_OUT', 'no_answer', false, 'no_answer'],
    ['BUSY', 'busy', false, 'busy'],
    ['ENDED', 'hangup', true, 'completed'],
    ['ENDED', 'order_closed', false, 'cancelled'],
    ['ENDED', 'reaped', true, 'dropped'],
  ] as const)('a %s call ended by %s is %s', (status, reason, answered, expected) => {
    expect(endOfCall(call(status, reason, answered))).toBe(expected);
  });

  it('gives a live call no end at all', () => {
    expect(endOfCall(call('RINGING', null, false))).toBeNull();
    expect(endOfCall(call('ACCEPTED', null, true))).toBeNull();
  });

  it('reads an ended call that names no reason as completed, not as a failure', () => {
    expect(endOfCall(call('ENDED', null, true))).toBe('completed');
  });
});
