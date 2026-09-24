import type { AdminDashboard } from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

export interface DashboardRange {
  /** ISO 8601 instants; the API reads `[from, to)` and refuses more than 90 days. */
  readonly from: string;
  readonly to: string;
}

/** `GET /admin/dashboard` (issue #246, `dashboard.read`). */
export const dashboardApi = adminApi.injectEndpoints({
  endpoints: (build) => ({
    dashboard: build.query<AdminDashboard, DashboardRange>({
      query: ({ from, to }) => ({ url: '/admin/dashboard', params: { from, to } }),
    }),
  }),
});

export const { useDashboardQuery } = dashboardApi;
