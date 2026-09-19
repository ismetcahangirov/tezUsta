/**
 * Knows which timers are still outstanding, and can clear them.
 *
 * Jest tears the test environment down as soon as a file's last test finishes.
 * A timer still scheduled at that moment does not disappear with it — it fires
 * into the wreckage, and React Native's own Jest setup turns that into
 *
 * ```
 * ReferenceError: You are trying to access a property or method of the Jest
 * environment after it has been torn down.
 *   at Timeout._onTimeout (@react-native/jest-preset/jest/setup.js:61:45)
 * ```
 *
 * because its `requestAnimationFrame` is `setTimeout(() => callback(jest.now()), 0)`
 * and `jest.now()` is gone. A long one — RTK Query's five-minute cache
 * collection, say — does worse: it holds the worker's event loop open until
 * Jest gives up and force-exits it, which is the
 * `A worker process has failed to exit gracefully` line.
 *
 * Neither is a failure on its own, which is what makes them expensive: the
 * leaked work accumulates across a file and eventually pushes some unrelated
 * `waitFor` past its deadline, on whichever pull request happens to be running
 * on a contended CI worker (issue #96).
 *
 * The real fix for a leak is to stop making it — {@link disposeTestStores}
 * does that for the api slice, which is where all the long ones come from.
 * This module is the backstop for the short ones that no owner can cancel:
 * RTK Query's 500 ms subscription-sync timer, its batched store notification,
 * and the backoff a retry is sleeping through when the test that asked for it
 * ended. They have no handle to clear and no API that cancels them, so the
 * teardown clears them by handle instead.
 *
 * Only timers this module saw are tracked. Jest's own test-timeout timers are
 * taken from `globalThis` when `jest-circus` loads, which is before any setup
 * file runs, so they are never in this map and are never cleared — a test that
 * hangs still fails on its timeout.
 */

/** What `setTimeout` hands back: a number on some platforms, an object on Node. */
type TimerHandle = ReturnType<typeof setTimeout>;

export interface OutstandingTimer {
  readonly kind: 'timeout' | 'interval';
  /** The delay it was scheduled with, in milliseconds. */
  readonly delayMs: number;
}

const outstanding = new Map<TimerHandle, OutstandingTimer>();

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;

let tracking = false;

/**
 * Replaces the global timer functions with ones that remember what they
 * scheduled. Idempotent: calling it twice does not wrap the wrapper.
 */
export function trackTimers(): void {
  if (tracking) {
    return;
  }
  tracking = true;

  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>): TimerHandle => {
    const [callback, delayMs, ...rest] = args;
    // The handle is only known after the call, and the callback that needs it
    // has to exist before it — hence the box.
    const scheduled: { handle?: TimerHandle } = {};
    // A one-shot timer is gone once it has fired, so it stops being
    // outstanding then rather than when somebody clears it.
    const forget = (...callbackArgs: unknown[]): void => {
      if (scheduled.handle !== undefined) {
        outstanding.delete(scheduled.handle);
      }
      (callback as (...forwarded: unknown[]) => void)(...callbackArgs);
    };
    scheduled.handle = realSetTimeout(forget as typeof callback, delayMs, ...rest);
    outstanding.set(scheduled.handle, { kind: 'timeout', delayMs: delayMs ?? 0 });
    return scheduled.handle;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = ((handle: TimerHandle): void => {
    outstanding.delete(handle);
    realClearTimeout(handle);
  }) as typeof globalThis.clearTimeout;

  globalThis.setInterval = ((...args: Parameters<typeof setInterval>): TimerHandle => {
    const handle = realSetInterval(...args);
    outstanding.set(handle, { kind: 'interval', delayMs: args[1] ?? 0 });
    return handle;
  }) as typeof globalThis.setInterval;

  globalThis.clearInterval = ((handle: TimerHandle): void => {
    outstanding.delete(handle);
    realClearInterval(handle);
  }) as typeof globalThis.clearInterval;
}

/** Every timer scheduled since tracking began that has not fired or been cleared. */
export function outstandingTimers(): readonly OutstandingTimer[] {
  return [...outstanding.values()];
}

/**
 * Clears everything still outstanding, and reports how many there were so a
 * caller can assert on it.
 */
export function clearOutstandingTimers(): number {
  const handles = [...outstanding.keys()];
  for (const handle of handles) {
    const timer = outstanding.get(handle);
    outstanding.delete(handle);
    if (timer?.kind === 'interval') {
      realClearInterval(handle);
    } else {
      realClearTimeout(handle);
    }
  }
  return handles.length;
}
