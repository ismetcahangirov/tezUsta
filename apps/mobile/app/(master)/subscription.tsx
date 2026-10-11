import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { refreshMySubscription, SubscriptionDetails } from '../../src/master-subscription';
import { useAppDispatch } from '../../src/store/hooks';

/**
 * The master's subscription, pushed over the home (#325,
 * [ADR-0049](../../../../docs/decisions/ADR-0049-master-subscription-surface.md)).
 * Opened from the subscription card, from the availability card when going
 * online was refused, and by every subscription push (#326).
 */
export default function MasterSubscriptionScreen(): React.JSX.Element {
  const dispatch = useAppDispatch();
  // Not on the first focus: the mount has just read it, and a refresh queued
  // behind that read would send the same request twice.
  const focusedBefore = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedBefore.current) {
        dispatch(refreshMySubscription());
      }
      focusedBefore.current = true;
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
