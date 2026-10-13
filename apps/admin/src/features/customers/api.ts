import type {
  AdminAccountStatus,
  AdminCustomerDetail,
  AdminCustomerSummary,
  AdminCustomerSuspension,
  AdminOrderSummary,
  AdminPhoneReveal,
  CursorPage,
} from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

export interface CustomerListArg {
  /** A name prefix, a customer id or a whole number in E.164; absent lists everyone. */
  readonly q: string | undefined;
  /** Absent means every status. */
  readonly status: AdminAccountStatus | undefined;
}

export interface CustomerReasonArg {
  readonly customerId: string;
  readonly reason: string;
}

const LIST = { type: 'Customer', id: 'LIST' } as const;
const ORDER_LIST = { type: 'Order', id: 'LIST' } as const;

const id = encodeURIComponent;

/**
 * `/admin/customers` (#328, ADR-0050). A suspension or a reinstatement
 * invalidates the customer, their orders, the customer list and the order
 * list — a suspension cancels the orders still searching.
 */
export const customersApi = adminApi
  .enhanceEndpoints({ addTagTypes: ['Customer', 'Order'] })
  .injectEndpoints({
    endpoints: (build) => ({
      listCustomers: build.infiniteQuery<
        CursorPage<AdminCustomerSummary>,
        CustomerListArg,
        string | null
      >({
        infiniteQueryOptions: {
          initialPageParam: null,
          getNextPageParam: (lastPage) => lastPage.nextCursor,
        },
        query: ({ queryArg, pageParam }) => ({
          url: '/admin/customers',
          params: { q: queryArg.q, status: queryArg.status, cursor: pageParam ?? undefined },
        }),
        providesTags: [LIST],
      }),
      customerDetail: build.query<AdminCustomerDetail, string>({
        query: (customerId) => `/admin/customers/${id(customerId)}`,
        providesTags: (_result, _error, customerId) => [{ type: 'Customer', id: customerId }],
      }),
      customerOrders: build.infiniteQuery<CursorPage<AdminOrderSummary>, string, string | null>({
        infiniteQueryOptions: {
          initialPageParam: null,
          getNextPageParam: (lastPage) => lastPage.nextCursor,
        },
        query: ({ queryArg, pageParam }) => ({
          url: `/admin/customers/${id(queryArg)}/orders`,
          params: { cursor: pageParam ?? undefined },
        }),
        providesTags: (_result, _error, customerId) => [
          { type: 'Customer', id: `${customerId}:orders` },
          ORDER_LIST,
        ],
      }),
      /** Dispatched with `track: false`: the number lives only in the dialog that shows it. */
      revealCustomerPhone: build.mutation<AdminPhoneReveal, CustomerReasonArg>({
        query: ({ customerId, reason }) => ({
          url: `/admin/customers/${id(customerId)}/phone`,
          method: 'POST',
          body: { reason },
        }),
      }),
      suspendCustomer: build.mutation<AdminCustomerSuspension, CustomerReasonArg>({
        query: ({ customerId, reason }) => ({
          url: `/admin/customers/${id(customerId)}/suspend`,
          method: 'POST',
          body: { reason },
        }),
        invalidatesTags: (result, _error, { customerId }) => [
          { type: 'Customer', id: customerId },
          { type: 'Customer', id: `${customerId}:orders` },
          LIST,
          ORDER_LIST,
          // Each order the suspension cancelled, so an open order page re-reads it.
          ...(result?.cancelledOrderIds ?? []).map((orderId) => ({
            type: 'Order' as const,
            id: orderId,
          })),
        ],
      }),
      reinstateCustomer: build.mutation<AdminCustomerSummary, CustomerReasonArg>({
        query: ({ customerId, reason }) => ({
          url: `/admin/customers/${id(customerId)}/reinstate`,
          method: 'POST',
          body: { reason },
        }),
        invalidatesTags: (_result, _error, { customerId }) => [
          { type: 'Customer', id: customerId },
          LIST,
        ],
      }),
    }),
  });

export const {
  useListCustomersInfiniteQuery,
  useCustomerDetailQuery,
  useCustomerOrdersInfiniteQuery,
  useSuspendCustomerMutation,
  useReinstateCustomerMutation,
} = customersApi;
