import type { Message } from '@tezusta/types';
import { useCallback } from 'react';

import { api } from '../api/api-slice';
import { discardCachedFile } from '../lib/cached-files';
import { errorCodeOf } from '../master-jobs/error-code';
import type { AppDispatch, RootState } from '../store';
import { useAppDispatch } from '../store/hooks';
import { conversationApi, useSendMessageMutation } from './conversation-endpoints';
import { placeMessage } from './message-history';
import type { OutboxEntry, OutboxPhoto } from './outbox-slice';
import { messageFailed, messageQueued, messageRetried, messageSettled } from './outbox-slice';

/** The server's refusal for a conversation whose order has reached a terminal status. */
const NOT_WRITABLE = 'CONVERSATION_NOT_WRITABLE';

/** A photo on the message is still being re-encoded (#318); the same send succeeds shortly. */
const PHOTO_PROCESSING = 'MESSAGE_ATTACHMENT_PROCESSING';

/** A photo on the message could not be processed and never will be. */
const PHOTO_UNUSABLE = 'MESSAGE_ATTACHMENT_UNUSABLE';

/**
 * How long to wait before each automatic resend of a message refused with
 * {@link PHOTO_PROCESSING}: fifteen seconds in all, after which the bubble
 * fails and resending is the user's call. The re-encode takes seconds (#318).
 */
export const PHOTO_PROCESSING_RETRY_DELAYS_MS = [1000, 2000, 3000, 4000, 5000] as const;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const NO_PHOTOS: readonly OutboxPhoto[] = [];

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
  /**
   * Queues a message and sends it. The body is trimmed; a message with no text
   * and no photos is ignored. The photos' files belong to the message from
   * here on, and are deleted once it settles.
   */
  readonly send: (body: string, photos?: readonly OutboxPhoto[]) => void;
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
 * **One refusal is retried, and it is not an exception to that.**
 * `MESSAGE_ATTACHMENT_PROCESSING` is the server saying, definitely, that it
 * wrote nothing, because a photo is still being re-encoded (#318). Sending
 * the same message again cannot post it twice, so it is sent again on its own
 * a bounded number of times ({@link PHOTO_PROCESSING_RETRY_DELAYS_MS}) before
 * the bubble fails. `MESSAGE_ATTACHMENT_UNUSABLE` fails it with no resend.
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
    async (localId: string, body: string, photos: readonly OutboxPhoto[]): Promise<void> => {
      const attachmentIds = photos.map((photo) => photo.attachmentId);
      try {
        let message: Message | undefined;
        for (let attempt = 0; message === undefined; attempt += 1) {
          try {
            message = await sendMessage({ orderId, body, attachmentIds }).unwrap();
          } catch (error) {
            const delay = PHOTO_PROCESSING_RETRY_DELAYS_MS[attempt];
            if (errorCodeOf(error) !== PHOTO_PROCESSING || delay === undefined) {
              throw error;
            }
            await wait(delay);
          }
        }
        const sent = message;

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
                (draft) => placeMessage(draft, sent).history,
              ),
            );
          }
          inner(messageSettled({ orderId, localId }));
        });
        // The bubble now draws the server's copies; the phone's are not needed.
        for (const photo of photos) {
          discardCachedFile(photo.uri);
        }
      } catch (error) {
        const code = errorCodeOf(error);
        dispatch(messageFailed({ orderId, localId, unsendable: code === PHOTO_UNUSABLE }));

        if (code === NOT_WRITABLE) {
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
    (raw: string, photos: readonly OutboxPhoto[] = NO_PHOTOS) => {
      const body = raw.trim();
      if (body === '' && photos.length === 0) {
        return;
      }

      const localId = newLocalId();
      dispatch(
        messageQueued({
          orderId,
          entry: { localId, body, photos, createdAt: new Date().toISOString(), status: 'sending' },
        }),
      );
      void deliver(localId, body, photos);
    },
    [deliver, dispatch, orderId],
  );

  const retry = useCallback(
    (entry: OutboxEntry) => {
      dispatch(messageRetried({ orderId, localId: entry.localId }));
      void deliver(entry.localId, entry.body, entry.photos);
    },
    [deliver, dispatch, orderId],
  );

  return { send, retry };
}
