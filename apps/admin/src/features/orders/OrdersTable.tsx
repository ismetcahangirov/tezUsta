import type { AdminOrderSummary } from '@tezusta/types';
import { Link } from 'react-router';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { formatDateTime, formatMoney } from '../../format';
import { ordersCopy } from './copy';
import { OrderStatusBadge } from './OrderStatusBadge';
import { shortOrderId } from './rules';

export interface OrdersTableProps {
  caption: string;
  emptyMessage: string;
  pages: readonly { readonly items: readonly AdminOrderSummary[] }[] | undefined;
  isLoading: boolean;
  failed: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
}

/** The dense order table the order list and the dispute queue share, with its paging. */
export function OrdersTable({
  caption,
  emptyMessage,
  pages,
  isLoading,
  failed,
  hasNextPage,
  isFetchingNextPage,
  onRetry,
  onLoadMore,
}: OrdersTableProps) {
  const orders = pages?.flatMap((page) => page.items) ?? [];

  if (isLoading) {
    return (
      <p role="status" className="text-body text-text-muted">
        {ordersCopy.loading}
      </p>
    );
  }
  if (failed && pages === undefined) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Banner tone="danger" message={ordersCopy.loadFailed} />
        <Button label={ordersCopy.retry} variant="secondary" onClick={onRetry} />
      </div>
    );
  }
  if (orders.length === 0) {
    return <p className="text-body text-text-muted">{emptyMessage}</p>;
  }

  const columns = ordersCopy.columns;
  return (
    <div className="flex flex-col items-start gap-4">
      <Table caption={caption}>
        <thead>
          <tr>
            {[
              columns.order,
              columns.status,
              columns.service,
              columns.customer,
              columns.master,
              columns.price,
              columns.redispatches,
              columns.created,
              columns.updated,
            ].map((column) => (
              <th key={column} scope="col" className={TH_CLASS}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {orders.map((order) => (
            <tr key={order.id} className="hover:bg-surface-alt">
              <td className={TD_CLASS}>
                <Link
                  to={`/orders/${order.id}`}
                  className="font-mono font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {shortOrderId(order.id)}
                </Link>
              </td>
              <td className={TD_CLASS}>
                <OrderStatusBadge status={order.status} />
              </td>
              <td className={TD_CLASS}>{order.serviceName}</td>
              <td className={TD_CLASS}>{order.customerName}</td>
              <td className={TD_CLASS}>{order.masterName ?? ordersCopy.none}</td>
              <td className={`${TD_CLASS} whitespace-nowrap`}>
                {order.priceMinor === null ? ordersCopy.none : formatMoney(order.priceMinor)}
              </td>
              <td className={TD_CLASS}>{order.redispatchCount}</td>
              <td className={`${TD_CLASS} whitespace-nowrap`}>{formatDateTime(order.createdAt)}</td>
              <td className={`${TD_CLASS} whitespace-nowrap`}>{formatDateTime(order.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {hasNextPage && (
        <Button
          label={ordersCopy.loadMore}
          loadingLabel={ordersCopy.loadingMore}
          loading={isFetchingNextPage}
          variant="secondary"
          onClick={onLoadMore}
        />
      )}
    </div>
  );
}
