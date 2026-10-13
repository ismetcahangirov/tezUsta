import type {
  AdminReportCloseRequest,
  AdminReportDetail,
  AdminReportSummary,
  CursorPage,
  ReportReasonCode,
  ReportStatus,
} from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

export interface ReportListArg {
  readonly status: ReportStatus | undefined;
  readonly reason: ReportReasonCode | undefined;
}

const LIST = { type: 'Report', id: 'LIST' } as const;
const id = encodeURIComponent;

/**
 * `/admin/reports` (#330, ADR-0053). Claiming and closing invalidate the
 * report and the queue.
 */
export const reportsApi = adminApi.enhanceEndpoints({ addTagTypes: ['Report'] }).injectEndpoints({
  endpoints: (build) => ({
    listReports: build.infiniteQuery<CursorPage<AdminReportSummary>, ReportListArg, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
      query: ({ queryArg, pageParam }) => ({
        url: '/admin/reports',
        params: {
          status: queryArg.status,
          reason: queryArg.reason,
          cursor: pageParam ?? undefined,
        },
      }),
      providesTags: [LIST],
    }),
    reportDetail: build.query<AdminReportDetail, string>({
      query: (reportId) => `/admin/reports/${id(reportId)}`,
      providesTags: (_result, _error, reportId) => [{ type: 'Report', id: reportId }],
    }),
    claimReport: build.mutation<void, string>({
      query: (reportId) => ({
        url: `/admin/reports/${id(reportId)}/claim`,
        method: 'POST',
        body: {},
      }),
      invalidatesTags: (_result, _error, reportId) => [{ type: 'Report', id: reportId }, LIST],
    }),
    closeReport: build.mutation<void, AdminReportCloseRequest & { readonly reportId: string }>({
      query: ({ reportId, outcome, reason }) => ({
        url: `/admin/reports/${id(reportId)}/close`,
        method: 'POST',
        body: { outcome, reason },
      }),
      invalidatesTags: (_result, _error, { reportId }) => [{ type: 'Report', id: reportId }, LIST],
    }),
  }),
});

export const {
  useListReportsInfiniteQuery,
  useReportDetailQuery,
  useClaimReportMutation,
  useCloseReportMutation,
} = reportsApi;
