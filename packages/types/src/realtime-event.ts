import type { Message, MessageSenderKind } from './conversation.js';
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
export type RealtimeEventName =
  | 'order:transition'
  | 'order:offer'
  | 'order:master-position'
  | 'message:new'
  | 'message:read'
  | 'conversation:typing';

/**
 * The common half of every event: when the fact it reports happened, in epoch
 * milliseconds.

 * For an order event that is the publishing instance's clock immediately after
 * the transaction committed; for a position it is the database's
 * `recorded_at`, which is what the customer's map ages the marker from. Each
 * event below says which.
 *
 * **A client discards an event whose `at` is strictly older than the last one
 * it applied for the same subject, and keeps a tie.** Out-of-order arrival is
 * normal under reconnection (`realtime-architecture.md` § Event payloads), and
 * this is what stops a late delivery overwriting a newer truth.
 *
 * Where it is the **publishing instance's** clock it is not a per-order
 * sequence and not a database timestamp. Two consequences worth stating
 * rather than discovering: two
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

/**
 * Where the assigned master is, told to the customer waiting on that order
 * (issue #169).
 *
 * **Published into `order:{orderId}` and nowhere else, and only while that
 * order is live.** A master's position is PII (CLAUDE.md §11): it reaches the
 * customer on the active order, and stops reaching anybody the moment the
 * order completes, is cancelled, or is handed back by a re-dispatch. A master
 * with no active order broadcasts nothing at all — their reports still land in
 * `master_locations` and still feed dispatch.
 *
 * **Nothing here identifies the master beyond the order they are on.** No
 * master id, no name: the customer already knows who took the job, and an
 * event that named them would be a position feed keyed by person rather than
 * by order.
 *
 * **The server throttles this independently of how often the master's app
 * reports** — roughly every 15 s, configurable. The client **interpolates**
 * between points; raising the fan-out rate to make the marker smoother is the
 * wrong fix and is ruled out in `realtime-architecture.md`.
 *
 * There is no accuracy field because the ingest contract has none: `POST
 * /masters/me/location` is strict over `{ latitude, longitude }` and refuses a
 * client that invents one (#98).
 */
export interface MasterPositionRealtimeEvent extends RealtimeEvent {
  /** `at` here is `master_locations.recorded_at` — the database's clock. */
  readonly orderId: string;
  readonly latitude: number;
  readonly longitude: number;
}

/**
 * A message was written on an order's conversation, told to the other party in
 * `order:{orderId}` (issue #179).
 *
 * **The frame carries the message, not only its id**, because the acceptance
 * criterion is that it appears on the other device *without a refetch*. That
 * is safe only because the recipient is exactly the person `GET
 * /orders/:id/messages` would already have returned it to: the room is
 * party-only (#167), and `message` is presented as the recipient sees it —
 * `readAt` is null, as it always is on a message one received.
 *
 * **The sender never receives it.** They reconcile their optimistic bubble
 * against the `POST` response, which carries the same id and timestamp; a
 * frame racing that response is how one message becomes two bubbles. The same
 * exclusion covers the sender's other devices, which learn of it the way every
 * client learns of anything it missed: by refetching history over HTTP.
 */
export interface MessageNewRealtimeEvent extends RealtimeEvent {
  readonly orderId: string;
  readonly message: Message;
}

/**
 * The other party read messages up to and including `throughMessageId`, told
 * to the sender in `order:{orderId}` (issue #179).
 *
 * Only raised when the receipt actually marked something: a repeated receipt
 * is a no-op in the database and would be noise on the socket.
 *
 * The client stamps `readAt` on every message *it* sent at or before the named
 * one — the same bound the server applied, so the two cannot disagree about
 * which bubbles are read.
 */
export interface MessageReadRealtimeEvent extends RealtimeEvent {
  readonly orderId: string;
  /** Which side of the order did the reading. */
  readonly readerKind: MessageSenderKind;
  readonly throughMessageId: string;
  /** ISO-8601, the instant the server stamped. */
  readonly readAt: string;
}

/**
 * The other party is typing, told to `order:{orderId}` (issue #179).
 *
 * **Carries nothing but the order**, and needs nothing more: the sender is
 * excluded, so whoever receives it knows it is the other side. It is never
 * persisted and has no "stopped typing" twin — the client shows the indicator
 * for a few seconds after the last frame and lets it lapse, which is also what
 * makes a lost frame harmless.
 */
export interface ConversationTypingRealtimeEvent extends RealtimeEvent {
  readonly orderId: string;
}

/**
 * What a client sends to say it is typing — the one inbound frame besides a
 * room join (issue #179).
 *
 * Accepted only from a socket already in that order's room, which is the
 * authorization: room membership is decided from the database on join and
 * re-decided on every transition (#167). The server relays at most one per
 * short interval per socket, so a client may send it on every keystroke.
 */
export interface ConversationTypingRequest {
  readonly orderId: string;
}
