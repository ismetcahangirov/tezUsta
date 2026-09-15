import { QueryClient } from '@tanstack/react-query';

/** Maximum retries for a failure that is plausibly transient. */
const MAX_RETRIES = 2;

/**
 * Reads an HTTP status off whatever the transport threw, without assuming one
 * transport. `fetch` wrappers tend to throw an error carrying `status`;
 * response-shaped clients nest it under `response`.
 */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;

  const direct = (error as { status?: unknown }).status;
  if (typeof direct === 'number') return direct;

  const nested = (error as { response?: { status?: unknown } }).response?.status;
  if (typeof nested === 'number') return nested;

  return undefined;
}

/**
 * Retry policy (docs/architecture/frontend-architecture.md § Server state):
 * exponential backoff on transient failures, **never on a 4xx**.
 *
 * A 4xx is the server stating that this request, as sent, is wrong. Sending it
 * again cannot change the answer, and for two statuses it actively harms:
 *
 * - `429` is an instruction to stop. Retrying burns the caller's remaining
 *   budget — on OTP verify, three times as fast as the server policy assumes
 *   (docs/architecture/authentication.md § Rate limiting).
 * - `401` triggers a refresh-and-replay cycle upstream; retrying underneath it
 *   multiplies that cycle.
 *
 * A failure with no readable status is treated as a network failure and
 * retried, which is the common case on a mobile network.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  const status = statusOf(error);

  if (status !== undefined && status >= 400 && status < 500) return false;

  return failureCount < MAX_RETRIES;
}

/**
 * TanStack Query owns every piece of server state
 * (docs/architecture/frontend-architecture.md).
 *
 * Defaults are tuned for a mid-range Android on a mobile network: refetching on
 * every focus costs data the user is paying for, and a request that has already
 * failed twice is rarely fixed by a third attempt.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: shouldRetry,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}
