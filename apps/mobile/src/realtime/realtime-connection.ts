import type {
  CallRealtimeEvent,
  CallRefusal,
  CallRequestName,
  ConversationTypingRealtimeEvent,
  ConversationTypingRequest,
  MasterPositionRealtimeEvent,
  OrderArrivalPromiseRealtimeEvent,
  OrderSearchWaveRealtimeEvent,
  MessageNewRealtimeEvent,
  MessageReadRealtimeEvent,
  OrderOfferRealtimeEvent,
  OrderPriceRealtimeEvent,
  OrderTransitionRealtimeEvent,
} from '@tezusta/types';

import type { ConnectionStatus } from './connection-slice';
import {
  CALL_EVENTS,
  CONVERSATION_TYPING_EVENT,
  MASTER_POSITION_EVENT,
  MESSAGE_NEW_EVENT,
  MESSAGE_READ_EVENT,
  ORDER_ARRIVAL_PROMISE_EVENT,
  ORDER_OFFER_EVENT,
  ORDER_PRICE_EVENT,
  ORDER_SEARCH_WAVE_EVENT,
  ORDER_TRANSITION_EVENT,
  ROOM_JOIN,
  ROOM_LEAVE,
  roomKey,
} from './realtime-events';
import type { CallFrame, CallRequestMap, RealtimeEvent, RoomRequest } from './realtime-events';
import { RECONNECTION, createRealtimeSocket } from './realtime-socket';
import type { RealtimeSocket, RealtimeSocketFactory } from './realtime-socket';

/**
 * How socket.io ended a socket that it will not bring back by itself
 * (issue #468; see `RealtimeSocket.active`).
 *
 * - `closed-by-server`: the server closed a live socket. The API does that at
 *   the access token's `exp`, and to the oldest socket of an account over its
 *   connection cap.
 * - `refused`: the server refused the handshake, most often for a token that
 *   expired.
 */
export type SocketEnding = 'closed-by-server' | 'refused';

/**
 * `retry` dials again after the backoff. `stop` leaves the socket closed until
 * the next {@link RealtimeConnection.open}, which is the next foreground.
 */
export type Recovery = 'retry' | 'stop';

/**
 * The wait before the `attempt`-th (0-based) manual reconnection.
 *
 * The same curve socket.io's own `Backoff` follows for a dropped transport
 * (`realtime-socket.ts`): doubling from {@link RECONNECTION}'s first delay to
 * its ceiling, then jittered by ± its jitter fraction, so that a deploy that
 * expires nothing still cannot bring every phone back at the same instant.
 */
