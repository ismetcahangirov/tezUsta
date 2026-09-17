import { SafeAreaView } from 'react-native-safe-area-context';

import { ServiceCatalogue } from '../../src/service-catalogue';

/**
 * Customer home: the service catalogue, rendered entirely from the API.
 *
 * It hardcoded three categories until issue #33. Nothing in the app names a
 * category or a service now — adding one is a row in `service_categories` or
 * `services` and reaches the customer on the next fetch, with no release
 * (EPIC 3).
 *
 * What happens when a service is picked is order creation (EPIC 6), which does
 * not exist yet, so the callback is deliberately not wired: a screen that
 * navigated somewhere would be inventing both the destination and the
 * navigation pattern, and the pattern is still the owner's to decide
 * (CLAUDE.md §17).
 */
export default function CustomerHomeScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <ServiceCatalogue />
    </SafeAreaView>
  );
}
