import { configureStore } from '@reduxjs/toolkit';

import { api } from '../api/api-slice';
import { realtimeReducer } from '../realtime/connection-slice';

import { sessionReducer } from './session-slice';

/**
 * One store, configured in one place.
 *
 * `configureStore` is used rather than `createStore` for the defaults that
 * matter on a mid-range Android device: the serialisability and immutability
 * checks run in development only, so they cost nothing in a release build
 * while still catching the two mistakes that make Redux state hard to reason
 * about.
 */
export function createAppStore() {
  return configureStore({
    reducer: {
      session: sessionReducer,
      // Whether the socket is up — client state about the transport, never
      // server state (issue #170, `src/realtime/connection-slice.ts`).
      realtime: realtimeReducer,
      [api.reducerPath]: api.reducer,
    },
    // RTK Query's middleware is what runs the cache lifetime, the polling and
    // the invalidation. Without it the api slice holds data forever and
    // nothing is ever refetched.
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(api.middleware),
  });
}

export const store = createAppStore();

export type AppStore = ReturnType<typeof createAppStore>;
export type RootState = ReturnType<AppStore['getState']>;
export type AppDispatch = AppStore['dispatch'];
