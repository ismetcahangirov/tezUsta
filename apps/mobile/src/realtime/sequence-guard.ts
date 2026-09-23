/**
 * Discards an event that is older than one already applied to the same
 * subject.
 *
 * **Out-of-order arrival is normal under reconnection**, not exceptional
 * (`realtime-architecture.md` § Event payloads): a client that reconnects can
 * receive a frame published before the gap after one published during it, and
 * applying them in arrival order would move the screen backwards — an order
 * that reads `MASTER_ARRIVED` flicking back to `MASTER_ON_THE_WAY`.
 *
 * **Strictly older is discarded; a tie is kept.** `at` is a millisecond
 * timestamp rather than a per-order sequence
 * (`packages/types/src/realtime-event.ts` says why, and what that costs), so
 * two events genuinely can share one. Dropping the second would lose a real
 * transition to save nothing; applying it costs a redundant write.
 *
 * **Per subject, not per connection.** The subject is the order — two orders
 * have unrelated clocks, and one racing ahead must not silence the other.
 */
export interface SequenceGuard {
  /** True when this event is the newest seen for `subject`, and records it. */
  admit(subject: string, at: number): boolean;
  /** Forgets everything. Called when the session ends. */
  reset(): void;
}

export function createSequenceGuard(): SequenceGuard {
  const newest = new Map<string, number>();

  return {
    admit(subject, at) {
      const seen = newest.get(subject);

      if (seen !== undefined && at < seen) {
        return false;
      }

      newest.set(subject, at);
      return true;
    },

    reset() {
      newest.clear();
    },
  };
}
