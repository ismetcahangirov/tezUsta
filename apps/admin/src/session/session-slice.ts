import { createSlice } from '@reduxjs/toolkit';

/**
 * Whether this tab believes it still has a session.
 *
 * Deliberately holds no token and no identity: the session lives in two
 * httpOnly cookies the page cannot read (ADR-0043 § 4), and who the admin is
 * comes from `GET /admin/me` through RTK Query. The only fact kept here is the
 * one no request can answer by itself — that a refresh was refused, so every
 * authenticated screen must give way to the sign-in page.
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
