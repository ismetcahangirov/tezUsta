import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OrderReview } from '../../../src/reviews';

/**
 * The master's review of their customer on one order (issue #227,
 * [ADR-0042](../../../../docs/decisions/ADR-0042-review-policy.md) § 8).
 *
 * **Outside `(master)/job`, and keyed by order.** The job screen stops being
 * this order the moment it completes — which is exactly when a review becomes
 * possible — so the review needs an address of its own that a reminder tapped
 * a day later can still land on. One more screen on the master's single stack
 * (ADR-0036), pushed from the completed job, from home, or opened by the push.
 */
export default function MasterReviewScreen(): React.JSX.Element | null {
  const { orderId } = useLocalSearchParams<{ orderId?: string }>();

  if (orderId === undefined || orderId === '') {
    router.replace('/(master)');
    return null;
  }

  // Home is where the prompt lives once the job is over, and the only honest
  // place to return to on a cold start.
  const leave = (): void => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(master)');
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <OrderReview orderId={orderId} onBack={leave} onDone={leave} />
    </SafeAreaView>
  );
}
