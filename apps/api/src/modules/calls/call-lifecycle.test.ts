import type { CallEndReason, CallStatus } from '@tezusta/types';
import { describe, expect, it } from 'vitest';

import { LIVE_CALL_STATUSES } from '../../infra/database/schema/calls';
import {
  CALL_STATUSES,
  checkCallTransition,
  impliedEndReason,
  isEndReasonFor,
  isLiveCallStatus,
  isTerminalCallStatus,
  type CallEdgeActor,
} from './call-lifecycle';

/**
 * The call edges, restated **from issue #185 and ADR-0034 § 4 rather than from
 * the implementation** — the reason `order-lifecycle.test.ts` transcribes
 * ADR-0015 by hand. Copying the table out of `call-lifecycle.ts` would only
 * prove the file equals itself.
 *
 * Each legal edge names exactly who may drive it; every pair **not** listed
 * here must be refused for every actor.
 */
const ISSUE_185_EDGES: Record<CallStatus, Partial<Record<CallStatus, readonly CallEdgeActor[]>>> = {
  RINGING: {
    ACCEPTED: ['callee'],
    REJECTED: ['callee'],
    CANCELLED: ['caller'],
    TIMED_OUT: ['system'],
    ENDED: ['system'],
  },
  ACCEPTED: { ENDED: ['caller', 'callee', 'system'] },
  REJECTED: {},
  CANCELLED: {},
  TIMED_OUT: {},
  BUSY: {},
  ENDED: {},
};

const ACTORS: readonly CallEdgeActor[] = ['caller', 'callee', 'system'];

describe('the call status set (issue #185)', () => {
  it('holds exactly the seven statuses the issue names', () => {
    expect([...CALL_STATUSES].sort()).toEqual(Object.keys(ISSUE_185_EDGES).sort());
    expect(CALL_STATUSES).toHaveLength(7);
  });

  it('calls RINGING and ACCEPTED live and everything else terminal', () => {
    for (const status of CALL_STATUSES) {
      const live = status === 'RINGING' || status === 'ACCEPTED';
      expect(isLiveCallStatus(status)).toBe(live);
      expect(isTerminalCallStatus(status)).toBe(!live);
    }
  });

  it('agrees with the live list the partial indexes are written against', () => {
    // `schema/calls.ts` has to spell the live set as literal SQL; this is what
    // stops the two drifting apart.
    expect([...LIVE_CALL_STATUSES].sort()).toEqual(CALL_STATUSES.filter(isLiveCallStatus).sort());
  });
});

describe('every call transition, including the invalid ones', () => {
  for (const from of Object.keys(ISSUE_185_EDGES) as CallStatus[]) {
    for (const to of Object.keys(ISSUE_185_EDGES) as CallStatus[]) {
      const permitted = ISSUE_185_EDGES[from][to];

      if (permitted === undefined) {
        it(`${from} → ${to} is not an edge, for anybody`, () => {
          for (const actor of ACTORS) {
            expect(checkCallTransition(from, to, actor)).toBe('invalid-edge');
          }
        });
        continue;
      }

      it(`${from} → ${to} belongs to ${permitted.join(', ')} and nobody else`, () => {
        for (const actor of ACTORS) {
          expect(checkCallTransition(from, to, actor)).toBe(
            permitted.includes(actor) ? 'allowed' : 'not-permitted',
          );
        }
      });
    }
  }

  it('lets no call leave BUSY — it is terminal from the moment it is inserted', () => {
    for (const to of CALL_STATUSES) {
      for (const actor of ACTORS) {
        expect(checkCallTransition('BUSY', to, actor)).toBe('invalid-edge');
      }
    }
  });

  it('gives no edge back into RINGING, so a finished call can never ring again', () => {
    for (const from of CALL_STATUSES) {
      for (const actor of ACTORS) {
        expect(checkCallTransition(from, 'RINGING', actor)).toBe('invalid-edge');
      }
    }
  });
});

describe('end reasons', () => {
  const ALL_REASONS: readonly CallEndReason[] = [
    'declined',
    'cancelled',
    'no_answer',
    'busy',
    'hangup',
    'order_closed',
    'room_gone',
    'reaped',
  ];

  const EXPECTED: Record<CallStatus, readonly CallEndReason[]> = {
    RINGING: [],
    ACCEPTED: [],
    REJECTED: ['declined'],
    CANCELLED: ['cancelled'],
    TIMED_OUT: ['no_answer'],
    BUSY: ['busy'],
    ENDED: ['hangup', 'order_closed', 'room_gone', 'reaped'],
  };

  it('pairs each terminal status with exactly its own reasons, and a live one with none', () => {
    for (const status of CALL_STATUSES) {
      for (const reason of ALL_REASONS) {
        expect(isEndReasonFor(status, reason)).toBe(EXPECTED[status].includes(reason));
      }
    }
  });

  it('implies the reason where there is only one, and makes ENDED name its own', () => {
    expect(impliedEndReason('REJECTED')).toBe('declined');
    expect(impliedEndReason('CANCELLED')).toBe('cancelled');
    expect(impliedEndReason('TIMED_OUT')).toBe('no_answer');
    expect(impliedEndReason('BUSY')).toBe('busy');
    expect(impliedEndReason('ENDED')).toBeUndefined();
    expect(impliedEndReason('RINGING')).toBeUndefined();
    expect(impliedEndReason('ACCEPTED')).toBeUndefined();
  });
});
