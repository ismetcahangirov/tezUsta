import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OrderReport } from '../../../../src/reports';

/**
 * The customer reports a master on one order (#330,
 * [ADR-0053](../../../../../docs/decisions/ADR-0053-party-reports.md)), pushed
 * over the order the way its review is (ADR-0042 § 8).
 */
export default function OrderReportScreen(): React.JSX.Element | null {
  const { id } = useLocalSearchParams<{ id?: string }>();

  if (id === undefined || id === '') {
    router.replace('/(customer)');
    return null;
  }

  const leave = (): void => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace({ pathname: '/(customer)/order/[id]', params: { id } });
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <OrderReport orderId={id} onBack={leave} onDone={leave} />
    </SafeAreaView>
  );
}
