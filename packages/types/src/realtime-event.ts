import type { OrderStatus } from './order.js';

/**
 * What the server pushes down a socket, as both apps read it (issue #168).
 *
 * **This is a contract that crosses the WS boundary, so it lives here rather
 * than in either app** (CLAUDE.md §2). It is also the reason the names below
 * are a union of string literals and not a `const` object: this package ships
 * TypeScript source with no build step, which holds only while every export is
 * a type. A runtime value here would make it a real dependency of the React
 * Native bundle.
 *
 * Each side therefore writes the literal it uses and lets {@link
 * RealtimeEventName} refuse a typo — the server in
 * `apps/api/src/modules/realtime/realtime.events.ts`, the app in its socket
 * client (#170).
 *
 * **Everything below carries ids and changed fields only.** No object graph,
 * no address, no phone number, no coordinate (CLAUDE.md §11). The client
 * applies an event to the one RTK Query cache
 * ([ADR-0017](docs/decisions/ADR-0017-state-management.md)) — patching what
 * the payload is enough to patch and invalidating the rest — rather than
 * keeping a second store fed by the socket.
 */
export type RealtimeEventName = 'order:transition' | 'order:offer';

/**
 * The common half of every event: when the server published it, in epoch
 * milliseconds.
 *
 * **A client discards an event whose `at` is strictly older than the last one
 * it applied for the same subject, and keeps a tie.** Out-of-order arrival is
 * normal under reconnection (`realtime-architecture.md` § Event payloads), and
 * this is what stops a late delivery overwriting a newer truth.
 *
 * It is the **publishing instance's** clock, taken immediately after the
 * transaction committed — not a per-order sequence and not a database
 * timestamp. Two consequences worth stating rather than discovering: two
 * events can share a millisecond, which is why the rule above keeps ties; and
 * ordering across instances is only as good as their clock skew, which is
 * sound here because the transitions of one order are separated by human-scale
 * gaps rather than racing. A client that needs certainty refetches over HTTP,
 * which it already must — the socket is not the source of truth.
 */
export interface RealtimeEvent {
  readonly at: number;
}

/**
 * An order moved, told to the parties in `order:{orderId}`.
 *
 * **The actor never receives their own transition**, matching the rule already
 * applied to notifications: the master who taps "arrived" is told by the
 * response to their own request, and a second telling would race it.
 *
 * `priceMinor` is here because the accept is the transition the customer is
 * waiting on and the frozen price is the fact it delivers
 * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)). It is null for
 * every status before an accept, and null again after a re-dispatch clears it.
 */
export interface OrderTransitionRealtimeEvent extends RealtimeEvent {
  readonly orderId: string;
  readonly status: OrderStatus;
  /** The assigned master on the committed row — null while searching. */
  readonly masterId: string | null;
  /** Minor units, e.g. `1500` for 15.00 AZN. Null until a master accepts. */
  readonly priceMinor: number | null;
}

/**
 * A broadcast wave reached this master, told to `master:{masterId}` only.
 *
 * **Not `order:{orderId}`.** A master who has been offered an order is not yet
 * a party to it and may not join its room (#167), so an offer that arrived
 * there would either be undeliverable or would mean weakening the room.
 *
 * It carries the order id and nothing else. The offer itself — the distance
 * band, the photographs, what the customer wrote — is read from
 * `GET /masters/me/offers`, which already decides how much of somebody else's
 * order a master who has not accepted it may see.
 */
export interface OrderOfferRealtimeEvent extends RealtimeEvent {
  readonly orderId: string;
}
