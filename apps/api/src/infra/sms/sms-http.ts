/**
 * What a provider adapter needs to call a REST endpoint (#390), shared so
 * that the two rules every adapter must keep are written once:
 *
 * - **A deadline.** A provider that hangs must not hold a sign-in request
 *   open; past `timeoutMs` the call is abandoned and the fallback is tried.
 * - **Nothing the provider said reaches an error.** The request body carries
 *   the code and the response may echo the number, so a failure is described
 *   by the provider's name and the HTTP status alone.
 */

/** The `fetch` an adapter calls; injected so a test can stand in for the provider. */
export type SmsFetch = (input: string, init: RequestInit) => Promise<Response>;

/**
 * A provider refused or failed a send. **Its message names only the provider
 * and the kind of failure** — never the body, the number, or the response —
 * because `OtpService.deliver` and the exception filter both log errors.
 */
export class SmsProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly failure: string,
  ) {
    super(`${provider} did not accept the message: ${failure}`);
    this.name = 'SmsProviderError';
    Object.setPrototypeOf(this, SmsProviderError.prototype);
  }
}

/** `Authorization: Basic …` for an account id and its secret. */
export function basicAuth(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`, 'utf8').toString('base64')}`;
}

/**
 * Calls the provider with a deadline and returns the parsed JSON of a 2xx
 * answer (`null` when it is not JSON). Anything else throws
 * {@link SmsProviderError}, with no detail from the request or response.
 */
export async function postToProvider(
  provider: string,
  fetchImpl: SmsFetch,
  url: string,
  init: Omit<RequestInit, 'method' | 'signal'>,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new SmsProviderError(provider, timedOut ? 'timed out' : 'unreachable');
  }

  if (!response.ok) {
    // Drained, so the connection is released; never read into the error.
    await response.body?.cancel().catch(() => undefined);
    throw new SmsProviderError(provider, `HTTP ${String(response.status)}`);
  }
  return response.json().catch(() => null);
}
