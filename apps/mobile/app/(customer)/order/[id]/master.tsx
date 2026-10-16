import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MasterProfile } from '../../../../src/portfolio';

/**
 * The master on one of the customer's orders (#315,
 * [ADR-0054](../../../../../docs/decisions/ADR-0054-master-profile-and-portfolio-screens.md)
 * § 1), pushed over the order the way its conversation is, so back returns to
 * the order as it was.
 *
 * It is told the order, not the master: the master is read from the order,
 * and whether the customer may see them is the server's answer.
 */
export default function OrderMasterScreen(): React.JSX.Element | null {
  const { id } = useLocalSearchParams<{ id?: string }>();

  if (id === undefined || id === '') {
    router.replace('/(customer)');
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <MasterProfile
        orderId={id}
        onBack={() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace({ pathname: '/(customer)/order/[id]', params: { id } });
          }
        }}
      />
    </SafeAreaView>
  );
}
