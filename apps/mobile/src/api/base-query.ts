import {
  fetchBaseQuery,
  retry,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryArgs,
  type FetchBaseQueryError,
  type FetchBaseQueryMeta,
} from '@reduxjs/toolkit/query/react';

/**
 * Where the API lives. `EXPO_PUBLIC_` is correct for this one value: a base
 * URL grants no server authority and no billing power, so it is not a secret
 * under CLAUDE.md §4. Nothing that *is* a secret may ever join it behind this
 * prefix — the prefix ships the value inside the APK.
 *
 * Read once, at module scope, because Metro inlines `process.env.EXPO_PUBLIC_*`
 * at build time; there is no runtime environment to re-read it from.
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

/** Maximum retries for a failure that is plausibly transient. */
const MAX_RETRIES = 2;

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

export interface BaseQueryOptions {
  /**
   * Defaults to `EXPO_PUBLIC_API_URL`. It must be absolute: React Native has
   * no page origin to resolve a relative URL against, and `fetchBaseQuery`
   * fails while building the request rather than at the transport, which is a
   * confusing place to debug from.
   */
  readonly baseUrl?: string;
  /**
   * Runs on every attempt, including the replay after a token refresh, which
   * is why the access token is read here rather than baked into the request
   * when it was first built — a replay must carry the *new* token
   * (`src/auth/auth-base-query.ts`).
   */
  readonly prepareHeaders?: FetchBaseQueryArgs['prepareHeaders'];
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
  baseUrl = API_BASE_URL,
  prepareHeaders,
  fetchFn,
  backoff,
}: BaseQueryOptions = {}): AppBaseQuery {
  const rawBaseQuery = fetchBaseQuery({
    baseUrl,
    ...(prepareHeaders ? { prepareHeaders } : {}),
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
