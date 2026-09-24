import type { MasterVerificationStatus } from '@tezusta/types';
import { Link, useSearchParams } from 'react-router';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useListMastersInfiniteQuery } from './api';
import { mastersCopy } from './copy';
import { MasterStatusBadge } from './MasterStatusBadge';

/** The filter tabs, the review queue first — it is what the page is opened for. */
const FILTERS: readonly (MasterVerificationStatus | 'all')[] = [
  'pending_verification',
  'changes_requested',
  'active',
  'suspended',
  'rejected',
  'all',
];

const DEFAULT_FILTER = 'pending_verification';

function isFilter(value: string | null): value is MasterVerificationStatus | 'all' {
  return value !== null && (FILTERS as readonly string[]).includes(value);
}

/**
 * The master list (#248). The filter lives in the URL (`?status=`), so the
 * back button from a master's file returns to the same tab.
 */
export function MastersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('status');
  const filter = isFilter(requested) ? requested : DEFAULT_FILTER;

  const {
    data,
    error,
    isLoading,
    isFetching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useListMastersInfiniteQuery({ status: filter === 'all' ? undefined : filter });
  const masters = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PageFrame title={mastersCopy.title}>
      <div role="tablist" aria-label={mastersCopy.filterLabel} className="flex flex-wrap gap-2">
        {FILTERS.map((option) => {
          const selected = option === filter;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setSearchParams(option === DEFAULT_FILTER ? {} : { status: option })}
              className={`rounded-full px-4 py-2 text-caption outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                selected
                  ? 'bg-inverse-surface font-bold text-on-inverse'
                  : 'border-hairline border-border bg-surface text-text hover:bg-surface-alt'
              }`}
            >
              {option === 'all' ? mastersCopy.allStatuses : mastersCopy.status[option]}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p role="status" className="text-body text-text-muted">
          {mastersCopy.loading}
        </p>
      ) : error !== undefined && data === undefined ? (
        <div className="flex flex-col items-start gap-3">
          <Banner tone="danger" message={mastersCopy.loadFailed} />
          <Button label={mastersCopy.retry} variant="secondary" onClick={() => void refetch()} />
        </div>
      ) : masters.length === 0 ? (
        <p className="text-body text-text-muted">{mastersCopy.empty}</p>
      ) : (
        <Table caption={mastersCopy.tableCaption}>
          <thead>
            <tr>
              <th scope="col" className={TH_CLASS}>
                {mastersCopy.columns.name}
              </th>
              <th scope="col" className={TH_CLASS}>
                {mastersCopy.columns.status}
              </th>
              <th scope="col" className={TH_CLASS}>
                {mastersCopy.columns.available}
              </th>
              <th scope="col" className={TH_CLASS}>
                {mastersCopy.columns.ratings}
              </th>
              <th scope="col" className={TH_CLASS}>
                {mastersCopy.columns.joined}
              </th>
            </tr>
          </thead>
          <tbody aria-busy={isFetching || undefined}>
            {masters.map((master) => (
              <tr key={master.id} className="hover:bg-surface-alt">
                <td className={TD_CLASS}>
                  <Link
                    to={`/masters/${master.id}`}
                    className="font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {master.displayName}
                  </Link>
                </td>
                <td className={TD_CLASS}>
                  <MasterStatusBadge status={master.verificationStatus} />
                </td>
                <td className={TD_CLASS}>
                  {master.isAvailable ? mastersCopy.yes : mastersCopy.no}
                </td>
                <td className={TD_CLASS}>{master.ratingCount}</td>
                <td className={TD_CLASS}>{formatDateTime(master.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {hasNextPage && (
        <div>
          <Button
            label={mastersCopy.loadMore}
            loadingLabel={mastersCopy.loadingMore}
            loading={isFetchingNextPage}
            variant="secondary"
            onClick={() => void fetchNextPage()}
          />
        </div>
      )}
    </PageFrame>
  );
}
