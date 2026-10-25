import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MasterServices } from '../../src/master-services';

/**
 * The services the master offers and their prices
 * ([ADR-0063](../../../../docs/decisions/ADR-0063-master-services-screen.md)),
 * pushed from the Services card on their own profile.
 */
export default function MasterServicesScreen(): React.JSX.Element {
  return (
    <SafeAreaView className="flex-1 bg-bg">
      <MasterServices
        onBack={() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/(master)/profile');
          }
        }}
      />
    </SafeAreaView>
  );
}
