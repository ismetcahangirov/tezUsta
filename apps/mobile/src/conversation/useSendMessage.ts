import { useCallback } from 'react';

import { api } from '../api/api-slice';
import { errorCodeOf } from '../master-jobs/error-code';
import type { AppDispatch, RootState } from '../store';
import { useAppDispatch } from '../store/hooks';
import { conversationApi, useSendMessageMutation } from './conversation-endpoints';
import { placeMessage } from './message-history';
import type { OutboxEntry } from './outbox-slice';
import { messageFailed, messageQueued, messageRetried, messageSettled } from './outbox-slice';

/** The server's refusal for a conversation whose order has reached a terminal status. */
const NOT_WRITABLE = 'CONVERSATION_NOT_WRITABLE';

let sequence = 0;

/**
 * An id for a bubble the server has not named yet.
 *
 * Never sent anywhere — it only keys the bubble until the response replaces
 * it — so it needs to be unique on this phone and nothing more. No uuid
 * package for that, for the reason `CreateOrder.tsx` gives (CLAUDE.md §10).
 */
function newLocalId(): string {
  sequence += 1;
  return `local-${String(Date.now())}-${String(sequence)}`;
}

export interface SendMessage {
  /** Queues a message and sends it. The body is trimmed; an empty one is ignored. */
  readonly send: (body: string) => void;
  /** Sends a failed message again, under the same bubble. */
  readonly retry: (entry: OutboxEntry) => void;
}

/**
 * Optimistic send for one order's conversation (issue #182).
 *
 * **The bubble appears the instant the user taps**, from the outbox, marked as
 * sending. The `POST` is the write that names it (ADR-0033 § 3); its response
 * — the server's id and timestamp — is placed into the history and the outbox
 * entry removed **in the same tick**, so the bubble is never on screen twice
 * and never gone for a frame.
 *
 * **A failure stays on screen as failed**, with the text the user wrote, until
 * they retry it. Nothing retries on its own — the endpoint opts out of the
 * base query's transport retries (`maxRetries: 0`, see `sendMessage`) — because
 * a message carries no idempotency key, and a silent second attempt after a
 * lost response would post the same words twice.
 *
 * A `CONVERSATION_NOT_WRITABLE` refusal means the order ended while the user
 * was typing. The conversation and the order are re-read, which is what takes
 * the composer away — the screen learns it from the server rather than from
 * this hook guessing.
 */
export function useSendMessage(orderId: string): SendMessage {
  const dispatch = useAppDispatch();
  const [sendMessage] = useSendMessageMutation();

  const deliver = useCallback(
    async (localId: string, body: string): Promise<void> => {
      try {
        const message = await sendMessage({ orderId, body }).unwrap();

        dispatch((inner: AppDispatch, getState: () => RootState) => {
          const loaded = conversationApi.endpoints.messages.select(orderId)(getState()).data;

          if (loaded === undefined) {
            // No history in the cache to settle into — it failed to load, or
            // was dropped. Re-read it rather than let the bubble vanish.
            inner(api.util.invalidateTags([{ type: 'Conversation', id: orderId }]));
          } else {
            inner(
              conversationApi.util.updateQueryData(
                'messages',
                orderId,
                (draft) => placeMessage(draft, message).history,
              ),
            );
          }
          inner(messageSettled({ orderId, localId }));
        });
      } catch (error) {
        dispatch(messageFailed({ orderId, localId }));

        if (errorCodeOf(error) === NOT_WRITABLE) {
          dispatch(
            api.util.invalidateTags([
              { type: 'Conversation', id: orderId },
              { type: 'Order', id: orderId },
              'MasterJob',
            ]),
          );
        }
      }
    },
    [dispatch, orderId, sendMessage],
  );

  const send = useCallback(
    (raw: string) => {
      const body = raw.trim();
      if (body === '') {
        return;
      }

      const localId = newLocalId();
      dispatch(
        messageQueued({
          orderId,
          entry: { localId, body, createdAt: new Date().toISOString(), status: 'sending' },
        }),
      );
      void deliver(localId, body);
    },
    [deliver, dispatch, orderId],
  );

  const retry = useCallback(
    (entry: OutboxEntry) => {
      dispatch(messageRetried({ orderId, localId: entry.localId }));
      void deliver(entry.localId, entry.body);
    },
    [deliver, dispatch, orderId],
  );

  return { send, retry };
}
