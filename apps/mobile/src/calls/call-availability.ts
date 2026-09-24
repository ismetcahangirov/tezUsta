import type { Order } from '@tezusta/types';

import { conversationAvailability } from '../conversation/conversation-availability';

/**
 * Whether the two parties to an order may call each other about it — the
 * server's rule, mirrored (issue #188).
 *
 * **The conversation's rule, not a copy of it.** The server allows a call only
 * on an order whose conversation is open and writable (`resolveCallable` in
 * `calls.service.ts`, ADR-0034 § 6), and ends a live call the moment that stops
 * being true. So the entry point is shown on exactly the orders whose composer
 * is shown: accepted, and in one of the four engaged statuses.
 *
 * **A hint for whether to draw a button, never the check.** The invite is
 * refused by the server for any order it does not allow, whatever this
 * returns — and the refusal ends the call on screen in words.
 */
export function canCallAbout(order: Pick<Order, 'status' | 'acceptedAt'>): boolean {
  return conversationAvailability(order)?.writable === true;
}
