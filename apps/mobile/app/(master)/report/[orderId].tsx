import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OrderReport } from '../../../src/reports';

/**
 * The master reports the customer on one order (#330,
 * [ADR-0053](../../../../docs/decisions/ADR-0053-party-reports.md)). Keyed by
 * order, like the master's review: the job screen stops being this order the
 * moment it ends, and a report stays possible for days after.
 */
export default function MasterReportScreen(): React.JSX.Element | null {
  const { orderId } = useLocalSearchParams<{ orderId?: string }>();

  if (orderId === undefined || orderId === '') {
    router.replace('/(master)');
    return null;
  }

  const leave = (): void => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(master)');
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <OrderReport orderId={orderId} onBack={leave} onDone={leave} />
    </SafeAreaView>
  );
}
