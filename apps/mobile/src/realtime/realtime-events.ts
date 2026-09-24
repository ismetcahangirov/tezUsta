import type {
  CallAcceptAck,
  CallActionAck,
  CallActionRequest,
  CallInviteAck,
  CallInviteRequest,
  CallRealtimeEvent,
  CallRealtimeEventName,
  CallRequestName,
  ConversationTypingRealtimeEvent,
  MasterPositionRealtimeEvent,
  MessageNewRealtimeEvent,
  MessageReadRealtimeEvent,
  OrderOfferRealtimeEvent,
  OrderTransitionRealtimeEvent,
  RealtimeEventName,
} from '@tezusta/types';

/**
 * The app's copy of the event names the server publishes (issues #168, #169).
 *
 * `packages/types` holds the union but cannot hold these as values — it ships
 * TypeScript source with no build step, which holds only while every export is
 * a type (CLAUDE.md §2). So each side writes the literal and the annotation
 * refuses a typo: a name that is not in {@link RealtimeEventName} does not
 * compile, and adding one means editing
 * `packages/types/src/realtime-event.ts` first.
 */
export const ORDER_TRANSITION_EVENT: RealtimeEventName = 'order:transition';
export const ORDER_OFFER_EVENT: RealtimeEventName = 'order:offer';
export const MASTER_POSITION_EVENT: RealtimeEventName = 'order:master-position';
/** The conversation's three frames (issue #179), consumed by #182. */
export const MESSAGE_NEW_EVENT: RealtimeEventName = 'message:new';
export const MESSAGE_READ_EVENT: RealtimeEventName = 'message:read';
/**
 * Both directions: the server relays it to the other party, and it is the one
 * frame besides a room request this client *sends* — only from a socket in the
 * order's room, which is the server's authorization for it.
 */
export const CONVERSATION_TYPING_EVENT: RealtimeEventName = 'conversation:typing';

/**
 * One event, already narrowed to the name that carried it.
 *
 * A discriminated union rather than three listeners with three shapes, so
 * `applyRealtimeEvent` is one exhaustive `switch` the compiler checks: an
 * event name added to the union above and not handled there is a build
 * failure, not a frame quietly dropped on a phone.
 */
export type RealtimeEvent =
  | { readonly name: 'order:transition'; readonly payload: OrderTransitionRealtimeEvent }
  | { readonly name: 'order:offer'; readonly payload: OrderOfferRealtimeEvent }
  | { readonly name: 'order:master-position'; readonly payload: MasterPositionRealtimeEvent }
  | { readonly name: 'message:new'; readonly payload: MessageNewRealtimeEvent }
  | { readonly name: 'message:read'; readonly payload: MessageReadRealtimeEvent }
  | { readonly name: 'conversation:typing'; readonly payload: ConversationTypingRealtimeEvent };

/**
 * What the client asks to join or leave (`apps/api` § `room.types.ts`).
 *
 * **Asking is not being granted.** The server re-reads the order and the
 * caller's profiles on every join and answers one indistinguishable refusal
 * for "not yours", "not there" and "no longer live" (#167). Nothing here may
 * assume a join succeeded; the ack says.
 */
export type RoomRequest =
  | { readonly kind: 'order'; readonly orderId: string }
  | { readonly kind: 'master'; readonly masterId: string };

/** The ack every room message resolves with. */
export type RoomAck =
  | { readonly ok: true; readonly room: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

export const ROOM_JOIN = 'room:join';
export const ROOM_LEAVE = 'room:leave';

/** A room request as one comparable string, so a set of them de-duplicates. */
export function roomKey(request: RoomRequest): string {
  return request.kind === 'order' ? `order:${request.orderId}` : `master:${request.masterId}`;
}

/**
 * The seven call frames (issue #185), as the app listens for them (#187).
 *
 * A record rather than a list so the compiler proves the set complete: a name
 * added to {@link CallRealtimeEventName} and not written here is a build
 * failure, not a frame this phone never hears.
 */
const CALL_EVENT_NAMES: Readonly<Record<CallRealtimeEventName, true>> = {
  'call:incoming': true,
  'call:accepted': true,
  'call:rejected': true,
  'call:cancelled': true,
  'call:timeout': true,
  'call:busy': true,
  'call:ended': true,
};

export const CALL_EVENTS = Object.keys(CALL_EVENT_NAMES) as readonly CallRealtimeEventName[];

/**
 * One call frame, with the name that carried it.
 *
 * **Not a {@link RealtimeEvent}, on purpose.** Everything in that union is
 * written into the RTK Query cache by `applyRealtimeEvent`; a call is not
 * cache state. Its frames drive a reducer held by whichever call surface is
 * mounted (`src/calls/`), and nothing about a call — least of all a join
 * credential — belongs in the store.
 */
export interface CallFrame {
  readonly name: CallRealtimeEventName;
  readonly payload: CallRealtimeEvent;
}

/**
 * What each call request sends and what its ack answers, keyed by the
 * server's own union so a request it does not accept cannot be typed here.
 */
export type CallRequestMap = {
  readonly [Name in CallRequestName]: Name extends 'call:invite'
    ? { readonly request: CallInviteRequest; readonly ack: CallInviteAck }
    : Name extends 'call:accept'
      ? { readonly request: CallActionRequest; readonly ack: CallAcceptAck }
      : { readonly request: CallActionRequest; readonly ack: CallActionAck };
};
