import type {
  AcceptedOffer,
  CurrentMasterJob,
  DeclinedOffer,
  Master,
  MasterOffer,
  Order,
  OrderStatus,
} from '@tezusta/types';

import { api } from '../api/api-slice';

/** The body of `POST /orders/:id/transitions`, from the master's side. */
export interface TransitionJobArg {
  readonly orderId: string;
  readonly to: OrderStatus;
  /** Required by the server for `SEARCHING` — a re-dispatch is always reasoned. */
  readonly reason?: string;
}

/**
 * The master's working surface (issue #199): who they are, what they are
 * offered, and the job they are on.
 *
 * **Two tags and one rule.** `MasterOffer` is the feed and `MasterJob` is the
 * job, and every write invalidates whichever of the two it can have changed —
 * an accept moves an offer into a job, a decline removes an offer, a
 * transition moves the job or ends it. The socket invalidates the same two
 * (`apply-realtime-event.ts`), so a change reaches the screen the same way
 * whether this phone made it or another party did.
 *
 * **No polling.** The feed is fetched on mount and refreshed by the socket's
 * `order:offer` frame; the job likewise, by `order:transition`. An
 * `pollingInterval` here would be the uncontrolled polling CLAUDE.md §12
 * forbids, on the device that can least afford it.
 */
export const masterJobsApi = api.injectEndpoints({
  endpoints: (build) => ({
    /**
     * The caller's own master profile — read here for its `id`, which is the
     * name of the socket room offers arrive in.
     */
    ownMaster: build.query<Master, void>({
      query: () => '/masters/me',
    }),

    offers: build.query<readonly MasterOffer[], void>({
      query: () => '/masters/me/offers',
      providesTags: [{ type: 'MasterOffer', id: 'LIST' }],
      /**
       * Offers expire in minutes and a stale card is one that fails on tap
       * (ADR-0009). Nothing is kept once the feed is off screen, so coming
       * back always shows what the server holds now.
       */
      keepUnusedDataFor: 0,
    }),

    acceptOffer: build.mutation<AcceptedOffer, string>({
      query: (offerId) => ({
        url: `/masters/me/offers/${offerId}/accept`,
        method: 'POST',
        body: {},
      }),
      /**
       * Both tags on success **and** on failure. A lost race, an expired offer
       * and "already working" all mean the card the master tapped is no longer
       * true, and leaving it on screen invites a second tap on the same dead
       * offer.
       */
      invalidatesTags: ['MasterJob', { type: 'MasterOffer', id: 'LIST' }],
    }),

    declineOffer: build.mutation<DeclinedOffer, string>({
      query: (offerId) => ({
        url: `/masters/me/offers/${offerId}/decline`,
        method: 'POST',
        body: {},
      }),
      invalidatesTags: [{ type: 'MasterOffer', id: 'LIST' }],
    }),

    currentJob: build.query<CurrentMasterJob, void>({
      query: () => '/masters/me/jobs/current',
      providesTags: ['MasterJob'],
    }),

    /**
     * The one write path an order's status moves through, shared with the
     * customer (`orders.controller.ts`). The server re-reads whether this
     * caller is the assigned master on every request; nothing here decides it.
     */
    transitionJob: build.mutation<Order, TransitionJobArg>({
      query: ({ orderId, to, reason }) => ({
        url: `/orders/${orderId}/transitions`,
        method: 'POST',
        body: reason === undefined ? { to } : { to, reason },
      }),
      /**
       * Invalidated on failure too: a 409 here means the order moved under the
       * master — most often a customer cancellation racing the tap — and the
       * screen must show the order as it now is rather than as it was.
       */
      invalidatesTags: ['MasterJob'],
    }),
  }),
});

export const {
  useOwnMasterQuery,
  useOffersQuery,
  useAcceptOfferMutation,
  useDeclineOfferMutation,
  useCurrentJobQuery,
  useTransitionJobMutation,
} = masterJobsApi;
