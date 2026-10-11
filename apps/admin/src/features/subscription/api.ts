import type {
  AdminMasterSubscription,
  AdminSubscription,
  CancelSubscriptionRequest,
  ChangeSubscriptionPricesRequest,
  GrantSubscriptionRequest,
  MasterSubscription,
  UpdateSubscriptionSettingsRequest,
  WithdrawSubscriptionPriceRequest,
} from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

const OFFER = { type: 'Subscription', id: 'OFFER' } as const;
const MASTER_LIST = { type: 'Master', id: 'LIST' } as const;

export interface WithdrawPriceArg extends WithdrawSubscriptionPriceRequest {
  readonly priceId: string;
}

export interface MasterSubscriptionArg {
  readonly masterId: string;
}

/**
 * `/admin/subscription` and `/admin/masters/:id/subscription` (#324). Every
 * edit answers with the whole offer or subscription, so the screen shows what
 * the server now holds rather than what the panel assumed. A grant or a
 * cancellation also refreshes the master and the masters list, whose
 * subscription column it changed.
 */
export const subscriptionApi = adminApi
  .enhanceEndpoints({ addTagTypes: ['Subscription', 'MasterSubscription', 'Master'] })
  .injectEndpoints({
    endpoints: (build) => ({
      adminSubscription: build.query<AdminSubscription, void>({
        query: () => '/admin/subscription',
        providesTags: [OFFER],
      }),
      changeSubscriptionPrices: build.mutation<AdminSubscription, ChangeSubscriptionPricesRequest>({
        query: (body) => ({ url: '/admin/subscription/prices', method: 'PUT', body }),
        invalidatesTags: [OFFER],
      }),
      withdrawSubscriptionPrice: build.mutation<AdminSubscription, WithdrawPriceArg>({
        query: ({ priceId, reason }) => ({
          url: `/admin/subscription/prices/${encodeURIComponent(priceId)}/withdraw`,
          method: 'POST',
          body: { reason },
        }),
        invalidatesTags: [OFFER],
      }),
      updateSubscriptionSettings: build.mutation<
        AdminSubscription,
        UpdateSubscriptionSettingsRequest
      >({
        query: (body) => ({ url: '/admin/subscription/settings', method: 'PUT', body }),
        invalidatesTags: [OFFER],
      }),
      masterSubscription: build.query<AdminMasterSubscription, string>({
        query: (masterId) => `/admin/masters/${encodeURIComponent(masterId)}/subscription`,
        providesTags: (_result, _error, masterId) => [{ type: 'MasterSubscription', id: masterId }],
      }),
      grantSubscription: build.mutation<
        MasterSubscription,
        GrantSubscriptionRequest & MasterSubscriptionArg
      >({
        query: ({ masterId, days, reason }) => ({
          url: `/admin/masters/${encodeURIComponent(masterId)}/subscription/grant`,
          method: 'POST',
          body: { days, reason },
        }),
        invalidatesTags: (_result, _error, { masterId }) => [
          { type: 'MasterSubscription', id: masterId },
          { type: 'Master', id: masterId },
          MASTER_LIST,
        ],
      }),
      cancelSubscription: build.mutation<
        MasterSubscription,
        CancelSubscriptionRequest & MasterSubscriptionArg
      >({
        query: ({ masterId, reason }) => ({
          url: `/admin/masters/${encodeURIComponent(masterId)}/subscription/cancel`,
          method: 'POST',
          body: { reason },
        }),
        invalidatesTags: (_result, _error, { masterId }) => [
          { type: 'MasterSubscription', id: masterId },
          { type: 'Master', id: masterId },
          MASTER_LIST,
        ],
      }),
    }),
  });

export const {
  useAdminSubscriptionQuery,
  useChangeSubscriptionPricesMutation,
  useWithdrawSubscriptionPriceMutation,
  useUpdateSubscriptionSettingsMutation,
  useMasterSubscriptionQuery,
  useGrantSubscriptionMutation,
  useCancelSubscriptionMutation,
} = subscriptionApi;
