import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';

import { api } from '../api/api-slice';
import { tokenStore } from '../auth/token-store';
import type { TokenStore } from '../auth/token-store';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { selectAuthStatus } from '../store/session-slice';

import { applyRealtimeEvent } from './apply-realtime-event';
import { connectionChanged } from './connection-slice';
import { createRealtimeConnection } from './realtime-connection';
import type { RealtimeConnection, RealtimeConnectionOptions } from './realtime-connection';
import { createSequenceGuard } from './sequence-guard';

/**
 * The connection every screen shares, or `null` where there is no provider.
 *
 * `null` rather than a throwing `useContext` guard: a component test that
 * renders a screen without the app root is testing that screen, not the
 * socket, and it must not be forced to stand up a connection to do it. The
 * screens degrade to HTTP with no socket at all, which is a requirement of
 * #170 rather than a convenience — so the same degradation covers this case
 * for free.
 */
const RealtimeContext = createContext<RealtimeConnection | null>(null);

export function useRealtimeConnection(): RealtimeConnection | null {
  return useContext(RealtimeContext);
}

export interface RealtimeProviderProps {
  readonly children: React.ReactNode;
  /** Replaced in tests by a fake transport. */
  readonly createConnection?: (options: RealtimeConnectionOptions) => RealtimeConnection;
  readonly tokens?: TokenStore;
}

/**
 * One socket for the app, opened when there is a session and closed when there
 * is not (issue #170).
 *
 * **It lives at the root, above the router.** A `useEffect` that opened a
 * socket inside a screen would open one per screen, and two of them would each
 * count against `REALTIME_MAX_CONNECTIONS_PER_USER` and each receive every
 * frame. There is one here, and screens ask it for rooms.
 *
 * **The app must work with the socket permanently down.** Nothing below waits
 * for a connection, nothing blocks on one, and no screen reads its data from
 * it: every query is HTTP and the socket only ever *patches* what HTTP already
 * loaded. A phone on a network that blocks WebSocket sees a `reconnecting`
 * indicator and a fully working app.
 *
 * **Backgrounding drops the socket deliberately.** React Native freezes the JS
 * thread, so a socket "kept" across an hour in a pocket is a connection the OS
 * may have torn down without telling anyone, feeding a screen that looks live.
 * Dropping it and reconnecting on foreground makes the refetch happen too,
 * which is the only thing that repairs what was missed.
 */
export function RealtimeProvider({
  children,
  createConnection = createRealtimeConnection,
  tokens = tokenStore,
}: RealtimeProviderProps): React.JSX.Element {
  const dispatch = useAppDispatch();
  const status = useAppSelector(selectAuthStatus);

  /**
   * One guard per provider, reset with the session.
   *
   * A ref rather than state: discarding an out-of-order frame must not
   * re-render anything, and the guard is read inside a callback that React
   * does not own.
   */
  const guard = useRef(createSequenceGuard());

  /**
   * The connection is built once and never rebuilt, because rebuilding it
   * would mean a new socket every time `dispatch` or a callback identity
   * changed. The callbacks below therefore close over `dispatch`, which
   * `react-redux` guarantees is stable for the life of the store.
   */
  const connection = useMemo(
    () =>
      createConnection({
        getToken: () => tokens.getAccessToken(),
        onStatus: (next) => dispatch(connectionChanged(next)),
        onEvent: (event) => applyRealtimeEvent(dispatch, guard.current, event),
        onResumed: () => {
          /**
           * **Everything the socket could have changed, refetched over HTTP.**
           * A gap is not a list of missed events — it is an unknown — so the
           * client re-reads rather than replays (`realtime-architecture.md`:
           * "events are not a durable log"). The position is not invalidated
           * because it cannot be refetched: it has no endpoint, and a point
           * from before the gap must never be shown as live afterwards, so it
           * is simply waited for.
           */
          dispatch(api.util.invalidateTags(['Order']));
        },
      }),
    [createConnection, dispatch, tokens],
  );

  useEffect(() => {
    if (status !== 'signed-in') {
      // Covers sign-out and the `restoring` window at launch alike. Resetting
      // rather than closing is what stops a second account inheriting the
      // first one's rooms.
      connection.reset();
      guard.current.reset();
      return;
    }

    connection.open();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        connection.open();
        return;
      }
      // `inactive` is iOS's app-switcher preview and a moment later is usually
      // `active` again — but it is also the first half of every real
      // backgrounding, and reopening costs one handshake. Treating both the
      // same keeps this from needing to predict which it was.
      connection.close();
    });

    return () => {
      subscription.remove();
      connection.close();
    };
  }, [connection, status]);

  return <RealtimeContext.Provider value={connection}>{children}</RealtimeContext.Provider>;
}
