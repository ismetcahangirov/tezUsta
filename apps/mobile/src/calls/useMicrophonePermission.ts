import { useCallback, useEffect, useMemo, useRef } from 'react';

import { requestMicrophone } from './microphone-adapter';

export interface MicrophonePermission {
  /**
   * Asks for the microphone — showing the platform's prompt if it has not been
   * answered — and resolves whether it was granted. Resolves `false` rather
   * than a stale answer if the surface that asked has since gone away.
   */
  readonly request: () => Promise<boolean>;
}

/**
 * The microphone question, asked when a call earns it (issue #187, ADR-0039
 * § 2) — **never on mount**.
 *
 * An incoming call asks on accept: a phone that rings and immediately shows a
 * permission dialog over the caller's name has asked the wrong question at the
 * wrong moment, and declining should need no permission at all. An outgoing
 * call asks in its `permissions` phase, which exists for exactly this and is
 * reached only by the person tapping the call button. Either way the answer is
 * handed to the reducer — `permissionGranted()` / `accept()` or
 * `permissionDenied()` — and a refusal is an end reason, not a dialog.
 *
 * It holds no permission state of its own: the platform remembers the answer,
 * and asking again after a grant returns immediately without a prompt.
 */
export function useMicrophonePermission(): MicrophonePermission {
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const request = useCallback(async () => {
    const granted = await requestMicrophone();
    return mounted.current && granted;
  }, []);

  return useMemo(() => ({ request }), [request]);
}
