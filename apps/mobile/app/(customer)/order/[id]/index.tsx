import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OrderDetail } from '../../../../src/orders';

/**
 * One of the customer's orders
 * ([ADR-0029](../../../../../docs/decisions/ADR-0029-customer-order-screen.md),
 * issue #155).
 *
 * **A stack screen beside `order/new`, not a tab and not a modal.** It has to be
 * a plain deep-link target — a tapped notification lands here directly (#146) —
 * and it deliberately decides nothing about the root navigation pattern, which
 * is still the owner's.
 *
 * **A directory route since issue #182**: `order/[id]/index` is still
 * `/(customer)/order/[id]` to the router, and the order's conversation is its
 * sibling at `order/[id]/chat`, pushed over it.
 *
 * The order arrives as an id and nothing else. Its status, price and photos are
 * fetched: a status carried in a navigation parameter is a status that was true
 * when the navigation started, and what changed since then is the entire
 * subject of this screen.
 */
export default function OrderScreen(): React.JSX.Element | null {
  const { id } = useLocalSearchParams<{ id?: string }>();

  if (id === undefined || id === '') {
    // Reached without an order — a stale deep link, or a back navigation into a
    // route that no longer has its parameter. Home is the only honest answer.
    router.replace('/(customer)');
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <OrderDetail
        orderId={id}
        onOpenConversation={() => {
          // Pushed over the order (ADR-0033 § 6), so back returns here. The
          // route is fixed: notifications (#180) deep-link to it.
          router.push({ pathname: '/(customer)/order/[id]/chat', params: { id } });
        }}
        onBack={() => {
          // `back()` when there is somewhere to go back to — creation, or the
          // catalogue — and home when there is not, which is the cold start a
          // notification produces.
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/(customer)');
          }
        }}
      />
    </SafeAreaView>
  );
}
