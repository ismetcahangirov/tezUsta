import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ServiceCatalogue } from '../../../src/service-catalogue';

/**
 * Customer home: the service catalogue, rendered entirely from the API.
 *
 * **The first of two tabs since issue #160.** It moved into `(tabs)/` without
 * changing its path — a group is invisible in a URL, so `/(customer)` still
 * lands here, and every `router.replace('/(customer)')` in the app still means
 * what it meant.
 *
 * It hardcoded three categories until issue #33. Nothing in the app names a
 * category or a service now — adding one is a row in `service_categories` or
 * `services` and reaches the customer on the next fetch, with no release
 * (EPIC 3).
 *
 * Picking a service starts order creation (issue #85). The callback was
 * deliberately unwired until now, because a screen that navigated somewhere
 * would have been inventing both the destination and the navigation pattern;
 * the owner has since settled the pattern — one screen with local steps — so
 * the destination exists and this is where the two meet.
 *
 * Only the id travels. The next screen fetches the service itself, so a name
 * cannot go stale between the tap and the confirmation.
 */
export default function CustomerHomeScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <ServiceCatalogue
        onSelectService={(service) => {
          router.push({ pathname: '/(customer)/order/new', params: { serviceId: service.id } });
        }}
      />
    </SafeAreaView>
  );
}
