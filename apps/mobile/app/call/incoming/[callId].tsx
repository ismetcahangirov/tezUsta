import { router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { closeCall, IncomingCallRoute } from '../../../src/calls';

/**
 * The call ringing this phone (issue #188,
 * [ADR-0040](../../../../../docs/decisions/ADR-0040-call-screens.md)).
 *
 * Pushed by the root's ring listener when `call:incoming` arrives
 * (`useIncomingCallRouting`), presented over whatever is on screen. The call
 * comes from the `ringingCall` slice the listener wrote; the id in the path
 * only says which one to look for, and a path with no matching ring closes.
 */
export default function IncomingCallScreen(): React.JSX.Element | null {
  const { callId } = useLocalSearchParams<{ callId?: string }>();
  const onClose = useCallback(() => {
    closeCall(router);
  }, []);

  if (callId === undefined || callId === '') {
    closeCall(router);
    return null;
  }

  return (
    <SafeAreaView className="flex-1 bg-inverse-surface">
      <IncomingCallRoute callId={callId} onClose={onClose} />
    </SafeAreaView>
  );
}
