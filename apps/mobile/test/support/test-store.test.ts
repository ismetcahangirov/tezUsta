import { api } from '../../src/api/api-slice';
import { runTestEndDisposals } from './disposables';
import { clearOutstandingTimers, outstandingTimers } from './pending-timers';
import { createTestStore } from './test-store';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

/**
 * `keepUnusedDataFor` on the api slice, in milliseconds. This is the number
 * RTK Query schedules the cache entry's removal with when the last subscriber
 * goes away, and finding a timer with exactly this delay still outstanding is
 * how a leak is recognised.
 */
const CACHE_COLLECTION_MS = 300_000;

/** A real endpoint on the real api slice; only `fetch` is faked. */
const probeApi = api.injectEndpoints({
  endpoints: (build) => ({
    probe: build.query<{ ok: true }, void>({ query: () => '/probe' }),
  }),
});

function answerEveryRequest(): void {
  global.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
}

function neverAnswer(): void {
  global.fetch = () => new Promise<Response>(() => undefined);
}

function hasCacheCollectionTimer(): boolean {
  return outstandingTimers().some((timer) => timer.delayMs === CACHE_COLLECTION_MS);
}

describe('disposing a test store', () => {
  /**
   * **The leak issue #96 is about.** An unmount is an unsubscribe, and RTK
   * Query answers an unsubscribe by scheduling the cache entry's removal
   * `keepUnusedDataFor` seconds later — five minutes here. Nothing else ever
   * cancels it, so it holds the Jest worker's event loop open long after the
   * test is over, and Jest force-exits the worker instead of the suite ending
   * cleanly.
   */
  it('cancels the cache-collection timer an unsubscribed query left running', async () => {
    answerEveryRequest();
    const store = createTestStore();

    const subscription = store.dispatch(probeApi.endpoints.probe.initiate());
    await subscription;
    subscription.unsubscribe();

    // The leak is real before disposal, or the assertion after it proves
    // nothing.
    expect(hasCacheCollectionTimer()).toBe(true);

    runTestEndDisposals();

    expect(hasCacheCollectionTimer()).toBe(false);
  });

  it('forgets what it cached, so nothing survives into the next test', async () => {
    answerEveryRequest();
    const store = createTestStore();

    await store.dispatch(probeApi.endpoints.probe.initiate());
    expect(Object.keys(store.getState().api.queries)).not.toHaveLength(0);

    runTestEndDisposals();

    expect(Object.keys(store.getState().api.queries)).toHaveLength(0);
  });

  /**
   * A request the test never waited for is the other half of the same problem:
   * it settles whenever the network gets round to it, which on a saturated CI
   * worker is comfortably after the environment has gone.
   */
  it('abandons a request that is still in flight', async () => {
    neverAnswer();
    const store = createTestStore();

    const subscription = store.dispatch(probeApi.endpoints.probe.initiate());
    runTestEndDisposals();

    // It settles at all, which is the whole point — the transport never
    // answers, so without disposal this is still waiting when the test is over
    // and this line would time out rather than fail.
    const outcome = await subscription;
    expect(outcome.status).not.toBe('pending');
    expect(store.getState().api.queries).toEqual({});
  });

  it('disposes of every store the test made, not just the last one', () => {
    createTestStore();
    createTestStore();

    expect(runTestEndDisposals()).toBe(2);
    expect(runTestEndDisposals()).toBe(0);
  });
});

describe('clearing what is left over', () => {
  /**
   * Some timers have no owner to ask. RTK Query's 500 ms subscription-sync
   * timer is never cleared even by `resetApiState`, and the backoff a retry is
   * sleeping through lives inside a promise nobody holds. They are short, so
   * they are harmless mid-file and fatal at the end of one.
   */
  it('clears a timer nobody kept a handle to', () => {
    const neverRunsAgain = jest.fn();
    setTimeout(neverRunsAgain, 60_000);

    expect(outstandingTimers().some((timer) => timer.delayMs === 60_000)).toBe(true);

    clearOutstandingTimers();

    expect(outstandingTimers()).toHaveLength(0);
    expect(neverRunsAgain).not.toHaveBeenCalled();
  });

  it('stops tracking a timer once it has fired', async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));

    expect(outstandingTimers().some((timer) => timer.delayMs === 1)).toBe(false);
  });
});
