import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Call } from '@tezusta/types';

/**
 * The call ringing this phone, and which call screen is showing
 * ([ADR-0040](../../../../docs/decisions/ADR-0040-call-screens.md) § 1).
 *
 * **The `Call` contract and nothing else** — never a credential. The room's
 * bearer token lives in the call hook's React state for the life of the call
 * (`useCall.ts`, ADR-0034 § 3); a store is readable by DevTools and by
 * anything that serialises state, which is exactly where a token must not be.
 *
 * **Client state, so a slice.** A ring is a frame the server sent once, not a
 * resource the app can re-read on a cache miss: the root writes it when
 * `call:incoming` arrives, the incoming route reads it to know which call to
 * show, and it is cleared when that call is over — by the screen, or by the
 * root if the call ends before any screen has shown it.
 *
 * `surface` is how the root decides what to do with a second ring. It is
 * keyed by a token each call screen owns, so a screen that unmounts can only
 * withdraw its own claim, never a newer screen's:
 *
 * - a screen holding a **live** call — past asking for the microphone and not
 *   ended — means the ring is left alone; the server has already answered
 *   that caller `busy`;
 * - a screen showing an **ended** call is replaced by the new ring rather
 *   than stacked under it.
 */
export interface CallSurface {
  readonly token: string;
  readonly live: boolean;
}

export interface RingingCallState {
  call: Call | null;
  surface: CallSurface | null;
}

const initialState: RingingCallState = { call: null, surface: null };

const ringingCallSlice = createSlice({
  name: 'ringingCall',
  initialState,
  reducers: {
    ringingCallReceived(state, action: PayloadAction<Call>) {
      state.call = action.payload;
    },
    /** Clears the ring, but only if it is still the one named — a later ring is not undone by an earlier call's end. */
    ringingCallCleared(state, action: PayloadAction<string>) {
      if (state.call?.id === action.payload) {
        state.call = null;
      }
    },
    /** A call screen is on screen, holding a live call or an ended one. The newest screen wins. */
    callSurfaceShown(state, action: PayloadAction<CallSurface>) {
      state.surface = action.payload;
    },
    /** A call screen closed. Ignored unless it is still the one on record. */
    callSurfaceClosed(state, action: PayloadAction<string>) {
      if (state.surface?.token === action.payload) {
        state.surface = null;
      }
    },
  },
});

export const { ringingCallReceived, ringingCallCleared, callSurfaceShown, callSurfaceClosed } =
  ringingCallSlice.actions;
export const ringingCallReducer = ringingCallSlice.reducer;

interface WithRingingCall {
  readonly ringingCall: RingingCallState;
}

export const selectRingingCall = (state: WithRingingCall): Call | null => state.ringingCall.call;
/** Whether a call screen holds a call that is live — a new ring is then left alone. */
export const selectCallSurfaceLive = (state: WithRingingCall): boolean =>
  state.ringingCall.surface?.live === true;
/** Whether any call screen is showing, live or ended — a new ring then replaces it. */
export const selectCallSurfaceOpen = (state: WithRingingCall): boolean =>
  state.ringingCall.surface !== null;
