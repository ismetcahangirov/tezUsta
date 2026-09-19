/**
 * What every mobile test does when it ends, in one place.
 *
 * Named in `jest.config.js` under `setupFilesAfterEnv`, so it runs once per
 * test file, after the test framework exists and before the test file is
 * loaded.
 *
 * The order of the three steps below is the whole point:
 *
 *  1. **Unmount** — React Native Testing Library's own auto-cleanup. Importing
 *     it here rather than leaving it to the test file is load-bearing: the
 *     import is what registers its `afterEach`, Jest runs root-level
 *     `afterEach` hooks in the order they were registered, and a teardown that
 *     disposes of a store while its Provider is still mounted would tear the
 *     ground out from under a live component tree. Registering it first puts
 *     the unmount before everything below. Every hook's own cleanup —
 *     `useAvailabilityHeartbeat` clearing its interval, for one — runs here.
 *  2. **Dispose** — run everything the test registered for disposal, which
 *     today means handing every store it made back to RTK Query: that aborts
 *     what is in flight and cancels the cache-collection timers the unmount
 *     just scheduled (`test/support/test-store.ts`).
 *  3. **Clear what is left** — the short-lived timers nobody owns a handle to:
 *     RTK Query's batched store notification and its 500 ms subscription-sync
 *     timer, and the backoff an abandoned retry is sleeping through
 *     (`test/support/pending-timers.ts`).
 *
 * Together they make one promise: nothing a test scheduled is still scheduled
 * when the test is over. It is the suite-wide version of the rule, so a new
 * test file gets it without doing anything, and it is why `pnpm --filter mobile
 * test` no longer reports torn-down environments or force-exited workers
 * (issue #96).
 *
 * Nothing under `src/` may be imported from here. This file is evaluated
 * before the test file, so anything it loads is in the module registry before
 * the test file's `jest.mock(...)` factories are — see
 * `test/support/disposables.ts`.
 */
import '@testing-library/react-native';

import { runTestEndDisposals } from './support/disposables';
import { clearOutstandingTimers, trackTimers } from './support/pending-timers';

trackTimers();

afterEach(() => {
  runTestEndDisposals();
  clearOutstandingTimers();
});
