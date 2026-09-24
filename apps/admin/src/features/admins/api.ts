import type { AdminAccount, AdminInvitationIssued, AdminRole } from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

export interface InviteAdminBody {
  readonly email: string;
  readonly displayName: string;
  readonly roles: readonly AdminRole[];
}

interface WithReason {
  readonly id: string;
  readonly reason: string;
}

/**
 * Admin management (#242's API, `admins.manage`). Every write invalidates
 * the `Admins` tag.
 *
 * The invitation and reset answers carry a one-time **setup link**. They are
 * mutations, so RTK Query keeps no cache entry for them once the component
 * that sent them lets go — and the dialogs call `reset()` as soon as they have
 * read the link, so it is not left in the store even while they are open.
 */
export const adminsApi = adminApi.enhanceEndpoints({ addTagTypes: ['Admins'] }).injectEndpoints({
  endpoints: (build) => ({
    admins: build.query<AdminAccount[], void>({
      query: () => '/admin/admins',
      providesTags: ['Admins'],
    }),
    inviteAdmin: build.mutation<AdminInvitationIssued, InviteAdminBody>({
      query: (body) => ({ url: '/admin/admins', method: 'POST', body }),
      invalidatesTags: ['Admins'],
    }),
    disableAdmin: build.mutation<AdminAccount, WithReason>({
      query: ({ id, reason }) => ({
        url: `/admin/admins/${encodeURIComponent(id)}/disable`,
        method: 'POST',
        body: { reason },
      }),
      invalidatesTags: ['Admins'],
    }),
    enableAdmin: build.mutation<AdminAccount, WithReason>({
      query: ({ id, reason }) => ({
        url: `/admin/admins/${encodeURIComponent(id)}/enable`,
        method: 'POST',
        body: { reason },
      }),
      invalidatesTags: ['Admins'],
    }),
    setAdminRoles: build.mutation<
      AdminAccount,
      WithReason & { readonly roles: readonly AdminRole[] }
    >({
      query: ({ id, roles, reason }) => ({
        url: `/admin/admins/${encodeURIComponent(id)}/roles`,
        method: 'PUT',
        body: { roles, reason },
      }),
      invalidatesTags: ['Admins'],
    }),
    resetSecondFactor: build.mutation<AdminInvitationIssued, WithReason>({
      query: ({ id, reason }) => ({
        url: `/admin/admins/${encodeURIComponent(id)}/reset-second-factor`,
        method: 'POST',
        body: { reason },
      }),
      invalidatesTags: ['Admins'],
    }),
  }),
});

export const {
  useAdminsQuery,
  useInviteAdminMutation,
  useDisableAdminMutation,
  useEnableAdminMutation,
  useSetAdminRolesMutation,
  useResetSecondFactorMutation,
} = adminsApi;
