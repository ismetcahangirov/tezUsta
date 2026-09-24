import type { Call, CallJoinCredential } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * The one HTTP route calling has (issue #185): a credential for an answered
 * call's media room — for the caller, who learns of the answer from a
 * broadcast frame that cannot carry one, and for either party reconnecting.
 *
 * **Never dispatched with tracking.** A mutation's result is otherwise held in
 * the store, where Redux DevTools and anything that serialises state can read
 * it, and `token` is a bearer credential for the room (ADR-0034 § 3). The
 * caller initiates it with `{ track: false }` and keeps the result in memory
 * for the life of the call (`useCall.ts`). No tag: nothing caches a credential
 * and nothing a credential changes is cached.
 */
export const callsApi = api.injectEndpoints({
  endpoints: (build) => ({
    joinCall: build.mutation<CallJoinCredential, string>({
      query: (callId) => ({ url: `/calls/${callId}/join`, method: 'POST' }),
    }),

    /**
     * One call as this party sees it (#189): what a ring push is confirmed
     * against before an incoming screen is shown (ADR-0039 § 4). Party-only;
     * the server answers 404 for a stranger and for an unknown id alike.
     *
     * **A query, but never served from the cache.** The `Call` carries no
     * credential, so holding one in the store is harmless — but a cached
     * `RINGING` is exactly the stale answer the confirmation exists to refuse.
     * `keepUnusedDataFor: 0` drops it the moment nobody reads it, and the one
     * caller (`confirmRingingCall`) initiates with `forceRefetch` and no
     * subscription, so every confirmation is a fresh read of the server.
     */
    getCall: build.query<Call, string>({
      query: (callId) => `/calls/${encodeURIComponent(callId)}`,
      keepUnusedDataFor: 0,
    }),
  }),
});
