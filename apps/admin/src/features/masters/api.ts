import type {
  AdminMasterDetail,
  AdminMasterDocumentDownload,
  AdminMasterSummary,
  CursorPage,
  MasterVerificationStatus,
} from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

/** The five review decisions, named as the API's routes name them. */
export type MasterAction = 'verify' | 'reject' | 'request-more' | 'suspend' | 'reinstate';

export interface MasterListArg {
  /** Absent means every status. */
  readonly status: MasterVerificationStatus | undefined;
}

export interface MasterActionArg {
  readonly masterId: string;
  readonly action: MasterAction;
  /** Required by `reject`, `request-more` and `suspend`; never sent to the other two. */
  readonly reason?: string;
}

export interface MasterDocumentArg {
  readonly masterId: string;
  readonly documentId: string;
}

const LIST = { type: 'Master', id: 'LIST' } as const;

/**
 * `/admin/masters` (ADR-0023, ADR-0043 § 1). Every review action invalidates
 * the master and the list, so both screens show the server's answer rather
 * than a status the panel assumed.
 */
export const mastersApi = adminApi.enhanceEndpoints({ addTagTypes: ['Master'] }).injectEndpoints({
  endpoints: (build) => ({
    listMasters: build.infiniteQuery<CursorPage<AdminMasterSummary>, MasterListArg, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
      query: ({ queryArg, pageParam }) => ({
        url: '/admin/masters',
        params: { status: queryArg.status, cursor: pageParam ?? undefined },
      }),
      providesTags: [LIST],
    }),
    masterDetail: build.query<AdminMasterDetail, string>({
      query: (masterId) => `/admin/masters/${encodeURIComponent(masterId)}`,
      providesTags: (_result, _error, masterId) => [{ type: 'Master', id: masterId }],
    }),
    /**
     * A mutation, not a query, although it is a GET: every call is an audited
     * read that mints a fresh short-lived URL, and a cached one would be both
     * stale and unaudited. Callers dispatch it with `track: false`, so the URL
     * never lands in the store.
     */
    masterDocumentDownload: build.mutation<AdminMasterDocumentDownload, MasterDocumentArg>({
      query: ({ masterId, documentId }) => ({
        url: `/admin/masters/${encodeURIComponent(masterId)}/documents/${encodeURIComponent(documentId)}/download`,
        method: 'GET',
      }),
    }),
    masterAction: build.mutation<AdminMasterSummary, MasterActionArg>({
      query: ({ masterId, action, reason }) => ({
        url: `/admin/masters/${encodeURIComponent(masterId)}/${action}`,
        method: 'POST',
        // `verify` and `reinstate` take a strict empty object: a reason sent
        // there is refused, not silently dropped.
        body: reason === undefined ? {} : { reason },
      }),
      invalidatesTags: (_result, _error, { masterId }) => [{ type: 'Master', id: masterId }, LIST],
    }),
  }),
});

export const { useListMastersInfiniteQuery, useMasterDetailQuery, useMasterActionMutation } =
  mastersApi;
