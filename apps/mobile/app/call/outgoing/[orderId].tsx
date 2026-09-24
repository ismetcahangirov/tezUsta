import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { closeCall, OutgoingCallRoute } from '../../../src/calls';

/**
 * A call this phone places on one order (issue #188,
 * [ADR-0040](../../../../../docs/decisions/ADR-0040-call-screens.md)).
 *
 * Presented as a full-screen modal over whatever is on screen, with gestures
 * off (`app/_layout.tsx`). It is told the order and nothing else; the call
 * itself — asking for the microphone, the invite, every phase after — is the
 * reducer's, driven from `OutgoingCallSurface`.
 */
export default function OutgoingCallScreen(): React.JSX.Element | null {
  const { orderId } = useLocalSearchParams<{ orderId?: string }>();
  const onClose = useCallback(() => {
    closeCall(router);
  }, []);

  if (orderId === undefined || orderId === '') {
    // Reached without an order: nothing to call about.
    closeCall(router);
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-inverse-surface">
      <OutgoingCallRoute orderId={orderId} onClose={onClose} />
    </SafeAreaView>
  );
}
