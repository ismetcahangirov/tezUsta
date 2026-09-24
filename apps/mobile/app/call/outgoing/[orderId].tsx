import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CALL_SURFACE_SCHEME, closeCall, OutgoingCallRoute } from '../../../src/calls';
import { FixedScheme } from '../../../src/theme';

/**
 * A call this phone places on one order (issue #188,
 * [ADR-0040](../../../../../docs/decisions/ADR-0040-call-screens.md),
 * [ADR-0041](../../../../../docs/decisions/ADR-0041-call-surface-fixed-appearance.md)).
 *
 * Presented as a full-screen modal over whatever is on screen, with gestures
 * off (`app/_layout.tsx`). It is told the order and nothing else; the call
 * itself — asking for the microphone, the invite, every phase after — is the
 * reducer's, driven from `OutgoingCallSurface`. The safe-area insets are
 * painted in the call surface's fixed scheme too, so the notch and the home
 * indicator do not turn white in dark mode.
 */
export default function OutgoingCallScreen(): React.JSX.Element | null {
  const { orderId } = useLocalSearchParams<{ orderId?: string }>();
  const missing = orderId === undefined || orderId === '';
  const onClose = useCallback(() => {
    closeCall(router);
  }, []);

  useEffect(() => {
    // Reached without an order: nothing to call about. Navigated from an
    // effect, never during render.
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
        <OutgoingCallRoute orderId={orderId} onClose={onClose} />
      </SafeAreaView>
    </FixedScheme>
  );
}
