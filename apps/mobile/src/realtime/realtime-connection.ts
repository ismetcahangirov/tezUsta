import type {
  CallRealtimeEvent,
  CallRefusal,
  CallRequestName,
  ConversationTypingRealtimeEvent,
  ConversationTypingRequest,
  MasterPositionRealtimeEvent,
  MessageNewRealtimeEvent,
  MessageReadRealtimeEvent,
  OrderOfferRealtimeEvent,
  OrderTransitionRealtimeEvent,
} from '@tezusta/types';

import type { ConnectionStatus } from './connection-slice';
import {
  CALL_EVENTS,
  CONVERSATION_TYPING_EVENT,
  MASTER_POSITION_EVENT,
  MESSAGE_NEW_EVENT,
  MESSAGE_READ_EVENT,
  ORDER_OFFER_EVENT,
  ORDER_TRANSITION_EVENT,
  ROOM_JOIN,
  ROOM_LEAVE,
  roomKey,
} from './realtime-events';
import type { CallFrame, CallRequestMap, RealtimeEvent, RoomRequest } from './realtime-events';
import { createRealtimeSocket } from './realtime-socket';
import type { RealtimeSocket, RealtimeSocketFactory } from './realtime-socket';

export interface RealtimeConnectionOptions {
  /** Read per connection attempt, never captured — see `realtime-socket.ts`. */
  readonly getToken: () => string | null;
  readonly onEvent: (event: RealtimeEvent) => void;
  readonly onStatus: (status: ConnectionStatus) => void;
  /**
   * Called on every **re**-connection, and never on the first one.
   *
   * "On reconnect the client refetches state over HTTP and then resumes
   * listening" is the rule that keeps a missed event from leaving the UI
   * permanently wrong (`realtime-architecture.md` § Connection lifecycle).
   * The first connection needs no refetch: the screen that opened has already
   * loaded over HTTP.
   */
  readonly onResumed: () => void;
  readonly createSocket?: RealtimeSocketFactory;
  readonly url?: string;
}

export interface RealtimeConnection {
  open(): void;
  /**
   * Drops the socket but **remembers what it was listening to**.
   *
   * This is what the app does when it goes into the background: React Native
   * freezes the JS thread, and a socket assumed to have survived an hour in a
   * pocket is a screen showing an hour-old order. The screens do not unmount,
   * so they will not re-join — the wanted set is the only thing that can, and
   * {@link open} replays it. Coming back also counts as a reconnection, so the
   * refetch fires.
   */
  close(): void;
  /**
   * Everything {@link close} does, plus forgetting the session: the rooms, and
   * that there ever was a connection.
   *
   * Signing out, and only signing out. A socket reopened after this
   * authenticates as whoever is signed in now and listens to nothing the
   * previous account asked for.
   */
  reset(): void;
  /**
   * Ask to join, and stay joined across reconnects until {@link leave}.
   *
   * **Counted, not a flag** (issue #182). Two screens can want the same order
   * at once — the order screen and the conversation pushed over it, or the
   * master's work provider and their job's conversation — and the first of
   * them to unmount must not take the room away from the other. So a room is
   * joined when its first holder asks and left when its last holder leaves.
   */
  join(request: RoomRequest): void;
  leave(request: RoomRequest): void;
  /**
   * Tells the other party this user is typing in the order's conversation
   * (issue #179). Fire-and-forget: unlike a room it is not remembered, so
   * nothing re-sends it after a reconnect, and with no socket it goes nowhere.
   * A frame socket.io buffered across a short drop arrives late and simply
   * lapses on the other phone. The server accepts it only from a socket in
   * the order's room and relays at most one per two seconds;
   * `useTypingSignal` throttles to the same interval, to spare the uplink.
   */
  signalTyping(orderId: string): void;
  /**
   * Hears every call frame (issue #187) until the returned function is called.
   *
   * **A subscription rather than an `onEvent` case**, because a call frame is
   * not cache state (see {@link CallFrame}): whichever call surface is mounted
   * holds the reducer the frames drive, and nothing is listening when none is.
   * Subscribers outlive a reconnect — they are held here, not on the socket.
   */
  subscribeToCalls(listener: (frame: CallFrame) => void): () => void;
  /**
   * Sends one call request and resolves with the server's ack.
   *
   * **It never rejects, and it never waits forever.** With no live socket it
   * answers `CALL_UNAVAILABLE` at once rather than letting socket.io buffer
   * the frame: a buffered invite flushed on reconnect would ring somebody a
   * minute after the caller gave up. An ack that has not come back within
   * {@link CALL_ACK_TIMEOUT_MS} answers `CALL_UNAVAILABLE` too — the server's
   * own word for "could not complete the frame just now".
   */
  requestCall<Name extends CallRequestName>(
    name: Name,
    request: CallRequestMap[Name]['request'],
  ): Promise<CallRequestMap[Name]['ack'] | CallRefusal>;
}

