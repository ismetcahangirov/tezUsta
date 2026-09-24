import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CALL_SURFACE_SCHEME, closeCall, IncomingCallRoute } from '../../../src/calls';
import { FixedScheme } from '../../../src/theme';

/**
 * The call ringing this phone (issue #188,
 * [ADR-0040](../../../../../docs/decisions/ADR-0040-call-screens.md),
 * [ADR-0041](../../../../../docs/decisions/ADR-0041-call-surface-fixed-appearance.md)).
 *
 * Pushed by the root's ring listener when `call:incoming` arrives
 * (`useIncomingCallRouting`), presented over whatever is on screen. The call
 * comes from the `ringingCall` slice the listener wrote; the id in the path
 * only says which one to look for, and a path with no matching ring closes.
 */
export default function IncomingCallScreen(): React.JSX.Element | null {
  const { callId } = useLocalSearchParams<{ callId?: string }>();
  const missing = callId === undefined || callId === '';
  const onClose = useCallback(() => {
    closeCall(router);
  }, []);

  useEffect(() => {
    if (missing) {
      onClose();
    }
  }, [missing, onClose]);

  if (missing) {
    return null;
  }

  return (
    <FixedScheme scheme={CALL_SURFACE_SCHEME} className="flex-1 bg-inverse-surface">
      <SafeAreaView className="flex-1">
        <IncomingCallRoute callId={callId} onClose={onClose} />
      </SafeAreaView>
    </FixedScheme>
  );
}
