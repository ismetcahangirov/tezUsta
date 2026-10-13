import type { AdminAccountStatus } from '@tezusta/types';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { TextField } from '../../components/TextField';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useListCustomersInfiniteQuery } from './api';
import { customersCopy } from './copy';
import { CustomerStatusBadge } from './CustomerStatusBadge';

const FILTERS: readonly (AdminAccountStatus | 'all')[] = ['all', 'active', 'suspended', 'deleted'];

function isFilter(value: string | null): value is AdminAccountStatus | 'all' {
  return value !== null && (FILTERS as readonly string[]).includes(value);
}

/**
 * The customer list (#328). The search and the filter live in the URL
 * (`?q=`, `?status=`), so the back button from a customer's file returns to
 * the same results.
 */
export function CustomersPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('status');
  const filter = isFilter(requested) ? requested : 'all';
  const q = searchParams.get('q')?.trim() || undefined;
  const [draft, setDraft] = useState(q ?? '');
  // Back and forward change `q` under the page; the box follows the URL.
  useEffect(() => {
    setDraft(q ?? '');
  }, [q]);

  function setParams(next: { q?: string | undefined; status?: string }) {
    const params: Record<string, string> = {};
    const query = 'q' in next ? next.q : q;
    if (query !== undefined && query !== '') params.q = query;
    const status = next.status ?? filter;
    if (status !== 'all') params.status = status;
    setSearchParams(params);
  }

  const {
    data,
    error,
    isLoading,
    isFetching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useListCustomersInfiniteQuery({ q, status: filter === 'all' ? undefined : filter });
  const customers = data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <PageFrame title={customersCopy.title}>
      <form
        role="search"
        className="flex max-w-xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setParams({ q: draft.trim() });
        }}
      >
        <TextField
          label={customersCopy.searchLabel}
          hint={customersCopy.searchHint}
          value={draft}
          maxLength={80}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex gap-2">
          <Button type="submit" label={customersCopy.search} />
          {q !== undefined && (
            <Button
              label={customersCopy.clear}
              variant="secondary"
              onClick={() => {
                setDraft('');
                setParams({ q: undefined });
              }}
            />
          )}
        </div>
      </form>

      <div role="tablist" aria-label={customersCopy.filterLabel} className="flex flex-wrap gap-2">
        {FILTERS.map((option) => {
          const selected = option === filter;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setParams({ status: option })}
              className={`rounded-full px-4 py-2 text-caption outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                selected
                  ? 'bg-inverse-surface font-bold text-on-inverse'
                  : 'border-hairline border-border bg-surface text-text hover:bg-surface-alt'
              }`}
            >
              {option === 'all' ? customersCopy.allStatuses : customersCopy.status[option]}
            </button>
          );
        })}
      </div>

      {isLoading ? (
        <p role="status" className="text-body text-text-muted">
          {customersCopy.loading}
        </p>
      ) : error !== undefined && data === undefined ? (
        <div className="flex flex-col items-start gap-3">
          <Banner tone="danger" message={customersCopy.loadFailed} />
          <Button label={customersCopy.retry} variant="secondary" onClick={() => void refetch()} />
        </div>
      ) : customers.length === 0 ? (
        <p className="text-body text-text-muted">{customersCopy.empty}</p>
      ) : (
        <Table caption={customersCopy.tableCaption}>
          <thead>
            <tr>
              {Object.values(customersCopy.columns).map((column) => (
                <th key={column} scope="col" className={TH_CLASS}>
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody aria-busy={isFetching || undefined}>
            {customers.map((customer) => (
              <tr key={customer.id} className="hover:bg-surface-alt">
                <td className={TD_CLASS}>
                  <Link
                    to={`/customers/${customer.id}`}
                    className="font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {customer.displayName}
                  </Link>
                </td>
                <td className={`${TD_CLASS} whitespace-nowrap`}>{customer.phoneMasked}</td>
                <td className={TD_CLASS}>
                  <CustomerStatusBadge status={customer.status} />
                </td>
                <td className={TD_CLASS}>{customer.orderCount}</td>
                <td className={`${TD_CLASS} whitespace-nowrap`}>
                  {customer.lastOrderAt === null
                    ? customersCopy.none
                    : formatDateTime(customer.lastOrderAt)}
                </td>
                <td className={`${TD_CLASS} whitespace-nowrap`}>
                  {formatDateTime(customer.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {hasNextPage && (
        <div>
          <Button
            label={customersCopy.loadMore}
            loadingLabel={customersCopy.loadingMore}
            loading={isFetchingNextPage}
            variant="secondary"
            onClick={() => void fetchNextPage()}
          />
        </div>
      )}
    </PageFrame>
  );
}
