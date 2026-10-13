import type { OwnReport, ReportableParty, SubmitReportRequest } from '@tezusta/types';

import { api } from '../api/api-slice';

export interface SubmitReportArg extends SubmitReportRequest {
  readonly orderId: string;
}

/**
 * Reports about the other party on one order (#330, ADR-0053). Everything the
 * entry and the form show comes from `GET /orders/:id/reports/parties`: who
 * may be reported, whether that is still possible, and the caller's own
 * report about each. A submit or an edit invalidates it.
 */
export const reportsApi = api.injectEndpoints({
  endpoints: (build) => ({
    reportParties: build.query<readonly ReportableParty[], string>({
      query: (orderId) => `/orders/${orderId}/reports/parties`,
      providesTags: (_result, _error, orderId) => [{ type: 'Report', id: orderId }],
    }),

    submitReport: build.mutation<OwnReport, SubmitReportArg>({
      query: ({ orderId, reasonCode, text, masterId }) => ({
        url: `/orders/${orderId}/reports`,
        method: 'POST',
        body: { reasonCode, text: text ?? null, ...(masterId === undefined ? {} : { masterId }) },
      }),
      invalidatesTags: (_result, _error, { orderId }) => [{ type: 'Report', id: orderId }],
    }),

    editReport: build.mutation<OwnReport, SubmitReportArg>({
      query: ({ orderId, reasonCode, text, masterId }) => ({
        url: `/orders/${orderId}/reports/mine`,
        method: 'PUT',
        body: { reasonCode, text: text ?? null, ...(masterId === undefined ? {} : { masterId }) },
      }),
      invalidatesTags: (_result, _error, { orderId }) => [{ type: 'Report', id: orderId }],
    }),
  }),
});

export const { useReportPartiesQuery, useSubmitReportMutation, useEditReportMutation } = reportsApi;
