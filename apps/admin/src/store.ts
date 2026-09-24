import { combineReducers, configureStore } from '@reduxjs/toolkit';

import { adminApi } from './api/admin-api';
import { sessionSlice } from './session/session-slice';

const rootReducer = combineReducers({
  [adminApi.reducerPath]: adminApi.reducer,
  [sessionSlice.name]: sessionSlice.reducer,
});

/** A fresh store per app instance — one in the browser, one per test. */
export function createStore() {
  return configureStore({
    reducer: rootReducer,
    middleware: (getDefault) => getDefault().concat(adminApi.middleware),
  });
}

export type AppStore = ReturnType<typeof createStore>;
export type RootState = ReturnType<typeof rootReducer>;
export type AppDispatch = AppStore['dispatch'];
