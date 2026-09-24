import type {
  AdminOrderDetail,
  AdminOrderSummary,
  AdminOrderTranscript,
  AdminPhoneReveal,
  CursorPage,
  Order,
  OrderStatus,
} from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

export interface OrderListArg {
  /** Empty means every status but `DRAFT`. */
  readonly statuses: readonly OrderStatus[];
  readonly stuck: boolean;
  /** ISO 8601 instants; `from` inclusive, `to` exclusive. */
  readonly from: string | undefined;
  readonly to: string | undefined;
}

export interface OrderTransitionArg {
  readonly orderId: string;
  readonly to: OrderStatus;
  readonly reason: string;
}

export type OrderParty = 'customer' | 'master';

export interface PhoneRevealArg {
  readonly orderId: string;
  readonly party: OrderParty;
  readonly reason: string;
}

export interface OrderPhotoArg {
  readonly orderId: string;
  readonly photoId: string;
}

const LIST = { type: 'Order', id: 'LIST' } as const;

type Page = CursorPage<AdminOrderSummary>;

const cursorPaging = {
  initialPageParam: null,
  getNextPageParam: (lastPage: Page) => lastPage.nextCursor,
};

const id = encodeURIComponent;

/**
 * Order oversight and the dispute queue (#249; ADR-0043 § 5–6). A transition
 * invalidates the order and both lists, so the history shows the override the
 * moment the server has recorded it.
 */
export const ordersApi = adminApi.enhanceEndpoints({ addTagTypes: ['Order'] }).injectEndpoints({
  endpoints: (build) => ({
    listOrders: build.infiniteQuery<Page, OrderListArg, string | null>({
      infiniteQueryOptions: cursorPaging,
      query: ({ queryArg, pageParam }) => ({
        url: '/admin/orders',
        params: {
          status: queryArg.statuses.length === 0 ? undefined : queryArg.statuses.join(','),
          stuck: queryArg.stuck ? 'true' : undefined,
          from: queryArg.from,
          to: queryArg.to,
          cursor: pageParam ?? undefined,
        },
      }),
      providesTags: [LIST],
    }),
    /** Every `DISPUTED` order, oldest first — the server fixes both. */
    listDisputes: build.infiniteQuery<Page, void, string | null>({
      infiniteQueryOptions: cursorPaging,
      query: ({ pageParam }) => ({
        url: '/admin/orders/disputes',
        params: { cursor: pageParam ?? undefined },
      }),
      providesTags: [LIST],
    }),
    orderDetail: build.query<AdminOrderDetail, string>({
      query: (orderId) => `/admin/orders/${id(orderId)}`,
      providesTags: (_result, _error, orderId) => [{ type: 'Order', id: orderId }],
    }),
    /**
     * Fetched only when the admin asks — each read is audited — and dropped
     * as soon as nothing shows it.
     */
    orderTranscript: build.query<AdminOrderTranscript, string>({
      query: (orderId) => `/admin/orders/${id(orderId)}/transcript`,
      keepUnusedDataFor: 0,
    }),
    /** Dispatched with `track: false`: the number lives only in the dialog that shows it. */
    revealPhone: build.mutation<AdminPhoneReveal, PhoneRevealArg>({
      query: ({ orderId, party, reason }) => ({
        url: `/admin/orders/${id(orderId)}/parties/${party}/phone`,
        method: 'POST',
        body: { reason },
      }),
    }),
    /** A GET with a side effect (an audited read), so a mutation: never cached. */
    orderPhotoDownload: build.mutation<{ url: string; expiresAt: string }, OrderPhotoArg>({
      query: ({ orderId, photoId }) => ({
        url: `/admin/orders/${id(orderId)}/photos/${id(photoId)}/download`,
        method: 'GET',
      }),
    }),
    transitionOrder: build.mutation<Order, OrderTransitionArg>({
      query: ({ orderId, to, reason }) => ({
        url: `/admin/orders/${id(orderId)}/transitions`,
        method: 'POST',
        body: { to, reason },
      }),
      invalidatesTags: (_result, _error, { orderId }) => [{ type: 'Order', id: orderId }, LIST],
    }),
  }),
});

export const {
  useListOrdersInfiniteQuery,
  useListDisputesInfiniteQuery,
  useOrderDetailQuery,
  useOrderTranscriptQuery,
  useTransitionOrderMutation,
} = ordersApi;
