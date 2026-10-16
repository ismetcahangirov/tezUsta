import { useEffect, useRef } from 'react';

export interface BoundedRefreshOptions {
  /** Whether there is anything to wait for, and the screen is in front. */
  readonly enabled: boolean;
  readonly refetch: () => unknown;
  readonly intervalMs: number;
  /** How many re-reads one wait may make before it gives up. */
  readonly maxAttempts: number;
}

/**
 * Re-reads something the server is still working on, a bounded number of
 * times, while `enabled` (#314).
 *
 * **Not a `pollingInterval`.** RTK Query's interval runs for as long as a
 * subscriber exists, whether or not there is anything left to wait for; that
 * is the uncontrolled polling CLAUDE.md §12 forbids. This stops on the first
 * of three things: nothing is waiting any more, the screen is no longer in
 * front, or `maxAttempts` re-reads have gone by. A later wait, after
 * `enabled` has been false, starts a fresh count.
 */
export function useBoundedRefresh({
  enabled,
  refetch,
  intervalMs,
  maxAttempts,
}: BoundedRefreshOptions): void {
  const attempts = useRef(0);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    if (!enabled) {
      attempts.current = 0;
      return undefined;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      if (attempts.current >= maxAttempts) {
        return;
      }
      timer = setTimeout(() => {
        attempts.current += 1;
        refetchRef.current();
        schedule();
      }, intervalMs);
    };
    schedule();

    return () => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [enabled, intervalMs, maxAttempts]);
}
