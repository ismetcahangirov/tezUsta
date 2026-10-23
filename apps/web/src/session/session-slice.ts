import { createSlice } from '@reduxjs/toolkit';

/**
 * Whether this tab believes it still has a session.
 *
 * Deliberately holds no token and no identity: the session lives in two
 * httpOnly cookies the page cannot read (ADR-0061 § 2), and the master's
 * subscription comes from RTK Query. The only fact kept here is the one no
 * request can answer by itself — that a refresh was refused, so the page must
 * give way to the sign-in form.
 */
export interface SessionState {
  readonly signedOut: boolean;
}

const initialState: SessionState = { signedOut: false };

export const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    signedIn: () => ({ signedOut: false }),
    signedOut: () => ({ signedOut: true }),
  },
});

export const { signedIn, signedOut } = sessionSlice.actions;
