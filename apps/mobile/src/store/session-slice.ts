import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Client-only state. The server owns everything else — orders, masters,
 * services — and that lives in RTK Query
 * (docs/architecture/frontend-architecture.md).
 *
 * The active role is a UI preference, not an authorisation decision. The API
 * re-checks the caller's role on every request (CLAUDE.md §11), so changing it
 * here grants nothing.
 */
export type AppRole = 'customer' | 'master';

export interface SessionState {
  role: AppRole;
}

const initialState: SessionState = {
  role: 'customer',
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    roleSelected(state, action: PayloadAction<AppRole>) {
      state.role = action.payload;
    },
  },
  selectors: {
    selectRole: (state) => state.role,
  },
});

export const { roleSelected } = sessionSlice.actions;
export const { selectRole } = sessionSlice.getSelectors(
  (root: { session: SessionState }) => root.session,
);

export const sessionReducer = sessionSlice.reducer;
