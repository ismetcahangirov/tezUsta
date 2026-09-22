import type { ReactElement } from 'react';
import { View } from 'react-native';

import { isTransportFailure } from '../api/base-query';
import { Banner, Button, EmptyState, Skeleton, Text } from '../components';
import { useCustomerOrdersInfiniteQuery } from './order-endpoints';
import { OrderList } from './OrderList';
import { ORDERS_COPY as copy } from './orders-copy';

/** The same shape check `ServiceCatalogue`, `Addresses` and `OrderDetail` make. */
function isOffline(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    isTransportFailure((error as { status?: unknown }).status)
  );
}

export interface OrdersProps {
  /** Opens one order. The id is all that travels — see `OrderDetail`. */
  readonly onSelectOrder: (orderId: string) => void;
  /** Where "there is nothing here yet" sends somebody: the catalogue. */
  readonly onBrowseServices: () => void;
}

/**
 * The customer's orders — the way back to one after the app has been closed
 * (issue #160,
 * [ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)).
 *
 * **Four request states, rendered deliberately**, the shape `ServiceCatalogue`
 * established and every list screen since has followed: a named skeleton while
 * nothing is known, the rows once they are, a caption over stale rows when a
 * refresh failed, and an empty state when there is nothing behind the failure.
 * Each branch is decided by *reading* the state — nothing arrived and no error
 * means "still loading", never "failed".
 *
 * **Paging is a control the customer presses, not a scroll position.** A list
 * that fetches the next twenty rows because a finger moved spends somebody's
 * mobile data on rows they did not ask for, and the customer who came here to
 * check on a master never reaches row twenty anyway. It is also the half of
 * this screen a screen-reader user can actually operate.
 *
 * **It opens no socket and polls nothing.** The list re-reads when an order is
 * created — `createOrder` invalidates the tag this endpoint provides — and
 * otherwise when the tab is re-entered and the cached answer has gone stale.
 * Live status is EPIC 9.
 */
export function Orders({ onSelectOrder, onBrowseServices }: OrdersProps): ReactElement {
  const orders = useCustomerOrdersInfiniteQuery();

  /**
   * `currentData`, never `data` — the reason `ServiceCatalogue` gives in full:
   * `data` deliberately survives an argument change, and what is on screen
   * must be what was asked for.
   */
  const loaded = orders.currentData?.pages.flatMap((page) => page.items);

  if (loaded === undefined) {
    return (
      <OrdersFrame>
        {orders.error === undefined ? (
          <OrdersSkeleton />
        ) : (
          <EmptyState
            title={copy.list.errorTitle}
            description={copy.list.errorDescription}
            action={
              <Button
                label={copy.retry}
                loading={orders.isFetching}
                onPress={() => {
                  void orders.refetch();
                }}
              />
            }
          />
        )}
      </OrdersFrame>
    );
  }

  if (loaded.length === 0) {
    return (
      <OrdersFrame>
        <EmptyState
          title={copy.list.emptyTitle}
          description={copy.list.emptyDescription}
          action={<Button label={copy.list.emptyAction} onPress={onBrowseServices} />}
        />
      </OrdersFrame>
    );
  }

  return (
    <View className="flex-1">
      <OrderList
        orders={loaded}
        onSelect={(order) => {
          onSelectOrder(order.id);
        }}
        header={
          <View className="gap-4 pb-2 pt-6">
            <Text variant="h1">{copy.list.title}</Text>
            {/* A caption only where there are genuinely stale rows to caption. */}
            {orders.error !== undefined && (
              <Banner
                message={isOffline(orders.error) ? copy.list.staleNotice : copy.list.errorTitle}
                action={
                  <Button
                    label={copy.retry}
                    variant="ghost"
                    size="sm"
                    loading={orders.isFetching}
                    onPress={() => {
                      void orders.refetch();
                    }}
                  />
                }
              />
            )}
          </View>
        }
        footer={
          <View className="pb-10 pt-6">
            {orders.hasNextPage && (
              <Button
                label={orders.isFetchingNextPage ? copy.list.loadingMore : copy.list.loadMore}
                variant="secondary"
                loading={orders.isFetchingNextPage}
                onPress={() => {
                  void orders.fetchNextPage();
                }}
              />
            )}
          </View>
        }
      />
    </View>
  );
}

/** The title row the states without rows share, so the screen is never bare. */
function OrdersFrame({ children }: { children: ReactElement }): ReactElement {
  return (
    <View className="flex-1 gap-6 p-6">
      <Text variant="h1">{copy.list.title}</Text>
      {children}
    </View>
  );
}

/** `accessible` is load-bearing — see `CatalogueSkeleton`: it gives the state a name. */
function OrdersSkeleton(): ReactElement {
  return (
    <View accessible accessibilityLabel={copy.list.loading} className="gap-4">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-control-lg w-full" />
      ))}
    </View>
  );
}
