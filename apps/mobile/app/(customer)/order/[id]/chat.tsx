import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Conversation } from '../../../../src/conversation';

/**
 * The conversation on one of the customer's orders (issue #182,
 * [ADR-0033](../../../../../docs/decisions/ADR-0033-in-order-messaging.md) § 6,
 * [ADR-0037](../../../../../docs/decisions/ADR-0037-conversation-screen.md)).
 *
 * **Pushed over the order screen, never a tab** — ADR-0030 keeps order-scoped
 * surfaces off the tab bar, and a conversation is not somewhere anybody goes
 * except through the job it is about. The path is fixed: push notifications
 * for a new message (#180) deep-link here.
 *
 * Like the order screen, it is told the id and nothing else, and reads the
 * rest. Whether it may be written to comes from the server on every read.
 */
export default function OrderChatScreen(): React.JSX.Element | null {
  const { id } = useLocalSearchParams<{ id?: string }>();

  if (id === undefined || id === '') {
    router.replace('/(customer)');
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-bg">
      <Conversation
        orderId={id}
        viewer="customer"
        onBack={() => {
          // Back to the order when it is underneath — the usual way in — and
          // to the order itself on the cold start a notification produces, so
          // the customer lands on the job the conversation is about.
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
