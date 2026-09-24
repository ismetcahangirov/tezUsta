import type { Call } from '@tezusta/types';

import { callsApi } from '../calls';
import type { AppDispatch } from '../store';

import { dismissCallNotifications } from './push-adapter';

/** What a ring push claimed: two ids, neither trusted yet. */
export interface RingClaim {
  readonly callId: string;
  readonly orderId: string;
}

/**
 * Asks the server whether the call a ring push names is still ringing this
 * account, and returns the call only if it is (#189, ADR-0039 § 4).
 *
 * **The server's answer decides, never the payload.** A push can land long
 * after its call was answered, declined, cancelled or timed out; it can also
 * have been crafted. The call is shown only when `GET /calls/:callId` says:
 *
 * - it is the call the payload named, on the order the payload named;
 * - its status is `RINGING`;
 * - this account is its `callee` (the server presents the call per viewer).
 *
 * Anything else — including a 404, which is what a stranger and an unknown id
 * both get, and a request that failed — returns `null`. In that case any ring
 * notification still presented for that id is taken down: whatever the reason,
 * this phone is not going to ring for it.
 */
export async function confirmRingingCall(
  dispatch: AppDispatch,
  claim: RingClaim,
): Promise<Call | null> {
  let call: Call | null;
  try {
    // `forceRefetch` with no subscription: never a cached status, and nothing
    // left behind in the store once this read is done (`call-endpoints.ts`).
    call = await dispatch(
      callsApi.endpoints.getCall.initiate(claim.callId, { subscribe: false, forceRefetch: true }),
    ).unwrap();
  } catch {
    call = null;
  }

  const ringingHere =
    call !== null &&
    call.id === claim.callId &&
    call.orderId === claim.orderId &&
    call.status === 'RINGING' &&
    call.role === 'callee';

  if (!ringingHere) {
    void dismissCallNotifications(claim.callId);
    return null;
  }
  return call;
}
