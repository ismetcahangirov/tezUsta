import { createRetryingBaseQuery, isClientError, type AppBaseQuery } from './base-query';

/**
 * Drives the real base query — `fetchBaseQuery` wrapped in the real `retry` —
 * against a stub transport, so what is under test is the policy as shipped and
 * not a predicate that merely resembles it.
 *
 * Backoff is replaced by an immediate resolve. The delay between attempts is
 * not the behaviour being asserted, and waiting for it would make the suite
 * slow and timer-dependent.
 */
function callWith(status: number): {
  run: () => Promise<unknown>;
  attempts: () => number;
} {
  let attempts = 0;

  const fetchFn = ((): Promise<Response> => {
    attempts += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ code: 'TEST' }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;

  const baseQuery: AppBaseQuery = createRetryingBaseQuery({
    baseUrl: 'http://api.test',
    fetchFn,
    backoff: () => Promise.resolve(),
  });

  // The shape RTK Query hands a base query at call time. Supplying it here is
  // what lets the real `fetchBaseQuery` run without a store behind it.
  const baseQueryApi = {
    signal: new AbortController().signal,
    abort: () => undefined,
    dispatch: () => undefined,
    getState: () => ({}),
    extra: undefined,
    endpoint: 'ping',
    type: 'query' as const,
    forced: false,
  };

  return {
    run: () => Promise.resolve(baseQuery('/ping', baseQueryApi as never, {})),
    attempts: () => attempts,
  };
}

describe('retry policy', () => {
  it('retries a server error up to the limit, so a transient failure recovers', async () => {
    const call = callWith(503);

    await call.run();

    // One initial attempt plus two retries.
    expect(call.attempts()).toBe(3);
  });

  it('retries a 500 as well, which is the same class of failure', async () => {
    const call = callWith(500);

    await call.run();

    expect(call.attempts()).toBe(3);
  });

  it('does not retry a validation failure, which cannot succeed on a second try', async () => {
    const call = callWith(422);

    await call.run();

    expect(call.attempts()).toBe(1);
  });

  it('does not retry a rate limit, which would burn the remaining attempt budget', async () => {
    const call = callWith(429);

    await call.run();

    expect(call.attempts()).toBe(1);
  });

  it('does not retry an authentication failure', async () => {
    const call = callWith(401);

    await call.run();

    expect(call.attempts()).toBe(1);
  });

  it('does not retry a missing resource', async () => {
    const call = callWith(404);

    await call.run();

    expect(call.attempts()).toBe(1);
  });

  it('returns the client error to the caller rather than swallowing it', async () => {
    const call = callWith(422);

    const result = (await call.run()) as { error?: { status?: number } };

    expect(result.error?.status).toBe(422);
  });
});

describe('client error classification', () => {
  it('treats the 4xx range as settled', () => {
    expect(isClientError(400)).toBe(true);
    expect(isClientError(404)).toBe(true);
    expect(isClientError(422)).toBe(true);
    expect(isClientError(429)).toBe(true);
    expect(isClientError(499)).toBe(true);
  });

  it('treats a server error as worth another attempt', () => {
    expect(isClientError(500)).toBe(false);
    expect(isClientError(503)).toBe(false);
  });

  it('treats a transport failure, which carries no numeric status, as worth another attempt', () => {
    expect(isClientError('FETCH_ERROR')).toBe(false);
    expect(isClientError('TIMEOUT_ERROR')).toBe(false);
    expect(isClientError(undefined)).toBe(false);
  });
});
