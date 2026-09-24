import type { Call } from '@tezusta/types';
import { useEffect, useState } from 'react';

import { effectiveRole } from '../auth/route-guard';
import { useAppSelector } from '../store/hooks';
import { selectGrantedRoles, selectRole } from '../store/session-slice';

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
export function OutgoingCallRoute({ orderId, onClose }: OutgoingCallRouteProps): React.JSX.Element {
  const role = useAppSelector(selectRole);
  const grantedRoles = useAppSelector(selectGrantedRoles);

  return (
    <OutgoingCallSurface
      orderId={orderId}
      viewer={effectiveRole(grantedRoles, role)}
      onClose={onClose}
    />
  );
}

export interface IncomingCallRouteProps {
  readonly callId: string;
  readonly onClose: () => void;
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
}: IncomingCallRouteProps): React.JSX.Element | null {
  const ringing = useAppSelector(selectRingingCall);
  const [call] = useState<Call | null>(() => (ringing?.id === callId ? ringing : null));

  useEffect(() => {
    if (call === null) {
      onClose();
    }
  }, [call, onClose]);

  if (call === null) {
    return null;
  }
  return <IncomingCallSurface call={call} onClose={onClose} />;
}
