import { createApi } from '@reduxjs/toolkit/query/react';
import type {
  AdminMe,
  AdminSetupCompleteRequest,
  AdminSetupStart,
  AdminSetupStartRequest,
  AdminSignInRequest,
} from '@tezusta/types';

import { adminBaseQuery } from './base-query';

/**
 * The admin panel's one API slice. Later screens (#248–#251) inject their
 * endpoints into it rather than creating a second slice, so they share the
 * cache, the CSRF header and the refresh-on-401 behaviour.
 */
export const adminApi = createApi({
  reducerPath: 'adminApi',
  baseQuery: adminBaseQuery,
  tagTypes: ['Me'],
  endpoints: (build) => ({
    me: build.query<AdminMe, void>({
      query: () => '/admin/me',
      providesTags: ['Me'],
    }),
    signIn: build.mutation<AdminMe, AdminSignInRequest>({
      query: (body) => ({ url: '/admin/auth/sign-in', method: 'POST', body }),
      // Sign-in answers with the admin, so the shell opens without a second
      // round-trip for `/admin/me`.
      async onQueryStarted(_body, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          await dispatch(adminApi.util.upsertQueryData('me', undefined, data));
        } catch {
          // The component renders the failure from the mutation's own state.
        }
      },
    }),
    signOut: build.mutation<void, void>({
      query: () => ({ url: '/admin/auth/sign-out', method: 'POST' }),
    }),
    setupStart: build.mutation<AdminSetupStart, AdminSetupStartRequest>({
      query: (body) => ({ url: '/admin/auth/setup/start', method: 'POST', body }),
    }),
    setupComplete: build.mutation<void, AdminSetupCompleteRequest>({
      query: (body) => ({ url: '/admin/auth/setup/complete', method: 'POST', body }),
    }),
  }),
});

export const {
  useMeQuery,
  useSignInMutation,
  useSignOutMutation,
  useSetupStartMutation,
  useSetupCompleteMutation,
} = adminApi;
