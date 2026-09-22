import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Orders } from '../../../src/orders';

/**
 * The customer's orders (issue #160,
 * [ADR-0030](../../../../docs/decisions/ADR-0030-customer-root-navigation-and-order-list.md)).
 *
 * The second tab, and the reason the tab bar exists: until this screen an order
 * was reachable only from the end of creating it and from a tapped
 * notification, so closing the app lost it.
 *
 * `push`, not `replace` — the order screen is opened *from* here, and pressing
 * back on it should come back to the list rather than to the catalogue.
 * `src/orders/Orders.tsx` carries the screen; this file is only the route.
 */
export default function CustomerOrdersScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <Orders
        onSelectOrder={(id) => {
          router.push({ pathname: '/(customer)/order/[id]', params: { id } });
        }}
        onBrowseServices={() => {
          router.navigate('/(customer)');
        }}
      />
    </SafeAreaView>
  );
}
