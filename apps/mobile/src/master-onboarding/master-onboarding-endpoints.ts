import type {
  Master,
  MasterDocument,
  MasterDocumentType,
  MasterDocumentUpload,
  MasterVerificationSubmission,
} from '@tezusta/types';

import { api } from '../api/api-slice';

export interface CreateMasterBody {
  readonly displayName: string;
  readonly bio?: string;
}

/**
 * The endpoints a person uses to become a master (#490, ADR-0073), all of
 * which the API has served since EPIC 5 (#38, #39) and no screen called.
 *
 * **`createMasterProfile` is idempotent server-side**: `POST /masters` answers
 * 201 for a new profile and 200 for one that already existed, and grants the
 * `master` role in the same transaction. The grant reaches the server's guards
 * at once, because they re-read `user_roles` on every request; it reaches this
 * app's token only at the next refresh, which `useBecomeMaster` asks for.
 *
 * **Documents follow ADR-0024's presigned path**: presign with the document
 * type and content type, `PUT` the bytes straight to storage, then confirm, at
 * which point the server checks the real bytes. Only the confirm invalidates
 * the list: a presigned row is `awaiting_upload` and not yet worth redrawing.
 */
export const masterOnboardingApi = api.injectEndpoints({
  endpoints: (build) => ({
    createMasterProfile: build.mutation<Master, CreateMasterBody>({
      query: (body) => ({ url: '/masters', method: 'POST', body }),
      invalidatesTags: (_result, error) => (error ? [] : [{ type: 'OwnMaster', id: 'ME' }]),
    }),

    ownDocuments: build.query<readonly MasterDocument[], void>({
      query: () => '/masters/me/documents',
      providesTags: [{ type: 'MasterDocument', id: 'LIST' }],
    }),

    presignDocument: build.mutation<
      MasterDocumentUpload,
      { documentType: MasterDocumentType; contentType: string }
    >({
      query: (body) => ({ url: '/masters/me/documents/presign', method: 'POST', body }),
    }),

    confirmDocument: build.mutation<MasterDocument, string>({
      query: (documentId) => ({
        url: `/masters/me/documents/${documentId}/confirm`,
        method: 'POST',
        body: {},
      }),
      invalidatesTags: (_result, error) => (error ? [] : [{ type: 'MasterDocument', id: 'LIST' }]),
    }),

    submitVerification: build.mutation<MasterVerificationSubmission, void>({
      query: () => ({ url: '/masters/me/verification/submit', method: 'POST', body: {} }),
      invalidatesTags: (_result, error) =>
        error
          ? []
          : [
              { type: 'OwnMaster', id: 'ME' },
              { type: 'MasterDocument', id: 'LIST' },
            ],
    }),
  }),
});

export const {
  useConfirmDocumentMutation,
  useCreateMasterProfileMutation,
  useOwnDocumentsQuery,
  usePresignDocumentMutation,
  useSubmitVerificationMutation,
} = masterOnboardingApi;
