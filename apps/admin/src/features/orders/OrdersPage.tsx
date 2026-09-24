import type { OrderStatus } from '@tezusta/types';
import { useId } from 'react';
import { useSearchParams } from 'react-router';

import { Button } from '../../components/Button';
import { PageFrame } from '../../shell/PageFrame';
import { useListOrdersInfiniteQuery } from './api';
import { ordersCopy } from './copy';
import { OrdersTable } from './OrdersTable';
import { FILTERABLE_STATUSES } from './rules';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` from a date input, or undefined if it is not one. */
function day(value: string | null): string | undefined {
  return value !== null && DAY.test(value) ? value : undefined;
}

/**
 * The start of a calendar day in the admin's own time zone, as an ISO
 * instant. `to` asks for the start of the day *after* the chosen one, because
 * the API's upper bound is exclusive and an admin picking "to 24 September"
 * means the whole of that day.
 */
function startOfDay(value: string, plusDays = 0): string {
  const [year = 0, month = 1, date = 1] = value.split('-').map(Number);
  return new Date(year, month - 1, date + plusDays).toISOString();
}

function readStatuses(value: string | null): OrderStatus[] {
  if (value === null) return [];
  return value
    .split(',')
    .filter((part): part is OrderStatus =>
      (FILTERABLE_STATUSES as readonly string[]).includes(part),
    );
}

/**
 * Every order (#249), filtered by status, by "stuck", and by creation date.
 * The filters live in the URL, so a filtered view survives opening an order
 * and coming back, and can be pasted to a colleague.
 */
export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const statuses = readStatuses(params.get('status'));
  const stuck = params.get('stuck') === 'true';
  const fromDay = day(params.get('from'));
  const toDay = day(params.get('to'));

  const query = useListOrdersInfiniteQuery({
    statuses,
    stuck,
    from: fromDay === undefined ? undefined : startOfDay(fromDay),
    to: toDay === undefined ? undefined : startOfDay(toDay, 1),
  });

  function update(key: string, value: string | undefined) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === undefined || value === '') next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  function toggleStatus(status: OrderStatus) {
    const next = statuses.includes(status)
      ? statuses.filter((s) => s !== status)
      : FILTERABLE_STATUSES.filter((s) => s === status || statuses.includes(s));
    update('status', next.join(','));
  }

  const statusGroupId = useId();
  const filtered = statuses.length > 0 || stuck || fromDay !== undefined || toDay !== undefined;

  return (
    <PageFrame title={ordersCopy.ordersTitle}>
      <section
        aria-label={ordersCopy.filters}
        className="flex flex-col gap-4 rounded-md border-hairline border-border bg-surface p-4"
      >
        <fieldset className="flex flex-col gap-2">
          <legend id={statusGroupId} className="pb-2 text-caption text-text-muted">
            {ordersCopy.statusFilter}
          </legend>
          <div className="flex flex-wrap gap-2">
            {FILTERABLE_STATUSES.map((status) => {
              const checked = statuses.includes(status);
              return (
                <label
                  key={status}
                  className={`flex cursor-pointer items-center gap-2 rounded-full px-3 py-1 text-caption focus-within:ring-2 focus-within:ring-focus ${
                    checked
                      ? 'bg-inverse-surface font-bold text-on-inverse'
                      : 'border-hairline border-border bg-surface text-text hover:bg-surface-alt'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    onChange={() => toggleStatus(status)}
                  />
                  {ordersCopy.status[status]}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex flex-wrap items-end gap-6">
          <label className="flex items-center gap-2 text-body text-text">
            <input
              type="checkbox"
              checked={stuck}
              onChange={(event) => update('stuck', event.target.checked ? 'true' : undefined)}
              className="h-4 w-4 accent-accent"
              aria-describedby={`${statusGroupId}-stuck`}
            />
            {ordersCopy.stuck}
          </label>
          <DateInput label={ordersCopy.from} value={fromDay} onChange={(v) => update('from', v)} />
          <DateInput label={ordersCopy.to} value={toDay} onChange={(v) => update('to', v)} />
          {filtered && (
            <Button label={ordersCopy.clearFilters} variant="ghost" onClick={() => setParams({})} />
          )}
        </div>
        <p id={`${statusGroupId}-stuck`} className="text-footnote text-text-muted">
          {ordersCopy.stuckHint}
        </p>
      </section>

      <OrdersTable
        caption={ordersCopy.tableCaption}
        emptyMessage={ordersCopy.empty}
        pages={query.data?.pages}
        isLoading={query.isLoading}
        failed={query.isError}
        hasNextPage={query.hasNextPage}
        isFetchingNextPage={query.isFetchingNextPage}
        onRetry={() => void query.refetch()}
        onLoadMore={() => void query.fetchNextPage()}
      />
    </PageFrame>
  );
}

function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-caption text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type="date"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        className="h-control-sm rounded-full border-hairline border-border bg-surface px-4 text-body text-text outline-none focus-visible:ring-2 focus-visible:ring-focus"
      />
    </div>
  );
}
