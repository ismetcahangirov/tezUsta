import {
  createApi,
  fetchBaseQuery,
  retry,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
  type FetchBaseQueryMeta,
} from '@reduxjs/toolkit/query/react';

/** Maximum retries for a failure that is plausibly transient. */
const MAX_RETRIES = 2;

/**
 * How long a cached result is considered fresh, in seconds. RTK Query has no
 * `staleTime`: `refetchOnMountOrArgChange` takes the same number and means the
 * same thing at a mount or an argument change.
 */
const FRESH_FOR_SECONDS = 30;

/**
 * How long an unsubscribed result stays in the cache, in seconds — the
 * equivalent of a garbage-collection window.
 */
const KEEP_UNUSED_FOR_SECONDS = 300;

/**
 * A 4xx is the server stating that this request, as sent, is wrong. Sending it
 * again cannot change the answer, and for two statuses it actively harms:
 *
 * - `429` is an instruction to stop. Retrying burns the caller's remaining
 *   budget — on OTP verify, three times as fast as the server policy assumes
 *   (docs/architecture/authentication.md § Rate limiting).
 * - `401` triggers a refresh-and-replay cycle upstream; retrying underneath it
 *   multiplies that cycle.
 *
 * A failure with no numeric status is a transport failure — `FETCH_ERROR`,
 * `TIMEOUT_ERROR` — and is retried, which is the common case on a mobile
 * network.
 */
export function isClientError(status: unknown): boolean {
  return typeof status === 'number' && status >= 400 && status < 500;
}

export type AppBaseQuery = BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError,
  object,
  FetchBaseQueryMeta
>;

interface BaseQueryOptions {
  /**
   * Defaults to `EXPO_PUBLIC_API_URL`. It must be absolute: React Native has
   * no page origin to resolve a relative URL against, and `fetchBaseQuery`
   * fails while building the request rather than at the transport, which is a
   * confusing place to debug from.
   */
  readonly baseUrl?: string;
  /** Overridden in tests to drive a stub transport. */
  readonly fetchFn?: typeof fetch;
  /** Overridden in tests so a retry does not wait for real backoff. */
  readonly backoff?: (attempt: number, maxRetries: number) => Promise<void>;
}

/**
 * `retry` on its own would retry every failure up to `maxRetries`.
 * `retry.fail` is the only way to tell it a particular response is settled —
 * without it, the 4xx rule above cannot be expressed at all.
 */
export function createRetryingBaseQuery({
  baseUrl = process.env.EXPO_PUBLIC_API_URL ?? '',
  fetchFn,
  backoff,
}: BaseQueryOptions = {}): AppBaseQuery {
  const rawBaseQuery = fetchBaseQuery({
    baseUrl,
    ...(fetchFn ? { fetchFn } : {}),
  });

  // Annotated rather than inferred: `retry` cannot narrow its callback's
  // parameters on its own, and an un-annotated `args` arrives as `any`, which
  // then spreads into the call below (CLAUDE.md §20).
  const failFastOnClientError: AppBaseQuery = async (args, baseQueryApi, extraOptions) => {
    const result = await rawBaseQuery(args, baseQueryApi, extraOptions);

    if (result.error && isClientError(result.error.status)) {
      retry.fail(result.error, result.meta);
    }

    return result;
  };

  return retry(failFastOnClientError, {
    maxRetries: MAX_RETRIES,
    ...(backoff ? { backoff } : {}),
  });
}

/**
 * The single API slice. Endpoints are **injected by the feature that owns
 * them** through `api.injectEndpoints`, never declared here — the same reason
 * a NestJS module owns its own routes. This file stays a transport policy, not
 * a catalogue of every endpoint in the product.
 *
 * `setupListeners` is deliberately not called anywhere. Refetch-on-focus costs
 * the user mobile data on every app switch, which is not a trade this market
 * rewards (docs/engineering/performance.md).
 */
export const api = createApi({
  reducerPath: 'api',
  baseQuery: createRetryingBaseQuery(),
  refetchOnMountOrArgChange: FRESH_FOR_SECONDS,
  keepUnusedDataFor: KEEP_UNUSED_FOR_SECONDS,
  refetchOnFocus: false,
  refetchOnReconnect: false,
  tagTypes: [],
  endpoints: () => ({}),
});
