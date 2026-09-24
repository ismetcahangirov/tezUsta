import type {
  RealtimeSocket,
  RealtimeSocketFactory,
  RealtimeSocketOptions,
} from '../../src/realtime/realtime-socket';

/**
 * A socket the test drives, standing in for socket.io (issue #170).
 *
 * **The seam is `RealtimeSocket`, not a jest mock of the library.** What the
 * tests need to assert is what the app does when a connection drops, comes
 * back, or is refused — and none of that is easier to provoke through a real
 * transport. Faking the interface instead of the module also means a test
 * cannot accidentally assert on socket.io's internals.
 *
 * The `server*` methods are the only way a frame arrives, so every test states
 * exactly what the server did and when.
 */
export interface FakeSocket extends RealtimeSocket {
  /** The token presented on each connection attempt, in order. */
  readonly tokensPresented: readonly (string | null)[];
  /** Every inbound message, in order. */
  readonly emitted: readonly { readonly event: string; readonly payload: unknown }[];
  readonly connectCalls: number;
  readonly disconnectCalls: number;
  readonly listenerCount: number;

  /** The connection succeeded. */
  serverConnect(): void;
  /** The connection dropped; socket.io would now be retrying. */
  serverDisconnect(): void;
  /** The upgrade was refused — an expired token, most often. */
  serverRefuse(): void;
  /** One published frame. */
  serverEmit(event: string, payload: unknown): void;
  /**
   * How the server answers `event` from now on (issue #187): with whatever
   * `respond` returns for the payload, or — given `null` — never at all, which
   * is the ack a dead server gives. Unscripted events keep the room answer.
   */
  answer(event: string, respond: ((payload: unknown) => unknown) | null): void;
  /**
   * Answers the oldest `event` held back by `answer(event, null)` — a slow
   * server, rather than a dead one. Returns whether there was one to answer.
   */
  release(event: string, response: unknown): boolean;
}

export interface FakeSocketFactory {
  readonly factory: RealtimeSocketFactory;
  /** Every socket the connection has built, oldest first. */
  readonly sockets: readonly FakeSocket[];
  /** The most recent one, or a failure if none has been built. */
  latest(): FakeSocket;
}

function createFakeSocket(options: RealtimeSocketOptions): FakeSocket {
  const listeners = new Map<string, ((...args: readonly unknown[]) => void)[]>();
  const tokensPresented: (string | null)[] = [];
  const emitted: { event: string; payload: unknown }[] = [];
  const answers = new Map<string, ((payload: unknown) => unknown) | null>();
  const held = new Map<string, ((response: unknown) => void)[]>();
  let connectCalls = 0;
  let disconnectCalls = 0;

  function fire(event: string, payload?: unknown): void {
    for (const listener of listeners.get(event) ?? []) {
      listener(payload);
    }
  }

  return {
    get tokensPresented() {
      return tokensPresented;
    },
    get emitted() {
      return emitted;
    },
    get connectCalls() {
      return connectCalls;
    },
    get disconnectCalls() {
      return disconnectCalls;
    },
    get listenerCount() {
      return [...listeners.values()].reduce((total, list) => total + list.length, 0);
    },

    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },

    emit(event, payload, ack) {
      emitted.push({ event, payload });
      const scripted = answers.get(event);
      if (scripted === null) {
        held.set(event, [...(held.get(event) ?? []), ack]);
        return;
      }
      if (scripted !== undefined) {
        ack(scripted(payload));
        return;
      }
      // Answered the way the server answers: every join and leave resolves.
      ack({ ok: true, room: 'room' });
    },

    answer(event, respond) {
      answers.set(event, respond);
    },

    release(event, response) {
      const [oldest, ...rest] = held.get(event) ?? [];
      if (oldest === undefined) {
        return false;
      }
      held.set(event, rest);
      oldest(response);
      return true;
    },

    connect() {
      connectCalls += 1;
      // socket.io reads `auth` on every attempt, which is the behaviour a
      // rotated token depends on. Recording it here is what lets a test prove
      // the second attempt did not present the first attempt's token.
      tokensPresented.push(options.getToken());
    },

    disconnect() {
      disconnectCalls += 1;
    },

    removeAllListeners() {
      listeners.clear();
    },

    serverConnect() {
      fire('connect');
    },
    serverDisconnect() {
      fire('disconnect');
    },
    serverRefuse() {
      fire('connect_error');
    },
    serverEmit(event, payload) {
      fire(event, payload);
    },
  };
}

export function createFakeSocketFactory(): FakeSocketFactory {
  const sockets: FakeSocket[] = [];

  return {
    sockets,
    factory: (options) => {
      const socket = createFakeSocket(options);
      sockets.push(socket);
      return socket;
    },
    latest() {
      const socket = sockets.at(-1);
      if (socket === undefined) {
        throw new Error('no socket has been created');
      }
      return socket;
    },
  };
}
