import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { Call } from '@tezusta/types';

/**
 * The call ringing this phone, and whether a call surface is showing a live
 * call ([ADR-0040](../../../../docs/decisions/ADR-0040-call-screens.md) § 1).
 *
 * **The `Call` contract and nothing else** — never a credential. The room's
 * bearer token lives in the call hook's React state for the life of the call
 * (`useCall.ts`, ADR-0034 § 3); a store is readable by DevTools and by
 * anything that serialises state, which is exactly where a token must not be.
 *
 * **Client state, so a slice.** A ring is a frame the server sent once, not a
 * resource the app can re-read on a cache miss: the root writes it when
 * `call:incoming` arrives, the incoming route reads it to know which call to
 * show, and the route clears it when that call is over.
 *
 * `live` is how the root knows to leave a second ring alone: while any call
 * surface — outgoing or incoming — holds a call that has not ended, a new
 * `call:incoming` is ignored. The server has already answered that caller
 * `busy`; showing the ring would put a second call screen over the first.
 */
export interface RingingCallState {
  call: Call | null;
  live: boolean;
}

const initialState: RingingCallState = { call: null, live: false };

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
    callSurfaceLive(state, action: PayloadAction<boolean>) {
      state.live = action.payload;
    },
  },
});

export const { ringingCallReceived, ringingCallCleared, callSurfaceLive } =
  ringingCallSlice.actions;
export const ringingCallReducer = ringingCallSlice.reducer;

interface WithRingingCall {
  readonly ringingCall: RingingCallState;
}

export const selectRingingCall = (state: WithRingingCall): Call | null => state.ringingCall.call;
export const selectCallSurfaceLive = (state: WithRingingCall): boolean => state.ringingCall.live;
