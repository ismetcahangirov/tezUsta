import { PageFrame } from '../../shell/PageFrame';
import { useListDisputesInfiniteQuery } from './api';
import { ordersCopy } from './copy';
import { OrdersTable } from './OrdersTable';

/**
 * The dispute queue (ADR-0043 § 5): every `DISPUTED` order, oldest first,
 * which is what makes a stale one visible. Resolving happens on the order.
 */
export function DisputesPage() {
  const query = useListDisputesInfiniteQuery();
  return (
    <PageFrame title={ordersCopy.disputesTitle}>
      <p className="text-body text-text-muted">{ordersCopy.disputesIntro}</p>
      <OrdersTable
        caption={ordersCopy.disputesCaption}
        emptyMessage={ordersCopy.noDisputes}
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
