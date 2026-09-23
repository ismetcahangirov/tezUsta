/**
 * The two room shapes that exist, and the only vocabulary a refusal speaks
 * (issue #167).
 *
 * **A room name never arrives from a client.** The wire carries a discriminated
 * request — `{ kind: 'order', orderId }` or `{ kind: 'master', masterId }` —
 * and the name is built here from ids that have already been validated and
 * authorized. That is stronger than refusing an unknown room string, because
 * there is no room string to refuse: a payload that is not one of these two
 * shapes fails Zod before anything sees it, and nothing a client sends can
 * become a `join` argument.
 */

/** `order:{orderId}` — the customer and the currently assigned master. */
export function orderRoom(orderId: string): string {
  return `order:${orderId}`;
}

/** `master:{masterId}` — that master's own devices, and nobody else's. */
export function masterRoom(masterId: string): string {
  return `master:${masterId}`;
}

/**
 * `user:{userId}` — every socket one account is holding (issue #168).
 *
 * **Nothing publishes into it, and that is the point.** It exists to be
 * *excluded*: "nobody is told of their own action" is already the notification
 * rule, and on a socket both parties sit in one `order:{orderId}` room, so the
 * actor has to be subtracted from a broadcast rather than skipped when picking
 * recipients. `server.to(orderRoom(id)).except(userRoom(actorUserId))` is one
 * publish; the alternative — `fetchSockets()` and emitting per socket — is a
 * cluster round trip on every event, which `rooms.service.ts` explains is
 * exactly what publishes must not do.
 *
 * **Joined by the gateway from the socket's own authenticated actor, never
 * from the wire.** It is not one of {@link RoomRequest}'s two shapes, so there
 * is no message a client can send that names anybody's personal room —
 * including their own.
 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * What a client asks to join or leave.
 *
 * `masterId` is on the wire rather than derived from the socket's actor, and
 * that is deliberate: derived, "an account cannot join another master's room"
 * would be true by construction and therefore untestable, and the first
 * refactor to pass an id explicitly would reintroduce the hole with nothing
 * asserting against it. Carried and checked, the rule is a line of code with a
 * test pointing at it.
 */
export type RoomRequest =
  | { readonly kind: 'order'; readonly orderId: string }
  | { readonly kind: 'master'; readonly masterId: string };

/**
 * Why a room operation was refused — the socket's equivalent of the HTTP error
 * envelope's `code` (`backend-architecture.md` § Error model).
 *
 * **There are three, and the small number is the control.** A client that
 * could tell "that order does not exist" from "it exists and you are not on
 * it" would hold an existence oracle over every order in the system, which is
 * the same reason `SOCKET_UNAUTHORIZED` is one string for every authentication
 * failure. `ROOM_FORBIDDEN` therefore covers a missing order, a terminal
 * order, a foreign order and a foreign master profile alike, and the server
 * log is where an operator learns which it was.
 */
export const ROOM_ERROR_CODES = {
  /** The payload was not one of the two shapes above. */
  ROOM_INVALID: 'ROOM_INVALID',
  /** Not yours, not there, or no longer live. Deliberately indistinguishable. */
  ROOM_FORBIDDEN: 'ROOM_FORBIDDEN',
  /** This connection sent more messages than its budget allows. */
  RATE_LIMITED: 'RATE_LIMITED',
} as const;

export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[keyof typeof ROOM_ERROR_CODES];

/**
 * The ack every inbound room message resolves with.
 *
 * An ack rather than an emitted error event, because a refusal belongs to the
 * request that caused it: a client that sent two joins and received one
 * `room:error` would not know which failed.
 */
export type RoomAck =
  | { readonly ok: true; readonly room: string }
  | { readonly ok: false; readonly code: RoomErrorCode; readonly message: string };

/**
 * The one sentence a client is given for each code. No ids, no order status,
 * no internal detail — CLAUDE.md §11.
 */
export const ROOM_ERROR_MESSAGES: Readonly<Record<RoomErrorCode, string>> = Object.freeze({
  ROOM_INVALID: 'That is not a room.',
  ROOM_FORBIDDEN: 'You may not subscribe to that.',
  RATE_LIMITED: 'Too many messages.',
});

/** The refusal half of every ack, shared by room messages and typing frames. */
export type FrameRefusal = Extract<RoomAck, { readonly ok: false }>;

/**
 * The ack a `conversation:typing` frame resolves with (issue #179).
 *
 * `ok: true` means the frame was accepted, **not** that it was relayed: the
 * server passes on at most one per short interval (`typing-relay.ts`), and a
 * client has no use for knowing which of its keystrokes were the one.
 */
export type TypingAck = { readonly ok: true } | FrameRefusal;

export function roomFailure(code: RoomErrorCode): FrameRefusal {
  return { ok: false, code, message: ROOM_ERROR_MESSAGES[code] };
}
