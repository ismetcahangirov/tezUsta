import { createApi } from '@reduxjs/toolkit/query/react';
import type {
  MasterSubscription,
  StartSubscriptionCheckoutRequest,
  SubscriptionAutoRenewal,
  SubscriptionCheckout,
  SubscriptionOffer,
  WebSession,
} from '@tezusta/types';

import { webBaseQuery } from './base-query';

/**
 * `POST /web/auth/otp/request`'s answer — the same for every phone
 * (ADR-0061 § 4). Transcribed rather than imported: the API's OTP types have
 * not moved to `packages/types`, as `apps/mobile/src/auth/` already notes.
 */
export interface CodeRequested {
  readonly expiresInSeconds: number;
}

export interface CodeVerification {
  readonly phone: string;
  readonly code: string;
}

/**
 * The page's whole API surface: its own sign-in, and the routes ADR-0061 § 3
 * opens to a web session. Nothing else answers a web cookie.
 */
export const webApi = createApi({
  reducerPath: 'webApi',
  baseQuery: webBaseQuery,
  tagTypes: ['Subscription', 'AutoRenewal'],
  endpoints: (build) => ({
    requestCode: build.mutation<CodeRequested, { readonly phone: string }>({
      query: (body) => ({ url: '/web/auth/otp/request', method: 'POST', body }),
    }),
    verifyCode: build.mutation<WebSession, CodeVerification>({
      query: (body) => ({ url: '/web/auth/otp/verify', method: 'POST', body }),
    }),
    signOut: build.mutation<void, void>({
      query: () => ({ url: '/web/auth/sign-out', method: 'POST' }),
    }),
    offer: build.query<SubscriptionOffer, void>({
      query: () => '/subscription',
    }),
    mySubscription: build.query<MasterSubscription, void>({
      query: () => '/masters/me/subscription',
      providesTags: ['Subscription'],
    }),
    autoRenewal: build.query<SubscriptionAutoRenewal, void>({
      query: () => '/masters/me/subscription/auto-renewal',
      providesTags: ['AutoRenewal'],
    }),
    /** "Cancel" on this page (ADR-0061 § 6): the paid period runs to its end. */
    disableAutoRenewal: build.mutation<void, void>({
      query: () => ({ url: '/masters/me/subscription/auto-renewal', method: 'DELETE' }),
      invalidatesTags: ['AutoRenewal', 'Subscription'],
    }),
    startCheckout: build.mutation<SubscriptionCheckout, StartSubscriptionCheckoutRequest>({
      query: (body) => ({ url: '/masters/me/subscription/checkout', method: 'POST', body }),
    }),
  }),
});

export const {
  useRequestCodeMutation,
  useVerifyCodeMutation,
  useSignOutMutation,
  useOfferQuery,
  useMySubscriptionQuery,
  useAutoRenewalQuery,
  useDisableAutoRenewalMutation,
  useStartCheckoutMutation,
} = webApi;
