import type { Order, OrderStatus } from '@tezusta/types';

/**
 * The statuses whose conversation accepts messages — the server's
 * `CONVERSATION_WRITABLE_STATUSES` (`conversations.service.ts`), restated
 * because `apps/mobile` may not import `apps/api`.
 *
 * **A hint for an entry point's subtitle, never the check.** The conversation
 * screen reads `writable` from the server and shows or removes the composer
 * from that; the send endpoint refuses a terminal order whatever any client
 * believes (ADR-0033 § 2).
 */
const WRITABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  'ACCEPTED',
  'MASTER_ON_THE_WAY',
  'MASTER_ARRIVED',
  'IN_PROGRESS',
]);

/**
 * Whether an order has a conversation to open from its screen, and whether it
 * can still be written to — or `null` when there is none.
 *
 * **`acceptedAt` decides it**, because the conversation is opened inside the
 * accept (ADR-0033 § 2) and a re-dispatch both closes it and clears
 * `acceptedAt`. So an order still searching, one no master was found for, and
 * one cancelled before anybody took it have no entry at all, while a
 * completed or cancelled order that *was* accepted keeps its transcript.
 */
export function conversationAvailability(
  order: Pick<Order, 'status' | 'acceptedAt'>,
): { readonly writable: boolean } | null {
  if (order.acceptedAt === null) {
    return null;
  }
  return { writable: WRITABLE.has(order.status) };
}
