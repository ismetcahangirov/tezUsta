import type { ReportReasonCode, ReportStatus } from '@tezusta/types';
import { Link, useSearchParams } from 'react-router';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { SelectField } from '../../components/SelectField';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useListReportsInfiniteQuery } from './api';
import { reportsCopy } from './copy';

const STATUSES = Object.keys(reportsCopy.status) as ReportStatus[];
const REASONS = Object.keys(reportsCopy.reason) as ReportReasonCode[];

/** The open queue by default: it is what the page is opened for. */
const DEFAULT_STATUS: ReportStatus = 'open';

function isStatus(value: string | null): value is ReportStatus {
  return value !== null && (STATUSES as readonly string[]).includes(value);
}

function isReason(value: string | null): value is ReportReasonCode {
  return value !== null && (REASONS as readonly string[]).includes(value);
}

/**
 * The report queue (#330), oldest first. Both filters live in the URL, so the
 * back button from a report returns to the same queue. `?status=all` shows
 * every status.
 */
export function ReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedStatus = searchParams.get('status');
  const status =
    requestedStatus === 'all'
      ? undefined
      : isStatus(requestedStatus)
        ? requestedStatus
        : DEFAULT_STATUS;
  const requestedReason = searchParams.get('reason');
  const reason = isReason(requestedReason) ? requestedReason : undefined;

  function setFilters(next: { status?: string; reason?: string }) {
    const params: Record<string, string> = {};
    const nextStatus = next.status ?? requestedStatus ?? DEFAULT_STATUS;
    if (nextStatus !== DEFAULT_STATUS) params.status = nextStatus;
    const nextReason = 'reason' in next ? next.reason : reason;
    if (nextReason !== undefined && nextReason !== '') params.reason = nextReason;
    setSearchParams(params);
  }

  const { data, error, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
    useListReportsInfiniteQuery({ status, reason });
  const reports = data?.pages.flatMap((page) => page.items) ?? [];
  const columns = reportsCopy.columns;

  return (
    <PageFrame title={reportsCopy.title}>
      <div className="flex max-w-2xl gap-4">
        <SelectField
          label={reportsCopy.statusFilter}
          value={status ?? 'all'}
          options={[
            ...STATUSES.map((option) => ({ value: option, label: reportsCopy.status[option] })),
            { value: 'all', label: reportsCopy.anyStatus },
          ]}
          onChange={(event) => setFilters({ status: event.target.value })}
        />
        <SelectField
          label={reportsCopy.reasonFilter}
          value={reason ?? ''}
          options={[
            { value: '', label: reportsCopy.anyReason },
            ...REASONS.map((option) => ({ value: option, label: reportsCopy.reason[option] })),
          ]}
          onChange={(event) => setFilters({ reason: event.target.value })}
        />
      </div>

      {isLoading ? (
        <p role="status" className="text-body text-text-muted">
          {reportsCopy.loading}
        </p>
      ) : error !== undefined && data === undefined ? (
        <div className="flex flex-col items-start gap-3">
          <Banner tone="danger" message={reportsCopy.loadFailed} />
          <Button label={reportsCopy.retry} variant="secondary" onClick={() => void refetch()} />
        </div>
      ) : reports.length === 0 ? (
        <p className="text-body text-text-muted">{reportsCopy.empty}</p>
      ) : (
        <Table caption={reportsCopy.tableCaption}>
          <thead>
            <tr>
              {[
                columns.filed,
                columns.reason,
                columns.reporter,
                columns.reported,
                columns.status,
                columns.open,
              ].map((column) => (
                <th key={column} scope="col" className={TH_CLASS}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => (
              <tr key={report.id} className="hover:bg-surface-alt">
                <td className={`${TD_CLASS} whitespace-nowrap`}>
                  {formatDateTime(report.createdAt)}
                </td>
                <td className={TD_CLASS}>{reportsCopy.reason[report.reasonCode]}</td>
                <td className={TD_CLASS}>
                  {report.reporter.displayName}
                  <span className="block text-caption text-text-muted">
                    {reportsCopy.role[report.reporter.role]}
                  </span>
                </td>
                <td className={TD_CLASS}>
                  {report.reported.displayName}
                  <span className="block text-caption text-text-muted">
                    {reportsCopy.role[report.reported.role]}
                  </span>
                </td>
                <td className={TD_CLASS}>{reportsCopy.status[report.status]}</td>
                <td className={TD_CLASS}>
                  <Link
                    to={`/reports/${report.id}`}
                    aria-label={`${reportsCopy.view}: ${reportsCopy.reason[report.reasonCode]}, ${report.reported.displayName}`}
                    className="font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {reportsCopy.view}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {hasNextPage && (
        <div>
          <Button
            label={reportsCopy.loadMore}
            loadingLabel={reportsCopy.loadingMore}
            loading={isFetchingNextPage}
            variant="secondary"
            onClick={() => void fetchNextPage()}
          />
        </div>
      )}
    </PageFrame>
  );
}
