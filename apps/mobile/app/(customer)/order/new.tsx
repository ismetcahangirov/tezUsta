import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CreateOrder } from '../../../src/orders';

/**
 * Order creation for a service the customer picked on the catalogue.
 *
 * **One route, not four.** The steps live in `CreateOrder`'s own state — the
 * pattern the owner chose, and the one `ServiceCatalogue` already uses for its
 * category drill-down. Splitting them into `describe`/`address`/`confirm`
 * routes later is a mechanical change, which is the point of doing it this way
 * while the customer root's navigation is still an open question
 * (CLAUDE.md §17).
 *
 * The service arrives as an id and nothing else. Its name and pricing shape
 * are fetched, not passed: a name carried in a navigation parameter can be
 * stale, or edited in a link, and then the confirmation screen would show a
 * service the order is not for.
 */
export default function NewOrderScreen(): React.JSX.Element | null {
  const { serviceId } = useLocalSearchParams<{ serviceId?: string }>();

  if (serviceId === undefined || serviceId === '') {
    // Reached without a service — a stale deep link, or a back navigation into
    // a dismissed flow. Going home is the only honest answer; there is no
    // order to resume.
    router.replace('/(customer)');
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <CreateOrder
        serviceId={serviceId}
        onClose={() => {
          router.replace('/(customer)');
        }}
      />
    </SafeAreaView>
  );
}
