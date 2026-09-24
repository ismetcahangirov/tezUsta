import { api } from '../api/api-slice';
import { conversationApi, setOrderUnread } from '../conversation/conversation-endpoints';
import { placeMessage, stampRead } from '../conversation/message-history';
import { monotonicNow } from '../lib/monotonic-clock';
import { ordersApi } from '../orders/order-endpoints';
import type { AppDispatch } from '../store';

import type { RealtimeEvent } from './realtime-events';
import type { SequenceGuard } from './sequence-guard';
import { trackingApi } from './tracking-endpoints';

/**
 * The subject an event's ordering is judged against, or `null` for an event
 * that is not a state to be superseded.
 *
 * Every order event is about one order, including the offer — a master's
 * offer *is* an order they have not taken yet. So one key shape, and the guard
 * never has to know which event produced it.
 *
 * **The conversation's frames are not guarded at all** (issue #182). A message
 * is not a newer version of the order: a `message:new` stamped a millisecond
 * before the transition that followed it is still a message, and the guard
 * would drop it as "older" — silently, which is the one thing a chat may not
 * do. Each of the three is idempotent instead: a message is placed by id, a
 * read receipt only ever stamps more bubbles, and typing only restarts a lapse.
 */
function subjectOf(event: RealtimeEvent): string | null {
  switch (event.name) {
    case 'message:new':
    case 'message:read':
    case 'conversation:typing':
      return null;
    default:
      return event.payload.orderId;
  }
}

/**
 * Applies one event to the **one** cache (ADR-0017).
 *
 * **Patch what the payload is enough to patch, invalidate the rest.** A
 * transition carries the three fields that changed, so the order's own entry
 * is patched in place and the screen re-renders without a request; the order
 * *list* is invalidated instead, because a status change can move a row
 * between the open and finished sections and the payload says nothing about
 * where. That split is `realtime-architecture.md` § Event payloads, not a
 * preference.
 *
 * **Nothing here writes to a slice.** A socket that fed a parallel store would
 * give the app two answers to "what is this order's status" and no rule for
 * which wins — which is the failure ADR-0017 exists to prevent, and why even
 * the master's position goes into a cache entry (`tracking-endpoints.ts`).
 * The conversation's frames follow the same rule (issue #182): messages and
 * receipts patch the history cache, and "typing" is a cache entry with no
 * request behind it, like the position.
 *
 * **`updateQueryData` on an entry nobody is subscribed to is a no-op**, and
 * that is correct rather than a gap: an app on the order list receives a
 * transition for an order whose detail screen is not mounted, the patch finds
 * nothing, and the invalidation makes the list refetch. Nothing is lost,
 * because the socket is not the source of truth.
 */
export function applyRealtimeEvent(
  dispatch: AppDispatch,
  guard: SequenceGuard,
  event: RealtimeEvent,
): boolean {
  const subject = subjectOf(event);
  if (subject !== null && !guard.admit(subject, event.payload.at)) {
    return false;
  }

  switch (event.name) {
    case 'order:transition': {
      const { orderId, status, masterId, priceMinor } = event.payload;

      /**
       * A replacement object rather than three assignments: `Order`'s fields
       * are `readonly` in `packages/types`, which an Immer draft preserves, and
       * an alias that stripped it to make the writes compile would be dropping
       * the contract's own statement that nothing may edit an order in place.
       * Returning from the recipe is Immer's supported form and produces the
       * same patch.
       */
      /**
       * The master's rating (issue #228) is not in the frame. When the frame
       * changes *who* the master is — an accept, a re-dispatch — the cached
       * rating belongs to somebody else or nobody: it is cleared at once, and
       * the order is re-read for the new master's. Captured from the recipe,
       * which runs synchronously inside the dispatch.
       */
      let masterChanged = false;
      dispatch(
        ordersApi.util.updateQueryData('order', orderId, (draft) => {
          masterChanged = draft.masterId !== masterId;
          return {
            ...draft,
            status,
            masterId,
            priceMinor,
            masterRating: masterChanged ? null : draft.masterRating,
          };
        }),
      );
      if (masterChanged) {
        dispatch(api.util.invalidateTags([{ type: 'Order', id: orderId }]));
      }
      /**
       * `MasterJob` too (issue #199). The frames a master receives in their
       * job's room are the other party's moves — a customer cancelling — since
       * the server subtracts the actor from the broadcast, and the job read is
       * what knows whether that order is still theirs. On a customer's phone
       * nothing provides the tag and the invalidation is a no-op.
       */
      dispatch(api.util.invalidateTags([{ type: 'Order', id: 'LIST' }, 'MasterJob']));
      return true;
    }

    case 'order:offer': {
      /**
       * The whole integration with the master's feed (issue #199): a new wave
       * reached this master, so the list is re-read rather than patched — the
       * frame carries an order id and nothing a card could be built from, by
       * design (#168).
       */
      dispatch(api.util.invalidateTags([{ type: 'MasterOffer', id: 'LIST' }]));
      return true;
    }

    case 'order:master-position': {
      const position = event.payload;

      // Stamped with the arrival time here, where the frame lands, because
      // freshness is judged on the phone's own monotonic clock
      // (`ReceivedMasterPosition`).
      const received = { ...position, receivedAt: monotonicNow() };

      dispatch(
        trackingApi.util.updateQueryData('masterPosition', position.orderId, () => received),
      );
      return true;
    }

    case 'message:new': {
      const { orderId, message } = event.payload;

      /**
       * Into the history the conversation screen reads — the acceptance
       * criterion is that it appears **without a refetch**. The frame is never
       * sent to the message's author (#179), so everything arriving here was
       * written by the other party and is unread by this user until a receipt
       * says otherwise.
       */
      let repeat = false;
      dispatch(
        conversationApi.util.updateQueryData('messages', orderId, (draft) => {
          const placed = placeMessage(draft, message);
          repeat = !placed.added;
          return placed.history;
        }),
      );
      if (repeat) {
        return true;
      }

      // Every place the count is shown: the conversation (the master's job
      // screen reads it), and the customer's order screen and order list.
      dispatch(
        conversationApi.util.updateQueryData('conversation', orderId, (draft) => ({
          ...draft,
          unreadCount: draft.unreadCount + 1,
        })),
      );
      setOrderUnread(dispatch, orderId, (count) => count + 1);

      // A message ends "typing…" on the spot rather than letting it lapse under
      // the bubble that was being typed.
      dispatch(conversationApi.util.updateQueryData('typing', orderId, () => null));
      return true;
    }

    case 'message:read': {
      const { orderId, readerKind, throughMessageId, readAt } = event.payload;

      let found = true;
      dispatch(
        conversationApi.util.updateQueryData('messages', orderId, (draft) => {
          const stamped = stampRead(draft, readerKind, throughMessageId, readAt);
          found = stamped !== null;
          return stamped ?? draft;
        }),
      );
      if (!found) {
        // The receipt names a message this phone has not loaded — re-read
        // rather than guess which bubbles the bound covers.
        dispatch(api.util.invalidateTags([{ type: 'Conversation', id: orderId }]));
      }
      return true;
    }

    case 'conversation:typing': {
      // Stamped with the arrival time on this phone's monotonic clock, for the
      // reason the position is: the lapse is judged here, not by the server.
      const receivedAt = monotonicNow();
      dispatch(
        conversationApi.util.updateQueryData('typing', event.payload.orderId, () => receivedAt),
      );
      return true;
    }
  }
}
