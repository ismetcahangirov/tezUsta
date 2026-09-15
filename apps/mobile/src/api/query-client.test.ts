import { createQueryClient, shouldRetry } from './query-client';

describe('query client', () => {
  it('does not retry mutations, so a request is never sent twice by accident', () => {
    const defaults = createQueryClient().getDefaultOptions();

    expect(defaults.mutations?.retry).toBe(0);
  });

  it('does not refetch on focus, which would spend the user data on every app switch', () => {
    const defaults = createQueryClient().getDefaultOptions();

    expect(defaults.queries?.refetchOnWindowFocus).toBe(false);
  });

  it('gives each client its own cache', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });

  it('wires the retry policy into the client defaults', () => {
    const defaults = createQueryClient().getDefaultOptions();

    expect(defaults.queries?.retry).toBe(shouldRetry);
  });
});

describe('retry policy', () => {
  it('retries a network failure that carries no status', () => {
    expect(shouldRetry(0, new Error('Network request failed'))).toBe(true);
    expect(shouldRetry(1, new Error('Network request failed'))).toBe(true);
  });

  it('gives up after two retries', () => {
    expect(shouldRetry(2, new Error('Network request failed'))).toBe(false);
  });

  it('retries a server error, which may be transient', () => {
    expect(shouldRetry(0, { status: 500 })).toBe(true);
    expect(shouldRetry(0, { status: 503 })).toBe(true);
  });

  it('does not retry a validation failure', () => {
    expect(shouldRetry(0, { status: 400 })).toBe(false);
    expect(shouldRetry(0, { status: 422 })).toBe(false);
  });

  it('does not retry an authentication or authorization failure', () => {
    expect(shouldRetry(0, { status: 401 })).toBe(false);
    expect(shouldRetry(0, { status: 403 })).toBe(false);
  });

  it('does not retry a rate limit, which would burn the remaining attempt budget', () => {
    // An OTP verify is limited to a handful of attempts per code
    // (docs/architecture/authentication.md). A client that retries a 429
    // spends that budget three times as fast as the server policy assumes.
    expect(shouldRetry(0, { status: 429 })).toBe(false);
  });

  it('does not retry a missing resource', () => {
    expect(shouldRetry(0, { status: 404 })).toBe(false);
  });

  it('reads the status from a response envelope as well as the error itself', () => {
    expect(shouldRetry(0, { response: { status: 422 } })).toBe(false);
    expect(shouldRetry(0, { response: { status: 500 } })).toBe(true);
  });

  it('treats a non-numeric status as unknown and retries', () => {
    expect(shouldRetry(0, { status: 'teapot' })).toBe(true);
    expect(shouldRetry(0, null)).toBe(true);
    expect(shouldRetry(0, undefined)).toBe(true);
  });
});
