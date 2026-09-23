import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Conversation } from '../../../src/conversation';

/**
 * The conversation on the master's job (issue #182,
 * [ADR-0033](../../../../docs/decisions/ADR-0033-in-order-messaging.md) § 6,
 * [ADR-0036](../../../../docs/decisions/ADR-0036-master-work-surface.md)).
 *
 * **One more screen pushed on the master's single stack**, from the job
 * screen — the equivalent place to the customer's order screen. It takes the
 * order id, unlike `job.tsx`, because push notifications (#180) deep-link to a
 * conversation by order; a stale link is harmless, since the server answers
 * 404 for a conversation on an order this master no longer holds and the
 * screen says there is none.
 */
export default function MasterChatScreen(): React.JSX.Element | null {
  const { orderId } = useLocalSearchParams<{ orderId?: string }>();

  if (orderId === undefined || orderId === '') {
    router.replace('/(master)');
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <Conversation
        orderId={orderId}
        viewer="master"
        onBack={() => {
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace('/(master)/job');
          }
        }}
      />
    </SafeAreaView>
  );
}