/**
 * How long a call request waits for its ack before the client answers for it.
 *
 * Generous against a server that answers in milliseconds, because the cost of
 * giving up early is a call the user sees fail while the other phone rings; the
 * cost of waiting is a spinner. The server's own ring timeout (30 s by default)
 * bounds anything this leaves behind.
 */
export const CALL_ACK_TIMEOUT_MS = 10_000;

/** The refusal the client gives in the server's words when the server cannot. */
export function unavailableCallRefusal(): CallRefusal {
  return {
    ok: false,
    code: 'CALL_UNAVAILABLE',
    message: 'The call could not be completed right now.',
  };
}

/**
 * The app's one socket, and everything that is true about it regardless of
 * React (issue #170).
 *
 * **A plain object rather than a hook**, so the behaviour that matters —
 * reconnection, re-joining rooms, refetching after a gap — is testable against
 * a fake transport without rendering anything, and so there is exactly one
 * connection no matter how many components are interested in it.
 *
 * **Rooms are remembered, not re-requested by the screens.** A reconnect is a
 * new connection on the server: socket.io re-runs the authenticating
 * middleware and the new socket is in no rooms at all. If re-joining were the
 * screens' job, a customer whose train went into a tunnel would come back to a
 * live-looking screen that receives nothing. So the desired set is held here
 * and replayed on every `connect`.
 *
 * **A refused join is not retried and not surfaced.** The server answers one
 * indistinguishable refusal for "not yours", "not there" and "no longer live"
 * (#167), and all three mean the same thing to a client: there is nothing to
 * listen to. The screen's data still comes over HTTP, which is the behaviour
 * every refusal degrades to.
 */
