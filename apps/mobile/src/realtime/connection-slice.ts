import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * What the app can honestly say about its socket.
 *
 * **Client state, so Redux rather than the RTK Query cache** — nothing here
 * came from the server (`docs/architecture/frontend-architecture.md` § State
 * management). It is the one thing the socket writes into a slice, and it is
 * *about* the socket rather than about an order.
 *
 * `offline` is both "no session, so no socket" and "the socket is not coming
 * back on its own". A screen renders the same thing for either: the data it
 * already has, read over HTTP. There is deliberately no `error`; a socket the
 * app cannot open is not a failure a customer can act on, and every screen
 * works without it.
 */
export type ConnectionStatus = 'offline' | 'connecting' | 'live' | 'reconnecting';

export interface RealtimeState {
  status: ConnectionStatus;
}

const initialState: RealtimeState = { status: 'offline' };

/**
 * Selectors are declared **on the slice**, the way `session-slice.ts` declares
 * its own, and not as functions taking `RootState`.
 *
 * That is not a style preference: `createAppStore` imports this reducer, so a
 * selector that imported `RootState` back from `../store` would close a cycle
 * — and `no-circular` is a CI-failing rule (CLAUDE.md §14). RTK namespaces
 * these under the slice's own `name`, which is where the reducer is mounted.
 */
const realtimeSlice = createSlice({
  name: 'realtime',
  initialState,
  reducers: {
    connectionChanged(state, action: PayloadAction<ConnectionStatus>) {
      state.status = action.payload;
    },
  },
  selectors: {
    selectConnectionStatus: (state): ConnectionStatus => state.status,
    /**
     * Whether a screen may present what it is showing as live.
     *
     * One selector rather than each screen comparing strings, because the
     * question has one answer and #172 renders a different state for it.
     * `connecting` is not live: at launch there is nothing to be live about
     * yet.
     */
    selectIsLive: (state): boolean => state.status === 'live',
  },
});

export const { connectionChanged } = realtimeSlice.actions;
export const realtimeReducer = realtimeSlice.reducer;
export const { selectConnectionStatus, selectIsLive } = realtimeSlice.selectors;
