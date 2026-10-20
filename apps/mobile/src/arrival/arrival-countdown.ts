/**
 * The arrival countdown's arithmetic, pure (issue #399,
 * [ADR-0055](../../../../docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)
 * § 12–13).
 *
 * **Everything is measured from a monotonic anchor**, never from the phone's
 * wall clock. The server says how many seconds were left when it answered;
 * the phone adds that to its monotonic clock on receipt and counts down to the
 * result. A phone whose clock is five minutes wrong therefore counts the same
 * as one whose clock is right. The wall clock is used for one thing only:
 * printing the promised time of day.
 */

/** When the promise falls due, on this phone's monotonic clock (`performance.now()`). */
export interface ArrivalAnchor {
  readonly deadlineMono: number;
}

export type ArrivalCountdownState =
  | { readonly state: 'pending' }
  | {
      readonly state: 'counting';
      /** Whole minutes left, rounded up; `null` under one minute. */
      readonly minutesLeft: number | null;
      readonly secondsLeft: number;
    }
  | {
      readonly state: 'late';
      /** Whole minutes late, rounded up, so the first late second reads "1". */
      readonly lateByMinutes: number;
    };

/** The anchor for a promise received now: monotonic now + what the server said was left. */
export function anchorFor(secondsRemaining: number, receivedMono: number): ArrivalAnchor {
  return { deadlineMono: receivedMono + secondsRemaining * 1000 };
}

/**
 * Where the countdown stands at `nowMono`.
 *
 * Rounding (ADR-0055 § 12): minutes left are rounded **up**, and under one
 * minute the number gives way to a sentence — a countdown that read "0 min"
 * while not yet late would contradict itself. Late minutes are rounded up too.
 */
export function countdownAt(anchor: ArrivalAnchor | null, nowMono: number): ArrivalCountdownState {
  if (anchor === null) {
    return { state: 'pending' };
  }

  const leftMs = anchor.deadlineMono - nowMono;
  if (leftMs <= 0) {
    return { state: 'late', lateByMinutes: Math.max(1, Math.ceil(-leftMs / 60_000)) };
  }

  const secondsLeft = Math.ceil(leftMs / 1000);
  return {
    state: 'counting',
    minutesLeft: secondsLeft < 60 ? null : Math.ceil(secondsLeft / 60),
    secondsLeft,
  };
}
