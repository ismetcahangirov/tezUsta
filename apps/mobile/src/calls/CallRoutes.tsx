import type { Call } from '@tezusta/types';
import { useEffect, useState } from 'react';

import { effectiveRole } from '../auth/route-guard';
import { useAppSelector } from '../store/hooks';
import { selectGrantedRoles, selectRole } from '../store/session-slice';

import { CALLING_ENABLED } from './calling-enabled';
import { IncomingCallSurface, OutgoingCallSurface } from './CallSurfaces';
import { selectRingingCall } from './ringing-call-slice';

export interface OutgoingCallRouteProps {
  readonly orderId: string;
  readonly onClose: () => void;
}

/**
 * `app/call/outgoing/[orderId]`: a call placed from an order (ADR-0040 § 1).
 *
 * Which side of the order this phone is on comes from the role on screen — the
 * same reading the route guard makes — rather than from a route parameter a
 * link could set. It only chooses a fallback name and which read names the
 * service; the server decides who may call on every invite.
 */
export function OutgoingCallRoute({
  orderId,
  onClose,
}: OutgoingCallRouteProps): React.JSX.Element | null {
  const role = useAppSelector(selectRole);
  const grantedRoles = useAppSelector(selectGrantedRoles);

  useCloseWhileDark(onClose);

  if (!CALLING_ENABLED) {
    return null;
  }
  return (
    <OutgoingCallSurface
      orderId={orderId}
      viewer={effectiveRole(grantedRoles, role)}
      onClose={onClose}
    />
  );
}

/**
 * **A call route opened while calling ships dark closes at once** (ADR-0039
 * § 3). The entry points are hidden, but the route itself is still reachable
 * — a deep link such as `tezusta://call/outgoing/<id>` — and would otherwise
 * place a real invite that could only ever reach `connecting`.
 */
function useCloseWhileDark(onClose: () => void): void {
  useEffect(() => {
    if (!CALLING_ENABLED) {
      onClose();
    }
  }, [onClose]);
}

export interface IncomingCallRouteProps {
  readonly callId: string;
  readonly onClose: () => void;
  /** See `IncomingCallSurfaceProps.onRingStopped`. */
  readonly onRingStopped?: ((callId: string) => void) | undefined;
}

/**
 * `app/call/incoming/[callId]`: the call ringing this phone (ADR-0040 § 1).
 *
 * **The ring is read from the `ringingCall` slice once, on arrival, and kept.**
 * The slice lets go of the call the moment it ends, while this screen goes on
 * showing why until it is closed (§ 5) — so it holds its own copy rather than
 * re-reading one that is about to become null.
 *
 * **No matching ring, no screen.** A stale link, a back navigation into a call
 * that is long over, a second route for a call the root already ignored: each
 * closes straight away rather than showing a call nobody is making.
 */
export function IncomingCallRoute({
  callId,
  onClose,
  onRingStopped,
}: IncomingCallRouteProps): React.JSX.Element | null {
  const ringing = useAppSelector(selectRingingCall);
  const [call] = useState<Call | null>(() =>
    CALLING_ENABLED && ringing?.id === callId ? ringing : null,
  );

  useEffect(() => {
    // No ring to show — a stale link, a call that ended before this screen
    // mounted — or calling ships dark: nothing to show either way.
    if (call === null) {
      onClose();
    }
  }, [call, onClose]);

  if (call === null) {
    return null;
  }
  return <IncomingCallSurface call={call} onClose={onClose} onRingStopped={onRingStopped} />;
}
