import type { Call, CallEndReason } from '@tezusta/types';

/**
 * Why a call is over, **in the app's words** (issue #187).
 *
 * The server has its own closed set (`CallEndReason`, `packages/types`), and
 * this is deliberately a different one: the server records what happened to
 * the row, the app says what happened to the person holding the phone. Four
 * of these the server can never say, because they happen on the device — a
 * refused microphone, a room that would not connect, a room that went away
 * under the call, a request that failed.
 *
 * - `completed` — the call was answered and is over the ordinary way.
 * - `declined` — the callee said no.
 * - `no_answer` — nobody answered before the server's ring timeout.
 * - `busy` — one of the two was already on a call; it never rang.
 * - `cancelled` — the caller gave up while it rang.
 * - `permission_denied` — the microphone was refused on this phone.
 * - `connect_failed` — answered, but this phone never got into the room.
 * - `dropped` — the call was held and the connection to it was lost.
 * - `error` — a request this phone made was refused or went unanswered.
 */
export type CallEnd =
  | 'completed'
  | 'declined'
  | 'no_answer'
  | 'busy'
  | 'cancelled'
  | 'permission_denied'
  | 'connect_failed'
  | 'dropped'
  | 'error';

/**
 * The app's reason for a reason the server gave.
 *
 * `answered` is whether the call had been answered before it ended — the
 * server's `answeredAt` — and only `order_closed` reads it. An order that
 * closes takes its call with it whether it was ringing or held (ADR-0034 § 6),
 * and those are different things to the person holding the phone: a held call
 * that ends is over the way a hangup is, and a ringing one stops the way a
 * cancelled ring does. Neither is `dropped`, which says the connection failed
 * when nothing did.
 *
 * `room_gone` and `reaped` are both `dropped`: the media server reported the
 * room finished, or the sweep found nobody in it (#186). Either way the call
 * did not end because somebody chose to end it.
 */
export function endFromServerReason(reason: CallEndReason, answered: boolean): CallEnd {
  switch (reason) {
    case 'declined':
      return 'declined';
    case 'cancelled':
      return 'cancelled';
    case 'no_answer':
      return 'no_answer';
    case 'busy':
      return 'busy';
    case 'hangup':
      return 'completed';
    case 'order_closed':
      return answered ? 'completed' : 'cancelled';
    case 'room_gone':
    case 'reaped':
      return 'dropped';
  }
}

/**
 * The app's reason for a finished call as the server presents it, or `null`
 * for a call that is still live and so has no reason yet.
 *
 * Read from the status first and the reason second: every status but `ENDED`
 * implies exactly one reason, and the status is the part of the frame a
 * reducer switches on. An `ENDED` call with no reason breaks the contract; it
 * reads as `completed` rather than as a failure nobody observed.
 */
export function endOfCall(call: Call): CallEnd | null {
  switch (call.status) {
    case 'RINGING':
    case 'ACCEPTED':
      return null;
    case 'REJECTED':
      return 'declined';
    case 'CANCELLED':
      return 'cancelled';
    case 'TIMED_OUT':
      return 'no_answer';
    case 'BUSY':
      return 'busy';
    case 'ENDED':
      return call.endReason === null
        ? 'completed'
        : endFromServerReason(call.endReason, call.answeredAt !== null);
  }
}