export function createRealtimeConnection({
  getToken,
  onEvent,
  onStatus,
  onResumed,
  createSocket = createRealtimeSocket,
  url,
}: RealtimeConnectionOptions): RealtimeConnection {
  /** Each wanted room, and how many holders currently want it. */
  const wanted = new Map<string, { readonly request: RoomRequest; holders: number }>();
  let socket: RealtimeSocket | undefined;
  let hasConnectedBefore = false;
  /**
   * Whether the socket is connected **right now** — not merely built. Only a
   * call request reads it: a room join sent while disconnected is harmless
   * because `connect` replays the wanted set anyway, but a call frame is not
   * something to deliver late (see {@link RealtimeConnection.requestCall}).
   */
  let connected = false;
  const callListeners = new Set<(frame: CallFrame) => void>();

  function send(event: string, request: RoomRequest | ConversationTypingRequest): void {
    socket?.emit(event, request, () => {
      // The ack is consumed and discarded on purpose. See the class comment:
      // a refusal has one meaning for the client and it is the one the screen
      // already handles. Consuming it still matters — socket.io keeps an
      // un-acked callback registered for the life of the connection.
    });
  }

  function handleEvent(event: RealtimeEvent): void {
    onEvent(event);
  }

  return {
    open() {
      if (socket !== undefined) {
        return;
      }

      const next = createSocket({ getToken, ...(url === undefined ? {} : { url }) });
      socket = next;

      next.on('connect', () => {
        connected = true;
        onStatus('live');

        for (const { request } of wanted.values()) {
          send(ROOM_JOIN, request);
        }

        if (hasConnectedBefore) {
          onResumed();
        }
        hasConnectedBefore = true;
      });

      // `disconnect` covers a dropped transport and a server restart alike;
      // socket.io is already retrying by the time this fires, which is why the
      // status is `reconnecting` rather than `offline`. `close()` sets
      // `offline` itself, after removing these listeners.
      next.on('disconnect', () => {
        connected = false;
        onStatus('reconnecting');
      });

      // A refused upgrade — an expired or revoked token, most often. socket.io
      // keeps retrying and calls `auth` again each time, so a token rotated by
      // the HTTP layer in the meantime is presented on the next attempt
      // without anything here coordinating it. Nothing is logged: the refusal
      // reason is one string by design (`socket.authenticator.ts`), and a
      // token must never reach a log (CLAUDE.md §11).
      next.on('connect_error', () => {
        onStatus(hasConnectedBefore ? 'reconnecting' : 'connecting');
      });

      next.on(ORDER_TRANSITION_EVENT, (payload) => {
        handleEvent({
          name: 'order:transition',
          payload: payload as OrderTransitionRealtimeEvent,
        });
      });

      next.on(ORDER_OFFER_EVENT, (payload) => {
        handleEvent({ name: 'order:offer', payload: payload as OrderOfferRealtimeEvent });
      });

      next.on(MASTER_POSITION_EVENT, (payload) => {
        handleEvent({
          name: 'order:master-position',
          payload: payload as MasterPositionRealtimeEvent,
        });
      });

      next.on(MESSAGE_NEW_EVENT, (payload) => {
        handleEvent({ name: 'message:new', payload: payload as MessageNewRealtimeEvent });
      });

      next.on(MESSAGE_READ_EVENT, (payload) => {
        handleEvent({ name: 'message:read', payload: payload as MessageReadRealtimeEvent });
      });

      next.on(CONVERSATION_TYPING_EVENT, (payload) => {
        handleEvent({
          name: 'conversation:typing',
          payload: payload as ConversationTypingRealtimeEvent,
        });
      });

      for (const name of CALL_EVENTS) {
        next.on(name, (payload) => {
          const frame: CallFrame = { name, payload: payload as CallRealtimeEvent };
          // A copy, so a listener that unsubscribes while handling a frame —
          // a call surface unmounting because the call just ended — does not
          // skip the listener after it.
          for (const listener of [...callListeners]) {
            listener(frame);
          }
        });
      }

      onStatus('connecting');
      next.connect();
    },

    close() {
      const live = socket;
      socket = undefined;
      connected = false;

      if (live !== undefined) {
        // Listeners first. `disconnect()` fires `disconnect`, and a listener
        // still attached would report `reconnecting` for a socket that is
        // being closed deliberately — which is how a backgrounded app ends up
        // claiming it is coming back.
        live.removeAllListeners();
        live.disconnect();
      }

      onStatus('offline');
    },

    reset() {
      this.close();
      wanted.clear();
      hasConnectedBefore = false;
    },

    join(request) {
      const key = roomKey(request);
      const held = wanted.get(key);

      if (held !== undefined) {
        held.holders += 1;
        return;
      }

      wanted.set(key, { request, holders: 1 });
      send(ROOM_JOIN, request);
    },

    leave(request) {
      const key = roomKey(request);
      const held = wanted.get(key);

      if (held === undefined) {
        return;
      }
      if (held.holders > 1) {
        held.holders -= 1;
        return;
      }

      wanted.delete(key);
      send(ROOM_LEAVE, request);
    },

    signalTyping(orderId) {
      send(CONVERSATION_TYPING_EVENT, { orderId });
    },

    subscribeToCalls(listener) {
      callListeners.add(listener);
      return () => {
        callListeners.delete(listener);
      };
    },

    requestCall(name, request) {
      const live = socket;
      if (live === undefined || !connected) {
        return Promise.resolve(unavailableCallRefusal());
      }

      return new Promise((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
          settled = true;
          resolve(unavailableCallRefusal());
        }, CALL_ACK_TIMEOUT_MS);

        live.emit(name, request, (response) => {
          if (settled) {
            // The client has already answered for the server; a late ack
            // changes nothing the caller could still act on.
            return;
          }
          settled = true;
          clearTimeout(timer);
          // The server's own ack, typed by `CallRequestMap` — trusted the way
          // every inbound frame above is trusted, because the server is the
          // one writer of both.
          resolve(response as CallRequestMap[typeof name]['ack']);
        });
      });
    },
  };
}
