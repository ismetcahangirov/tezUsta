import { router, useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { refreshMySubscription, SubscriptionDetails } from '../../src/master-subscription';
import { useAppDispatch } from '../../src/store/hooks';

/**
 * The master's subscription, pushed over the home (#325,
 * [ADR-0048](../../../docs/decisions/ADR-0048-master-subscription-surface.md)).
 * Opened from the subscription card, from the availability card when going
 * online was refused, and by every subscription push (#326).
 */
export default function MasterSubscriptionScreen(): React.JSX.Element {
  const dispatch = useAppDispatch();
  useFocusEffect(
    useCallback(() => {
      dispatch(refreshMySubscription());
    }, [dispatch]),
  );

  // Home is the only honest place to return to on a cold start from a push.
  const leave = (): void => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/(master)');
    }
  };

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <SubscriptionDetails onBack={leave} />
    </SafeAreaView>
  );
}
