import type { CallRealtimeEventName, CallRequestName } from '@tezusta/types';

/**
 * The call frames' names, written once on the server (issue #185).
 *
 * `packages/types` cannot hold these as values — the reason
 * `realtime/realtime.events.ts` gives for order events — so each literal is
 * typed by the shared union and a typo does not compile. They live here rather
 * than beside the order events because `CallsService` names the frame it is
 * publishing, and `modules/calls` must not import `modules/realtime`: the arrow
 * points the other way (`call-events.registry.ts`).
 */

/** Inbound: ring the other party to an order. */
export const CALL_INVITE_REQUEST: CallRequestName = 'call:invite';
/** Inbound: the callee answers. */
export const CALL_ACCEPT_REQUEST: CallRequestName = 'call:accept';
/** Inbound: the callee declines. */
export const CALL_REJECT_REQUEST: CallRequestName = 'call:reject';
/** Inbound: the caller gives up before an answer. */
export const CALL_CANCEL_REQUEST: CallRequestName = 'call:cancel';
/** Inbound: either party ends an answered call. */
export const CALL_HANGUP_REQUEST: CallRequestName = 'call:hangup';

/** Outbound, to the callee only: your phone should ring. */
export const CALL_INCOMING_EVENT: CallRealtimeEventName = 'call:incoming';
/** Outbound, to both: answered. Carries no credential — see `CallAcceptAck`. */
export const CALL_ACCEPTED_EVENT: CallRealtimeEventName = 'call:accepted';
export const CALL_REJECTED_EVENT: CallRealtimeEventName = 'call:rejected';
export const CALL_CANCELLED_EVENT: CallRealtimeEventName = 'call:cancelled';
export const CALL_TIMEOUT_EVENT: CallRealtimeEventName = 'call:timeout';
/** Outbound, to the caller only: the line was busy, and nothing rang. */
export const CALL_BUSY_EVENT: CallRealtimeEventName = 'call:busy';
export const CALL_ENDED_EVENT: CallRealtimeEventName = 'call:ended';
