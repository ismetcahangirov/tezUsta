import type { Conversation, CursorPage, Message } from '@tezusta/types';

import { api } from '../api/api-slice';
import { ordersApi } from '../orders/order-endpoints';
import type { AppDispatch } from '../store';

/** How many messages one history page asks for — the server's own default. */
export const MESSAGE_PAGE_SIZE = 30;

export interface SendMessageArg {
  readonly orderId: string;
  readonly body: string;
}

export interface MarkReadArg {
  readonly orderId: string;
  readonly throughMessageId: string;
}

/** The tag for one order's conversation *and* its history — a reconnection re-reads both. */
function conversationTag(orderId: string) {
  return { type: 'Conversation' as const, id: orderId };
}

/**
 * One order's conversation (issue #182, [ADR-0033](docs/decisions/ADR-0033-in-order-messaging.md)).
 *
 * **HTTP is the source of truth; the socket only patches** (ADR-0033 § 3). The
 * history is read here, a send is a `POST` whose response carries the id and
 * timestamp the optimistic bubble settles to, and a read receipt is a `POST`
 * because unread counts are state. `applyRealtimeEvent` writes the three
 * conversation frames into these same entries, and a reconnection invalidates
 * the `Conversation` tag so the history is re-read rather than replayed.
 *
 * **No mutation here invalidates.** Each one knows exactly what it changed and
 * patches that, because the thing an invalidation would refetch is the history
 * a user is scrolling through — a refetch per send would reset the page they
 * are reading and spend a mobile connection on messages it already holds.
 */
export const conversationApi = api.injectEndpoints({
  endpoints: (build) => ({
    /**
     * The conversation itself: whether it can be written to and how much of it
     * is unread. A 404 means there is none — the order never had a master, or
     * the one it had gave it back — and never "not yours" as distinct from that.
     */
    conversation: build.query<Conversation, string>({
      query: (orderId) => `/orders/${orderId}/conversation`,
      providesTags: (_result, _error, orderId) => [conversationTag(orderId)],
    }),

    /**
     * The history, newest page first and newest message first within a page —
     * the order an inverted list renders from the bottom up.
     *
     * **An infinite query**, for the reason `customerOrders` gives: an
     * invalidation refetches the pages it holds rather than the last cursor,
     * so a reconnection re-reads what is on screen instead of merging a stale
     * page into a fresh one. The cursor is the server's and opaque.
     */
    messages: build.infiniteQuery<CursorPage<Message>, string, string | null>({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      },
      query: ({ queryArg: orderId, pageParam }) => ({
        url: `/orders/${orderId}/messages`,
        params:
          pageParam === null
            ? { limit: MESSAGE_PAGE_SIZE }
            : { limit: MESSAGE_PAGE_SIZE, cursor: pageParam },
      }),
      providesTags: (_result, _error, orderId) => [conversationTag(orderId)],
    }),

    /**
     * Writes one message. The caller holds the optimistic bubble (the outbox)
     * and places the response into the history itself — see `useSendMessage`,
     * which is where "the bubble becomes the server's message" has to happen
     * in a single step.
     *
     * **`maxRetries: 0` — the one endpoint that overrides the shared retry
     * policy, and why.** The base query retries a failure with no status and a
     * 5xx (`src/api/base-query.ts`), which is safe for a read and for an order
     * creation that carries an idempotency key. A message carries none: a
     * `POST` whose response was lost has usually *arrived*, and a silent
     * retry would post the same words twice into a transcript that is
     * write-once and may become evidence (ADR-0033). So a failure surfaces at
     * once as a failed bubble, and sending again is the user's decision.
     */
    sendMessage: build.mutation<Message, SendMessageArg>({
      query: ({ orderId, body }) => ({
        url: `/orders/${orderId}/messages`,
        method: 'POST',
        body: { body },
      }),
      extraOptions: { maxRetries: 0 },
    }),

    /**
     * Marks everything the other party wrote up to and including one message
     * as read. The response is the conversation with the new unread count,
     * which is written straight into every place that shows it.
     */
    markMessagesRead: build.mutation<Conversation, MarkReadArg>({
      query: ({ orderId, throughMessageId }) => ({
        url: `/orders/${orderId}/messages/read`,
        method: 'POST',
        body: { throughMessageId },
      }),
      async onQueryStarted({ orderId }, { dispatch, queryFulfilled }) {
        try {
          const { data } = await queryFulfilled;
          void dispatch(conversationApi.util.upsertQueryData('conversation', orderId, data));
          setOrderUnread(dispatch as AppDispatch, orderId, () => data.unreadCount);
        } catch {
          // A receipt that failed changed nothing on the server; the badge
          // stays as it is and the next receipt covers the same messages.
        }
      },
    }),

    /**
     * When the other party was last seen typing, by this phone's monotonic
     * clock, or `null`.
     *
     * A cache entry with no request behind it, for the reason
     * `tracking-endpoints.ts` gives for the master's position: the frame is
     * server state that has no endpoint, and ADR-0017 allows one cache. It is
     * never persisted anywhere and `keepUnusedDataFor: 0` drops it the moment
     * no conversation is on screen.
     */
    typing: build.query<number | null, string>({
      queryFn: () => ({ data: null }),
      keepUnusedDataFor: 0,
    }),
  }),
});

export const {
  useConversationQuery,
  useMessagesInfiniteQuery,
  useSendMessageMutation,
  useMarkMessagesReadMutation,
  useTypingQuery,
} = conversationApi;

/**
 * Rewrites the customer's unread count wherever an order carries it: the order
 * screen's entry and the order list's row (issue #182).
 *
 * Both are patched in place rather than invalidated — a message arriving or
 * being read changes one number, and refetching every loaded page of the order
 * list for it would be the chattiest possible answer. On a master's phone
 * neither entry exists and both patches are no-ops; the master's badge reads
 * the conversation entry, which the caller patches separately.
 */
export function setOrderUnread(
  dispatch: AppDispatch,
  orderId: string,
  next: (current: number) => number,
): void {
  dispatch(
    ordersApi.util.updateQueryData('order', orderId, (draft) => ({
      ...draft,
      unreadMessageCount: Math.max(0, next(draft.unreadMessageCount)),
    })),
  );
  dispatch(
    ordersApi.util.updateQueryData('customerOrders', undefined, (draft) => ({
      ...draft,
      pages: draft.pages.map((page) => ({
        ...page,
        items: page.items.map((order) =>
          order.id === orderId
            ? { ...order, unreadMessageCount: Math.max(0, next(order.unreadMessageCount)) }
            : order,
        ),
      })),
    })),
  );
}
