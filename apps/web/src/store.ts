import { combineReducers, configureStore } from '@reduxjs/toolkit';

import { webApi } from './api/web-api';
import { sessionSlice } from './session/session-slice';

const rootReducer = combineReducers({
  [webApi.reducerPath]: webApi.reducer,
  [sessionSlice.name]: sessionSlice.reducer,
});

/** A fresh store per app instance — one in the browser, one per test. */
export function createStore() {
  return configureStore({
    reducer: rootReducer,
    middleware: (getDefault) => getDefault().concat(webApi.middleware),
  });
}

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = AppStore['dispatch'];
