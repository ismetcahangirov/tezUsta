import type { MasterAvailability } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * The availability toggle and its heartbeat (issue #40).
 *
 * Every endpoint here answers with the **whole** availability state rather
 * than an acknowledgement, so the cache is replaced with what the server
 * actually believes instead of with what the client asked for. That is the
 * mechanical half of `docs/product/master-flow.md`'s requirement that the
 * toggle be unambiguous: a master who believes they are offline while the app
 * still reports location loses trust in the product permanently, and the only
 * way to be sure the screen is right is for the screen to render the server's
 * answer.
 */
export const masterAvailabilityApi = api.injectEndpoints({
  endpoints: (build) => ({
    getAvailability: build.query<MasterAvailability, void>({
      query: () => '/masters/me/availability',
    }),

    setAvailability: build.mutation<MasterAvailability, boolean>({
      query: (isAvailable) => ({
        url: '/masters/me/availability',
        method: 'POST',
        body: { isAvailable },
      }),
      async onQueryStarted(_isAvailable, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          // Patched rather than invalidated. A refetch would leave the toggle
          // showing its old position for a round trip — on a mobile connection,
          // long enough for a master to tap it again — and the response already
          // carries the complete new state.
          dispatch(
            masterAvailabilityApi.util.updateQueryData('getAvailability', undefined, () => data),
          );
        } catch {
          // The mutation's own error state is what the screen renders, and the
          // cache is deliberately left alone: the server refused, so the state
          // it last told us is still the true one.
        }
      },
    }),

    /**
     * Refreshes the presence TTL.
     *
     * Fails with 409 when the master is offline or no longer eligible — a
     * suspension mid-shift, for instance — and that failure is the signal the
     * heartbeat loop stops on. It is not a fire-and-forget.
     */
    sendHeartbeat: build.mutation<MasterAvailability, void>({
      query: () => ({ url: '/masters/me/availability/heartbeat', method: 'POST', body: {} }),
      async onQueryStarted(_arg, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          dispatch(
            masterAvailabilityApi.util.updateQueryData('getAvailability', undefined, () => data),
          );
        } catch {
          // Leave the cache. `useAvailabilityHeartbeat` refetches on a failed
          // beat, so the screen learns the real state from the server rather
          // than from this client's guess about what the error meant.
        }
      },
    }),
  }),
});

export const { useGetAvailabilityQuery, useSetAvailabilityMutation, useSendHeartbeatMutation } =
  masterAvailabilityApi;
