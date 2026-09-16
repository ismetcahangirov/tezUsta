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

/**
 * Whether there is a session, as far as the **client** can tell.
 *
 * `restoring` is the launch state and is not a spinner: the app has a refresh
 * token in `expo-secure-store` or it does not, and until that has been traded
 * for an access token nobody knows which route the user belongs on. Starting
 * in `signed-out` instead would flash the sign-in screen at every returning
 * user on every cold start.
 */
export type AuthStatus = 'restoring' | 'signed-out' | 'signed-in';

/** What a verified access token says about its holder. */
export interface SessionIdentity {
  readonly userId: string | null;
  readonly roles: readonly AppRole[];
}

export interface SessionState {
  status: AuthStatus;
  /** From the access token's `sub`. Null when it could not be read. */
  userId: string | null;
  /**
   * The roles the access token claims. **A hint, never an authority** — the
   * server re-reads `user_roles` on every request
   * (docs/architecture/authentication.md § Role claims are a cache, not an
   * authority), so this decides what the app *shows*, nothing more.
   *
   * Empty means "not known", which is treated as "do not restrict", not as
   * "holds nothing". A guard that read an unreadable token as zero grants
   * would bounce a legitimately signed-in user out of every role group and
   * leave them nowhere to land.
   */
  grantedRoles: AppRole[];
  /** Which role's experience is on screen. */
  role: AppRole;
  /**
   * The number an OTP was just sent to, held here rather than passed as a
   * route parameter: a route parameter puts a full phone number into a
   * deep-linkable URL and, on the web output, into browser history. Phone
   * numbers are data this project keeps out of logs (CLAUDE.md §11).
   */
  otpRequestedFor: string | null;
}

const initialState: SessionState = {
  status: 'restoring',
  userId: null,
  grantedRoles: [],
  role: 'customer',
  otpRequestedFor: null,
};

const sessionSlice = createSlice({
  name: 'session',
  initialState,
  reducers: {
    roleSelected(state, action: PayloadAction<AppRole>) {
      state.role = action.payload;
    },

    otpRequested(state, action: PayloadAction<string>) {
      state.otpRequestedFor = action.payload;
    },

    /**
     * A token pair has been obtained — from OTP verification, or from a
     * refresh at launch.
     *
     * The active role is snapped onto a granted one here, so that a user who
     * last used the app as a master and has since lost the grant does not open
     * into a role group they will immediately be redirected out of.
     */
    signedIn(state, action: PayloadAction<SessionIdentity>) {
      const { userId, roles } = action.payload;

      state.status = 'signed-in';
      state.userId = userId;
      state.grantedRoles = [...roles];
      state.otpRequestedFor = null;

      const preferredIsGranted = roles.length === 0 || roles.includes(state.role);
      if (!preferredIsGranted) {
        // `roles` is non-empty here, so index 0 exists; the fallback satisfies
        // `noUncheckedIndexedAccess` without pretending otherwise.
        state.role = roles[0] ?? state.role;
      }
    },

    /**
     * Sign-out, a refused refresh, and a launch with no stored token all end
     * here. Everything derived from the previous user is dropped — an app that
     * keeps the last user's id or role grants around is one bug away from
     * showing them to the next person who signs in on the same device.
     */
    signedOut(state) {
      state.status = 'signed-out';
      state.userId = null;
      state.grantedRoles = [];
      state.role = initialState.role;
      state.otpRequestedFor = null;
    },
  },
  selectors: {
    selectRole: (state) => state.role,
    selectAuthStatus: (state) => state.status,
    selectUserId: (state) => state.userId,
    selectGrantedRoles: (state): readonly AppRole[] => state.grantedRoles,
    selectOtpRequestedFor: (state) => state.otpRequestedFor,
    /** True only for a user the token says holds both roles. */
    selectCanSwitchRole: (state) =>
      state.grantedRoles.includes('customer') && state.grantedRoles.includes('master'),
  },
});

export const { roleSelected, otpRequested, signedIn, signedOut } = sessionSlice.actions;
export const {
  selectRole,
  selectAuthStatus,
  selectUserId,
  selectGrantedRoles,
  selectOtpRequestedFor,
  selectCanSwitchRole,
} = sessionSlice.getSelectors((root: { session: SessionState }) => root.session);

export const sessionReducer = sessionSlice.reducer;
