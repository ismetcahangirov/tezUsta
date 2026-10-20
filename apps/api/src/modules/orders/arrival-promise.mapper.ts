import type { ArrivalPromise } from '@tezusta/types';

import type { OrderRow } from '../../infra/database/schema/orders';

/**
 * The wire form of an order's arrival promise, with the time left measured by
 * **this server's** clock at the moment it answers (ADR-0055 § 13). The phone
 * anchors that number to its monotonic clock; it never subtracts its own wall
 * clock from `promisedAt`. Negative once the promise has passed.
 *
 * Whole seconds, rounded towards the promise: the countdown's own rounding is
 * the client's.
 */
export function toArrivalPromise(
  row: Pick<OrderRow, 'promisedArrivalAt' | 'arrivalPromiseSource'>,
  now: Date = new Date(),
): ArrivalPromise | null {
  if (row.promisedArrivalAt === null || row.arrivalPromiseSource === null) {
    return null;
  }

  return {
    promisedAt: row.promisedArrivalAt.toISOString(),
    secondsRemaining: Math.floor((row.promisedArrivalAt.getTime() - now.getTime()) / 1000),
    source: row.arrivalPromiseSource,
  };
}

/**
 * How the **current** assignment kept its promise, for the admin
 * (ADR-0055 § 11): when the master arrived, and by how many seconds after the
 * promise (negative for early).
 *
 * The arrival is the first `MASTER_ARRIVED` at or after the current
 * `accepted_at`, so an earlier master's arrival before a re-dispatch never
 * counts against the master on the order now. Derived, not stored: the trail
 * is append-only, and a stored copy could only disagree with it.
 */
export function arrivalOutcome(
  history: readonly { readonly toStatus: string; readonly createdAt: Date }[],
  acceptedAt: Date | null,
  promisedArrivalAt: Date | null,
): { arrivedAt: Date | null; lateBySeconds: number | null } {
  if (acceptedAt === null) {
    return { arrivedAt: null, lateBySeconds: null };
  }

  const arrival = history
    .filter(
      (entry) =>
        entry.toStatus === 'MASTER_ARRIVED' && entry.createdAt.getTime() >= acceptedAt.getTime(),
    )
    .reduce<Date | null>(
      (earliest, entry) =>
        earliest === null || entry.createdAt.getTime() < earliest.getTime()
          ? entry.createdAt
          : earliest,
      null,
    );

  return {
    arrivedAt: arrival,
    lateBySeconds:
      arrival === null || promisedArrivalAt === null
        ? null
        : Math.round((arrival.getTime() - promisedArrivalAt.getTime()) / 1000),
  };
}
