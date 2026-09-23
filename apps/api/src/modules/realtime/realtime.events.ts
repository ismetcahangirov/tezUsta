import type { RealtimeEventName } from '@tezusta/types';

/**
 * The server's copy of the event names (issue #168).
 *
 * `packages/types` cannot hold these as values — it ships TypeScript source
 * with no build step, which holds only while every export is a type
 * (CLAUDE.md §2) — so the literal is written on each side and typed by the
 * shared union. The annotation is the whole point: a typo here does not
 * compile, and adding a name means adding it to
 * `packages/types/src/realtime-event.ts` first.
 */
export const ORDER_TRANSITION_EVENT: RealtimeEventName = 'order:transition';

/** A wave of offers reached this master. Published to `master:{masterId}`. */
export const ORDER_OFFER_EVENT: RealtimeEventName = 'order:offer';

/**
 * Where the assigned master is, published to `order:{orderId}` and nowhere
 * else (issue #169).
 */
export const MASTER_POSITION_EVENT: RealtimeEventName = 'order:master-position';

/** A message was written; published to `order:{orderId}` minus the sender (#179). */
export const MESSAGE_NEW_EVENT: RealtimeEventName = 'message:new';

/** A read receipt committed; published to `order:{orderId}` minus the reader. */
export const MESSAGE_READ_EVENT: RealtimeEventName = 'message:read';

/**
 * The other party is typing. **Also the name of the inbound frame** a client
 * sends to say so — one word for one fact in both directions, and the gateway
 * answers the inbound one with an ack rather than an echo.
 */
export const CONVERSATION_TYPING_EVENT: RealtimeEventName = 'conversation:typing';