export function recoveryDelayMs(attempt: number, random: () => number): number {
  const base = Math.min(RECONNECTION.delayMaxMs, RECONNECTION.delayMs * 2 ** attempt);
  const deviation = base * RECONNECTION.jitter * (random() * 2 - 1);
  return Math.round(base + deviation);
}

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
  /**
   * What to do once socket.io has given up on a socket (issue #468), awaited
   * after the backoff and before dialling again.
   *
   * **The connection does not decide this itself**, because the answer is
   * about the session, not the transport: whether the token has run out, and
   * whether it can be renewed. `RealtimeProvider` answers it from the token
   * store and the shared refresh coordinator.
   *
   * `presented` is the token the ended socket last dialled with (#474). It is
   * not always the stored one: an HTTP request that got a 401 meanwhile may
   * already have rotated the pair, and only the socket's own token says
   * whether the server closed it for expiry.
   */
  readonly recover: (ending: SocketEnding, presented: string | null) => Promise<Recovery>;
  readonly createSocket?: RealtimeSocketFactory;
  readonly url?: string;
  /** Overridden in tests so the backoff's jitter is predictable. */
  readonly random?: () => number;
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
  recover,
  createSocket = createRealtimeSocket,
  url,
  random = Math.random,
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
  /** The pending manual reconnection, if socket.io has given up (issue #468). */
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Manual reconnections since the last `connect`; drives the backoff. */
  let recoveryAttempts = 0;
  /** The token the socket presented on its latest attempt, for {@link recover}. */
  let presentedToken: string | null = null;

  function cancelRecovery(): void {
    if (recoveryTimer !== undefined) {
      clearTimeout(recoveryTimer);
      recoveryTimer = undefined;
    }
    recoveryAttempts = 0;
  }

  /**
   * Dials `owner` again after the backoff, if {@link recover} says to.
   *
   * socket.io treats a server-side close and a refused handshake as final
   * (see `RealtimeSocket.active`), so without this a socket the API closed at
   * token expiry stayed closed until the next foreground, and every frame in
   * between was lost (#468). `owner` is checked after each wait because
   * `close()`, `reset()` or a new `open()` may have replaced it meanwhile, and
   * a stale socket must not dial.
   */
  function scheduleRecovery(owner: RealtimeSocket, ending: SocketEnding): void {
    if (recoveryTimer !== undefined) {
      return;
    }

    const delay = recoveryDelayMs(recoveryAttempts, random);
    recoveryAttempts += 1;
    const presented = presentedToken;

    recoveryTimer = setTimeout(() => {
      recoveryTimer = undefined;
      // A `recover` that throws is not the server saying no, so it is retried
      // like an unanswered refresh; the backoff bounds how often.
      void recover(ending, presented)
        .catch((): Recovery => 'retry')
        .then((decision) => {
          if (socket !== owner) {
            return;
          }
          if (decision === 'stop') {
            onStatus('offline');
            return;
          }
          owner.connect();
        });
    }, delay);
  }

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

      const next = createSocket({
        getToken: () => {
          presentedToken = getToken();
          return presentedToken;
        },
        ...(url === undefined ? {} : { url }),
      });
      socket = next;

      next.on('connect', () => {
        connected = true;
        recoveryAttempts = 0;
        onStatus('live');

        for (const { request } of wanted.values()) {
          send(ROOM_JOIN, request);
        }

        if (hasConnectedBefore) {
          onResumed();
        }
        hasConnectedBefore = true;
      });

      // `disconnect` covers a dropped transport, a server restart and the
      // server closing this socket. For the first two socket.io is already
      // retrying; for the last it is not (`next.active` is false), and the
      // retry is this file's job. Either way the status is `reconnecting`
      // rather than `offline`. `close()` sets `offline` itself, after
      // removing these listeners.
      next.on('disconnect', () => {
        connected = false;
        onStatus('reconnecting');
        if (!next.active) {
          scheduleRecovery(next, 'closed-by-server');
        }
      });

      // A refused upgrade — an expired or revoked token, most often — or a
      // transport that could not connect. socket.io retries only the second
      // (#468); a refusal is retried here, after `recover` has had the chance
      // to rotate the token, and `auth` reads whatever token is stored by
      // then. Nothing is logged: the refusal reason is one string by design
      // (`socket.authenticator.ts`), and a token must never reach a log
      // (CLAUDE.md §11).
      next.on('connect_error', () => {
        onStatus(hasConnectedBefore ? 'reconnecting' : 'connecting');
        if (!next.active) {
          scheduleRecovery(next, 'refused');
        }
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

      next.on(ORDER_SEARCH_WAVE_EVENT, (payload) => {
        handleEvent({
          name: 'order:search-wave',
          payload: payload as OrderSearchWaveRealtimeEvent,
        });
      });

      next.on(ORDER_ARRIVAL_PROMISE_EVENT, (payload) => {
        handleEvent({
          name: 'order:arrival-promise',
          payload: payload as OrderArrivalPromiseRealtimeEvent,
        });
      });

      next.on(ORDER_PRICE_EVENT, (payload) => {
        handleEvent({ name: 'order:price', payload: payload as OrderPriceRealtimeEvent });
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
      cancelRecovery();

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
