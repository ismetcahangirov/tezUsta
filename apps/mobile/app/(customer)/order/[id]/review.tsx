import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { OrderReview } from '../../../../src/reviews';

/**
 * The customer's review of their master on one order (issue #227,
 * [ADR-0042](../../../../../docs/decisions/ADR-0042-review-policy.md) § 8).
 *
 * **Pushed over the order screen**, a sibling of `chat`, the way ADR-0037
 * pushes the conversation: reached from the prompt card on the status card,
 * and deep-linked by the `review-reminder` push. Told the id and nothing else.
 */
export default function OrderReviewScreen(): React.JSX.Element | null {
  const { id } = useLocalSearchParams<{ id?: string }>();

  if (id === undefined || id === '') {
    router.replace('/(customer)');
    return null;
  }

  // Back to the order when it is underneath, and to the order itself on the
  // cold start a reminder produces — the review is about that job.
  const leave = (): void => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace({ pathname: '/(customer)/order/[id]', params: { id } });
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <OrderReview orderId={id} onBack={leave} onDone={leave} />
    </SafeAreaView>
  );
}
