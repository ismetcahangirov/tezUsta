import { io } from 'socket.io-client';

import { API_BASE_URL } from '../api/base-query';

/**
 * How long the client waits before its first reconnection attempt, and the
 * ceiling it backs off to.
 *
 * **These are socket.io's own `Backoff`, and it is genuinely jittered** —
 * verified against the shipped `socket.io-client@4.8.3`
 * (`build/cjs/contrib/backo2.js`) rather than from its documentation:
 *
 * ```js
 * var ms = this.ms * Math.pow(this.factor, this.attempts++);
 * if (this.jitter) { … ms = … ms - deviation : ms + deviation; }
 * return Math.min(ms, this.max) | 0;
 * ```
 *
 * `jitter` is applied only when `0 < jitter <= 1`, which is why
 * {@link RECONNECTION_JITTER} is not left at socket.io's default of 0.5 by
 * omission — a value stated here is a value a reader can check. Without it an
 * API restart brings every phone back at the same instant, which is the
 * stampede `realtime-architecture.md` § Connection lifecycle names.
 *
 * Thirty seconds as the ceiling rather than socket.io's 5: a phone that has
 * been in a pocket through a deploy should not retry twice a minute forever,
 * and the app does not depend on the socket for correctness — every screen
 * reads its state over HTTP and refetches on foreground.
 */
const RECONNECTION_DELAY_MS = 1_000;
const RECONNECTION_DELAY_MAX_MS = 30_000;
const RECONNECTION_JITTER = 0.5;

/**
 * The socket.io surface this app uses, and nothing more.
 *
 * **An interface rather than socket.io's `Socket`, so the connection can be
 * tested without a server.** Every test below the transport injects a fake
 * that implements exactly this; the adapter in {@link createRealtimeSocket} is
 * the only code that ever touches the library, which is also what makes
 * "replace socket.io" a change to one file rather than to the app.
 */
export interface RealtimeSocket {
  on(event: string, listener: (...args: readonly unknown[]) => void): void;
  emit(event: string, payload: unknown, ack: (response: unknown) => void): void;
  connect(): void;
  disconnect(): void;
  removeAllListeners(): void;
}

export interface RealtimeSocketOptions {
  /**
   * Read **per connection attempt**, never captured. socket.io calls this
   * again on every reconnect, so a token rotated while the app was offline is
   * the one presented on the way back — retrying a dead credential is the
   * failure this shape exists to prevent.
   */
  readonly getToken: () => string | null;
  readonly url?: string;
}

export type RealtimeSocketFactory = (options: RealtimeSocketOptions) => RealtimeSocket;

/**
 * The real socket, built once per session.
 *
 * `transports: ['websocket']` — no HTTP long-polling. React Native has a
 * `WebSocket` global and `engine.io-client`'s `browser` field maps its
 * `*.node.js` transports onto the browser ones, which is what keeps `ws` and
 * `xmlhttprequest-ssl` out of the app bundle entirely (verified against
 * `metro-resolver`'s `redirectModulePath` and Expo's
 * `resolverMainFields: ['react-native', 'browser', 'main']`). Leaving polling
 * enabled would also mean a first connection over XHR on every launch, which
 * on a mobile network is the slow path for no gain.
 *
 * `autoConnect: false` because *when* to connect is a session and lifecycle
 * question this file does not own (`useRealtime.ts`). A socket that dialled on
 * construction would be a connection opened by an import.
 *
 * `auth` is a **callback**. socket.io invokes it before each attempt, which is
 * the whole reason the token is not a constructor argument.
 */
export const createRealtimeSocket: RealtimeSocketFactory = ({ getToken, url = API_BASE_URL }) => {
  const socket = io(url, {
    transports: ['websocket'],
    autoConnect: false,
    auth: (send: (payload: { token: string }) => void) => {
      send({ token: getToken() ?? '' });
    },
    reconnection: true,
    reconnectionDelay: RECONNECTION_DELAY_MS,
    reconnectionDelayMax: RECONNECTION_DELAY_MAX_MS,
    randomizationFactor: RECONNECTION_JITTER,
  });

  // Returned as `RealtimeSocket` with no assertion: socket.io's `Socket`
  // already satisfies it structurally, so the narrowing is the compiler's
  // rather than a claim this file makes. That is the useful property — a
  // library whose surface stopped matching would fail here at build time
  // instead of at a phone.
  return socket;
};

/** Exported for the test that asserts the backoff is bounded and jittered. */
export const RECONNECTION = Object.freeze({
  delayMs: RECONNECTION_DELAY_MS,
  delayMaxMs: RECONNECTION_DELAY_MAX_MS,
  jitter: RECONNECTION_JITTER,
});
