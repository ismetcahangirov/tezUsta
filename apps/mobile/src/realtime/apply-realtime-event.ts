import { api } from '../api/api-slice';
import { monotonicNow } from '../lib/monotonic-clock';
import { ordersApi } from '../orders/order-endpoints';
import type { AppDispatch } from '../store';

import type { RealtimeEvent } from './realtime-events';
import type { SequenceGuard } from './sequence-guard';
import { trackingApi } from './tracking-endpoints';

/**
 * The subject an event's ordering is judged against.
 *
 * Every event this app receives is about one order, including the offer — a
 * master's offer *is* an order they have not taken yet. So one key shape, and
 * the guard never has to know which event produced it.
 */
function subjectOf(event: RealtimeEvent): string {
  return event.payload.orderId;
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
  if (!guard.admit(subjectOf(event), event.payload.at)) {
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
      dispatch(
        ordersApi.util.updateQueryData('order', orderId, (draft) => ({
          ...draft,
          status,
          masterId,
          priceMinor,
        })),
      );
      dispatch(api.util.invalidateTags([{ type: 'Order', id: 'LIST' }]));
      return true;
    }

    case 'order:offer': {
      /**
       * **Nothing provides this tag yet, and the invalidation is still the
       * right line to write.** The master's offer feed is EPIC 8/9's job
       * list and does not exist in this app; RTK Query tolerates invalidating
       * a declared tag nobody provides, so this is a no-op today and becomes
       * the whole integration the day the feed lands. The alternative — a
       * `default:` that silently ignores offers — is a frame the server sent
       * and the client threw away with nothing saying so.
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
  }
}
