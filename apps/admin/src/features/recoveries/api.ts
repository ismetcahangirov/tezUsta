import type {
  AdminAccountRecovery,
  AdminAccountRecoveryEmails,
  AdminAccountRecoveryOpenRequest,
  AdminAccountRecoveryPhoto,
  AdminAccountRecoveryPhotoDownload,
  AdminAccountRecoveryPhotoPresignRequest,
  AdminAccountRecoveryPhotoUpload,
} from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

export interface RecoveryReasonArg {
  readonly id: string;
  readonly reason: string;
}

export interface RecoveryCodeArg {
  readonly id: string;
  readonly code: string;
}

export interface RecoveryPhotoArg {
  readonly id: string;
  readonly photoId: string;
}

const LIST = { type: 'AccountRecovery', id: 'LIST' } as const;
const id = encodeURIComponent;

function invalidates(_result: unknown, _error: unknown, arg: { readonly id: string }) {
  return [{ type: 'AccountRecovery' as const, id: arg.id }, LIST];
}

/**
 * `/admin/account-recoveries` (#515, #517, ADR-0074 §§ 2–3). Every step
 * answers with the request as it now stands, and invalidates it and the list.
 * An approval moves an account's address, so it also invalidates the customer
 * and master files, which show the masked address.
 */
export const recoveriesApi = adminApi
  .enhanceEndpoints({
    addTagTypes: ['AccountRecovery', 'AccountRecoveryPhotos', 'Customer', 'Master'],
  })
  .injectEndpoints({
    endpoints: (build) => ({
      listRecoveries: build.query<AdminAccountRecovery[], void>({
        query: () => '/admin/account-recoveries',
        providesTags: [LIST],
      }),
      recovery: build.query<AdminAccountRecovery, string>({
        query: (recoveryId) => `/admin/account-recoveries/${id(recoveryId)}`,
        providesTags: (_result, _error, recoveryId) => [
          { type: 'AccountRecovery', id: recoveryId },
        ],
      }),
      openRecovery: build.mutation<AdminAccountRecovery, AdminAccountRecoveryOpenRequest>({
        query: (body) => ({ url: '/admin/account-recoveries', method: 'POST', body }),
        invalidatesTags: [LIST],
      }),
      resendRecoveryCode: build.mutation<AdminAccountRecovery, { readonly id: string }>({
        query: (arg) => ({ url: `/admin/account-recoveries/${id(arg.id)}/code`, method: 'POST' }),
        invalidatesTags: invalidates,
      }),
      verifyRecovery: build.mutation<AdminAccountRecovery, RecoveryCodeArg>({
        query: (arg) => ({
          url: `/admin/account-recoveries/${id(arg.id)}/verify`,
          method: 'POST',
          body: { code: arg.code },
        }),
        invalidatesTags: invalidates,
      }),
      cancelRecovery: build.mutation<AdminAccountRecovery, RecoveryReasonArg>({
        query: (arg) => ({
          url: `/admin/account-recoveries/${id(arg.id)}/cancel`,
          method: 'POST',
          body: { reason: arg.reason },
        }),
        invalidatesTags: invalidates,
      }),
      approveRecovery: build.mutation<AdminAccountRecovery, RecoveryReasonArg>({
        query: (arg) => ({
          url: `/admin/account-recoveries/${id(arg.id)}/approve`,
          method: 'POST',
          body: { reason: arg.reason },
        }),
        invalidatesTags: (result, error, arg) => [
          ...invalidates(result, error, arg),
          ...(result?.customerId == null
            ? []
            : [{ type: 'Customer' as const, id: result.customerId }]),
          ...(result?.masterId == null ? [] : [{ type: 'Master' as const, id: result.masterId }]),
        ],
      }),
      /** Dispatched with `track: false`: the addresses live only in the dialog that shows them. */
      revealRecoveryEmails: build.mutation<AdminAccountRecoveryEmails, RecoveryReasonArg>({
        query: (arg) => ({
          url: `/admin/account-recoveries/${id(arg.id)}/emails`,
          method: 'POST',
          body: { reason: arg.reason },
        }),
      }),
      /** The stored evidence photos of a master's request (#524): facts only, no links. */
      recoveryPhotos: build.query<AdminAccountRecoveryPhoto[], string>({
        query: (recoveryId) => `/admin/account-recoveries/${id(recoveryId)}/photos`,
        providesTags: (_result, _error, recoveryId) => [
          { type: 'AccountRecoveryPhotos', id: recoveryId },
        ],
      }),
      presignRecoveryPhoto: build.mutation<
        AdminAccountRecoveryPhotoUpload,
        AdminAccountRecoveryPhotoPresignRequest & { readonly id: string }
      >({
        query: ({ id: recoveryId, ...body }) => ({
          url: `/admin/account-recoveries/${id(recoveryId)}/photos`,
          method: 'POST',
          body,
        }),
      }),
      confirmRecoveryPhoto: build.mutation<AdminAccountRecoveryPhoto, RecoveryPhotoArg>({
        query: (arg) => ({
          url: `/admin/account-recoveries/${id(arg.id)}/photos/${id(arg.photoId)}/confirm`,
          method: 'POST',
        }),
        // A refusal deleted the bytes, so the list is read again either way.
        invalidatesTags: (_result, _error, arg) => [{ type: 'AccountRecoveryPhotos', id: arg.id }],
      }),
      /**
       * A mutation although it is a GET, as for master documents: each call is
       * an audited read minting a fresh URL. Dispatched with `track: false`.
       */
      recoveryPhotoDownload: build.mutation<AdminAccountRecoveryPhotoDownload, RecoveryPhotoArg>({
        query: (arg) => ({
          url: `/admin/account-recoveries/${id(arg.id)}/photos/${id(arg.photoId)}/download`,
          method: 'GET',
        }),
      }),
    }),
  });

export const {
  useListRecoveriesQuery,
  useRecoveryQuery,
  useOpenRecoveryMutation,
  useResendRecoveryCodeMutation,
  useVerifyRecoveryMutation,
  useCancelRecoveryMutation,
  useApproveRecoveryMutation,
  useRecoveryPhotosQuery,
  usePresignRecoveryPhotoMutation,
  useConfirmRecoveryPhotoMutation,
} = recoveriesApi;
