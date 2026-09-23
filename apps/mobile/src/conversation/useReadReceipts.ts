import type { Message, MessageSenderKind } from '@tezusta/types';
import { useCallback, useEffect, useRef } from 'react';

import { useMarkMessagesReadMutation } from './conversation-endpoints';
import { isNewer } from './message-history';

/**
 * How long visible messages are gathered before one receipt is sent.
 *
 * A fling through a long history makes the list report a new set of visible
 * rows many times a second; one receipt for the newest message seen in that
 * burst says the same thing as twenty, and the server treats a receipt as
 * "everything up to here" so nothing is lost by waiting.
 */
export const READ_RECEIPT_DELAY_MS = 500;

/**
 * Sends read receipts for what the user has actually seen (issue #182).
 *
 * **Driven by the list's viewability, never by the screen mounting.** A
 * conversation opened and dismissed before its newest message scrolled into
 * view has not been read, and telling the other party it was would make the
 * read receipt a lie on exactly the screen whose job is to be trusted.
 *
 * **One `POST` for the newest visible unread message**, coalesced over
 * {@link READ_RECEIPT_DELAY_MS}. The server marks everything the other side
 * wrote at or before it, so the newest one is the only one worth naming, and a
 * receipt that arrives late or twice can never un-read anything
 * (`conversations.schema.ts`). Nothing is sent while the conversation reports
 * nothing unread, and a message is never named twice.
 *
 * Returns the handler for the list's `onViewableItemsChanged`. **Its identity
 * never changes** — React Native refuses a new one on a mounted list — so the
 * values it needs are read through refs kept current by an effect.
 */
export function useReadReceipts(
  orderId: string,
  viewer: MessageSenderKind,
  unreadCount: number,
): (visible: readonly Message[]) => void {
  const [markRead] = useMarkMessagesReadMutation();

  const latest = useRef({ orderId, viewer, unreadCount, markRead });
  useEffect(() => {
    latest.current = { orderId, viewer, unreadCount, markRead };
  }, [orderId, viewer, unreadCount, markRead]);

  /** The newest message seen but not yet named in a receipt. */
  const candidate = useRef<Message | null>(null);
  /** The newest message already named in a receipt. */
  const sent = useRef<Message | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const next = candidate.current;
    candidate.current = null;

    if (next === null || latest.current.unreadCount === 0) {
      return;
    }
    if (sent.current !== null && !isNewer(next, sent.current)) {
      return;
    }

    sent.current = next;
    void latest.current.markRead({ orderId: latest.current.orderId, throughMessageId: next.id });
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
    },
    [],
  );

  /** Refs only, so it is as stable as `flush`. */
  const offer = useCallback(
    (message: Message) => {
      if (candidate.current === null || isNewer(message, candidate.current)) {
        candidate.current = message;
      }
      timer.current ??= setTimeout(flush, READ_RECEIPT_DELAY_MS);
    },
    [flush],
  );

  /**
   * The list reports what became visible, not what became *unread*. On
   * opening, the rows are usually on screen before the conversation's unread
   * count has loaded — the flush then finds nothing unread and sends nothing —
   * and nothing about the visible rows changes when the count arrives. So the
   * newest visible message is offered again whenever the count rises; a
   * message already named is skipped, so this never sends a repeat.
   */
  const lastVisible = useRef<Message | null>(null);
  useEffect(() => {
    if (unreadCount > 0 && lastVisible.current !== null) {
      offer(lastVisible.current);
    }
  }, [offer, unreadCount]);

  return useCallback(
    (visible: readonly Message[]) => {
      const incoming = visible.filter((message) => message.senderKind !== latest.current.viewer);
      const newest = incoming.reduce<Message | null>(
        (best, message) => (best === null || isNewer(message, best) ? message : best),
        null,
      );

      if (newest === null) {
        return;
      }
      lastVisible.current = newest;
      offer(newest);
    },
    [offer],
  );
}
