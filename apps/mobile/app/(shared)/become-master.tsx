import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MasterOnboarding, useOpenMasterArea } from '../../src/master-onboarding';

/**
 * Becoming a master (#490, ADR-0073). In `(shared)` because both entry points
 * reach it: the first-launch role choice, from an account with no role yet,
 * and "Usta ol" in Settings, from a customer.
 */
export default function BecomeMasterScreen(): React.JSX.Element {
  const openMasterArea = useOpenMasterArea();

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <MasterOnboarding
        onBack={() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/');
          }
        }}
        onOpenMaster={openMasterArea}
      />
    </SafeAreaView>
  );
}
