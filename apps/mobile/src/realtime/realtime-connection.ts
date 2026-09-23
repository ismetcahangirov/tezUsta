import type {
  MasterPositionRealtimeEvent,
  OrderOfferRealtimeEvent,
  OrderTransitionRealtimeEvent,
} from '@tezusta/types';

import type { ConnectionStatus } from './connection-slice';
import {
  MASTER_POSITION_EVENT,
  ORDER_OFFER_EVENT,
  ORDER_TRANSITION_EVENT,
  ROOM_JOIN,
  ROOM_LEAVE,
  roomKey,
} from './realtime-events';
import type { RealtimeEvent, RoomRequest } from './realtime-events';
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
  /** Ask to join, and stay joined across reconnects until {@link leave}. */
  join(request: RoomRequest): void;
  leave(request: RoomRequest): void;
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
  const wanted = new Map<string, RoomRequest>();
  let socket: RealtimeSocket | undefined;
  let hasConnectedBefore = false;

  function send(event: string, request: RoomRequest): void {
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
        onStatus('live');

        for (const request of wanted.values()) {
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

      onStatus('connecting');
      next.connect();
    },

    close() {
      const live = socket;
      socket = undefined;

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
      wanted.set(roomKey(request), request);
      send(ROOM_JOIN, request);
    },

    leave(request) {
      wanted.delete(roomKey(request));
      send(ROOM_LEAVE, request);
    },
  };
}
