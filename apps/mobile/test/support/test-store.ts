import { api } from '../../src/api/api-slice';
import { createAppStore, type AppStore } from '../../src/store';
import { onTestEnd } from './disposables';

/**
 * A store for one test.
 *
 * A Redux store carrying RTK Query is not a value a test can drop on the
 * floor. Its middleware runs background work on the store's behalf: a request
 * in flight, a five-minute `keepUnusedDataFor` timer per cache entry whose last
 * subscriber has gone away, a polling schedule. In the app that is correct —
 * there is one store and it lives as long as the process. In a test the store
 * is thrown away after a few hundred milliseconds, and all of that outlives it,
 * still holding the Jest worker's event loop open and still dispatching into an
 * environment that is being torn down (issue #96).
 *
 * `api.util.resetApiState()` is RTK Query's own answer: it aborts every running
 * query and mutation, clears the cache-collection and polling timers, and
 * empties the cache. That is disposal, so a test store is created here rather
 * than by calling `createAppStore()` directly, and `test/setup-teardown.ts`
 * disposes of every one of them after each test.
 *
 * Use this anywhere in the test suite that needs a store.
 */
export function createTestStore(): AppStore {
  const store = createAppStore();
  onTestEnd(() => {
    store.dispatch(api.util.resetApiState());
  });
  return store;
}
