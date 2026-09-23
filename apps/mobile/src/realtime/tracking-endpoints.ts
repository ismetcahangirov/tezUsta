import type { MasterPositionRealtimeEvent } from '@tezusta/types';

import { api } from '../api/api-slice';

/**
 * A position as this phone received it: the server's payload, plus the moment
 * it arrived by this phone's clock.
 *
 * **Why the receipt time is stored, not derived** (#172). Staleness has to be
 * judged on one clock, and the payload's `at` is the server's: a phone whose
 * clock runs a minute slow would draw a two-minute-old point as live. The
 * frame's arrival is the one moment both halves of that comparison can be read
 * on the phone, and it is known only where the frame lands —
 * `applyRealtimeEvent` — so that is where it is written. `at` keeps its one
 * job, which is ordering. It is not a second store: it is a fact about this
 * cache entry, kept in the entry.
 *
 * `receivedAt` is read from `monotonicNow()`, not `Date.now()`: it is only
 * ever compared with other readings of that clock, and a wall clock stepped
 * backwards would make an old point look young.
 */
export type ReceivedMasterPosition = MasterPositionRealtimeEvent & {
  readonly receivedAt: number;
};

/**
 * Where the master's last known position lives (issue #169 on the wire, #172
 * on screen).
 *
 * **A cache entry with no request behind it, and that is the point.** The
 * position has no HTTP endpoint and never will: it is pushed to the one
 * customer entitled to it, for as long as the order is live, and a
 * `GET /orders/:id/position` would be a way to ask for somebody's location
 * outside that window. But ADR-0017 says there is **one** cache for server
 * state and the socket may not become a second store — so the position goes
 * where every other server fact goes, and `queryFn` is how RTK Query models a
 * cache entry that is written rather than fetched.
 *
 * What that buys, concretely: the screen subscribes with `useMasterPositionQuery`
 * and gets RTK Query's own lifetime, invalidation and unsubscribe behaviour,
 * and `applyRealtimeEvent` writes through `updateQueryData` like every other
 * event. A slice would have meant two stores and two ways to be stale.
 *
 * **`keepUnusedDataFor: 0`.** A position is the most sensitive thing this app
 * holds (CLAUDE.md §11), and it stops being true within seconds. The moment no
 * screen is watching an order, its last point is dropped rather than kept for
 * the default five minutes — so it cannot be re-rendered as live when the
 * screen comes back, and the screen has to wait for a fresh one.
 */
export const trackingApi = api.injectEndpoints({
  endpoints: (build) => ({
    /**
     * The last position received for one order, or `null` if none has arrived.
     *
     * `null` is the honest initial value and `undefined` is not available: RTK
     * Query reads an entry with no data as "not loaded", and this entry is
     * always loaded — it is simply often empty. #172 renders "no live
     * position" from the `null`, and staleness from `receivedAt`.
     */
    masterPosition: build.query<ReceivedMasterPosition | null, string>({
      queryFn: () => ({ data: null }),
      keepUnusedDataFor: 0,
    }),
  }),
});

export const { useMasterPositionQuery } = trackingApi;
