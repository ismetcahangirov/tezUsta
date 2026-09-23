import { useCallback, useEffect, useRef, useState } from 'react';

import { monotonicNow } from '../lib/monotonic-clock';
import { useRealtimeConnection } from '../realtime/RealtimeProvider';
import { useTypingQuery } from './conversation-endpoints';

/**
 * How long "typing…" stays up after the last frame, in milliseconds.
 *
 * The server relays at most one frame per two seconds (#179) and there is no
 * "stopped typing" frame by design, so the indicator is kept for two relay
 * intervals: long enough that a steady typist never flickers off between
 * frames, short enough that somebody who stopped is not shown typing for long.
 */
export const TYPING_LAPSE_MS = 4_000;

/**
 * The least time between two typing frames this phone sends.
 *
 * The server's own relay interval. Sending faster than it relays is uplink
 * spent on frames the server drops.
 */
export const TYPING_SIGNAL_INTERVAL_MS = 2_000;

/**
 * Whether the other party is typing in this order's conversation, right now.
 *
 * Read from the cache entry `applyRealtimeEvent` stamps with the frame's
 * arrival time. The only thing that ends the indicator without a new frame is
 * time passing, so a single timer is armed for the moment it lapses and the
 * hook re-renders then — on the monotonic clock, so a wall clock stepped
 * backwards cannot keep it up.
 */
export function useOtherPartyTyping(orderId: string): boolean {
  const { currentData: receivedAt } = useTypingQuery(orderId);
  const [now, setNow] = useState(monotonicNow);

  // `now` is the last time the lapse timer fired, so it may be *older* than a
  // frame that has just arrived — which makes the difference negative and the
  // indicator shown, the right answer for a frame that just arrived.
  const typing =
    receivedAt !== undefined && receivedAt !== null && now - receivedAt < TYPING_LAPSE_MS;

  useEffect(() => {
    if (receivedAt === undefined || receivedAt === null) {
      return;
    }
    const remaining = receivedAt + TYPING_LAPSE_MS - monotonicNow();
    if (remaining <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      setNow(monotonicNow());
    }, remaining);
    return () => {
      clearTimeout(timer);
    };
  }, [receivedAt]);

  return typing;
}

/**
 * A callback for the composer to call on every change of its text; it tells
 * the other party this user is typing, at most once per
 * {@link TYPING_SIGNAL_INTERVAL_MS}.
 *
 * Through the app's one connection (#170), never a second socket. With no
 * connection — a test, or a network that blocks WebSocket — it does nothing,
 * which is what a lost typing frame costs anyway.
 */
export function useTypingSignal(orderId: string): () => void {
  const connection = useRealtimeConnection();
  const lastSent = useRef<number | null>(null);

  return useCallback(() => {
    if (connection === null) {
      return;
    }
    const now = monotonicNow();
    if (lastSent.current !== null && now - lastSent.current < TYPING_SIGNAL_INTERVAL_MS) {
      return;
    }
    lastSent.current = now;
    connection.signalTyping(orderId);
  }, [connection, orderId]);
}
