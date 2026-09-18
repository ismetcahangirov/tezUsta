import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text } from '../../src/components';
import { AvailabilityCard } from '../../src/master-availability';

/**
 * Master home.
 *
 * The placeholder verification card that stood here is gone: it rendered a
 * hard-coded "2 of 3 documents uploaded" that was true of nobody, and a screen
 * showing invented numbers to a master waiting on a real review is worse than
 * a screen showing less. Wiring that panel to `GET /masters/me/documents`
 * belongs with the rest of the mobile verification flow, which no issue has
 * asked for yet.
 *
 * What is here is real: the availability toggle (issue #40), reading and
 * writing the server's own state.
 */
export default function MasterHomeScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <View className="gap-6 p-6">
        <Text variant="h1">Bu gün</Text>

        <AvailabilityCard />
      </View>
    </SafeAreaView>
  );
}
