import type { CallEndReason, CallStatus } from '@tezusta/types';

/**
 * Who a given call edge belongs to.
 *
 * `caller` and `callee` are **roles on this call**, not kinds of account: a
 * customer is the caller of the call they placed and the callee of the one the
 * master placed. `system` is everything the server decides on nobody's
 * behalf — the ring timeout, and the order closing underneath a call.
 */
export type CallEdgeActor = 'caller' | 'callee' | 'system';

type CallTransitionTable = {
  readonly [From in CallStatus]: Readonly<Partial<Record<CallStatus, readonly CallEdgeActor[]>>>;
};

/**
 * **The call transition table. There is no second one** — the rule
 * `order-lifecycle.ts` states for orders, applied to calls (issue #185,
 * ADR-0034 § 4). `CallsService` asks {@link checkCallTransition} before every
 * write, and every write is a conditional `UPDATE … WHERE status = <from>` so
 * that the answer given here is still the true one when the row moves.
 *
 * `BUSY` has no incoming edge because it is never *reached*: an invite that
 * meets a busy line is **inserted** as `BUSY` and is terminal from birth. It
 * is in the table so that "nothing leaves `BUSY`" is a fact this file states
 * rather than an absence.
 */
const CALL_TRANSITIONS: CallTransitionTable = {
  RINGING: {
    /** The callee answers. The only edge that leads to a credential. */
    ACCEPTED: ['callee'],
    /** The callee declines. */
    REJECTED: ['callee'],
    /** The caller gives up before an answer. */
    CANCELLED: ['caller'],
    /** Nobody answered within `CALL_RING_TIMEOUT_SECONDS` — the delayed job. */
    TIMED_OUT: ['system'],
    /**
     * The order stopped being live while the phone rang. Neither party did
     * that to the *call*, so it is the system's edge — and it is `ENDED`,
     * not `CANCELLED`, because nobody cancelled anything, the same distinction
     * ADR-0015 draws between `NO_MASTER_FOUND` and `CANCELLED`.
     */
    ENDED: ['system'],
  },
  ACCEPTED: {
    /**
     * Either party hangs up, the order closes, or (#186) the room disappears
     * or the reaper finds it empty.
     */
    ENDED: ['caller', 'callee', 'system'],
  },
  REJECTED: {},
  CANCELLED: {},
  TIMED_OUT: {},
  BUSY: {},
  ENDED: {},
};

/** Every status, in the order ADR-0034 § 4 lists them. Derived, never restated. */
export const CALL_STATUSES = Object.keys(CALL_TRANSITIONS) as readonly CallStatus[];

/** The statuses nothing moves a call out of. */
export function isTerminalCallStatus(status: CallStatus): boolean {
  return Object.keys(CALL_TRANSITIONS[status]).length === 0;
}

/** A call is live — keeping both parties busy — exactly when it is not terminal. */
export function isLiveCallStatus(status: CallStatus): boolean {
  return !isTerminalCallStatus(status);
}

/**
 * Why an edge was refused, or that it was not.
 *
 * Returned rather than thrown, unlike `assertOrderTransition`: every caller of
 * this is a socket frame whose refusal goes back in an ack, and an exception
 * would have to be caught at every one of them and turned back into this.
 */
export type CallTransitionCheck = 'allowed' | 'invalid-edge' | 'not-permitted';

/** Whether `actor` may move a call from `from` to `to`. Reads nothing but the table. */
export function checkCallTransition(
  from: CallStatus,
  to: CallStatus,
  actor: CallEdgeActor,
): CallTransitionCheck {
  const permitted: readonly CallEdgeActor[] | undefined = CALL_TRANSITIONS[from][to];

  if (permitted === undefined) {
    return 'invalid-edge';
  }

  return permitted.includes(actor) ? 'allowed' : 'not-permitted';
}

/**
 * Which end reasons each terminal status may carry. `ENDED` is the only one
 * with a choice; every other status *is* its reason, and a table that said so
 * is what lets the repository refuse a mismatch before the database has to.
 */
const END_REASONS: Readonly<Record<CallStatus, readonly CallEndReason[]>> = {
  RINGING: [],
  ACCEPTED: [],
  REJECTED: ['declined'],
  CANCELLED: ['cancelled'],
  TIMED_OUT: ['no_answer'],
  BUSY: ['busy'],
  ENDED: ['hangup', 'order_closed', 'room_gone', 'reaped'],
};

/** Whether a call finishing as `status` may record `reason`. */
export function isEndReasonFor(status: CallStatus, reason: CallEndReason): boolean {
  return END_REASONS[status].includes(reason);
}

/**
 * The reason a terminal status carries when there is only one it could.
 * `undefined` for a live status and for `ENDED`, whose reason the caller must
 * name.
 */
export function impliedEndReason(status: CallStatus): CallEndReason | undefined {
  const reasons = END_REASONS[status];
  return reasons.length === 1 ? reasons[0] : undefined;
}
