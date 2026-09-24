import type { AdminAuditEntry, CursorPage } from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

/** The filters `GET /admin/audit-log` accepts; each optional, combined with AND. */
export interface AuditFilters {
  readonly actorId?: string;
  readonly targetType?: string;
  readonly targetId?: string;
  /** A prefix on whole dot-separated segments: `master` matches `master.verify`. */
  readonly action?: string;
  /** ISO 8601 instants. */
  readonly from?: string;
  readonly to?: string;
}

export const AUDIT_PAGE_SIZE = 50;

/** The audit log (#243, `audit.read`), newest first, one cursor page per "Load more". */
export const auditApi = adminApi.injectEndpoints({
  endpoints: (build) => ({
    auditLog: build.infiniteQuery<CursorPage<AdminAuditEntry>, AuditFilters, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor,
      },
      query: ({ queryArg, pageParam }) => ({
        url: '/admin/audit-log',
        params: {
          ...queryArg,
          limit: AUDIT_PAGE_SIZE,
          ...(pageParam === null ? {} : { cursor: pageParam }),
        },
      }),
    }),
  }),
});

export const { useAuditLogInfiniteQuery } = auditApi;
