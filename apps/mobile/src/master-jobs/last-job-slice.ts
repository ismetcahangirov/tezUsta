import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { signedOut } from '../store/session-slice';

export interface LastJobState {
  /** The order of the most recent job the job read returned in this session, or null. */
  orderId: string | null;
}

const initialState: LastJobState = { orderId: null };

/**
 * Which job this master was on most recently (issue #227).
 *
 * **Why the app has to remember it at all.** `GET /masters/me/jobs/current`
 * answers `null` the instant a job completes — it is the *current* job, and a
 * completed one is not — yet completion is exactly when a review becomes
 * possible (ADR-0042 § 1). Without this, the job screen could only say "this
 * order is no longer yours" to a master who has just finished it, and the
 * prompt the ADR places on that screen would have nothing to be about.
 *
 * **Client state, so a slice** (ADR-0017): the server has no "last job" read,
 * and this is not a copy of server data — it is a fact about what this phone
 * saw. Whether that order may be reviewed is still asked of the server
 * (`GET /orders/:id/reviews`) every time; a cancelled or handed-back job is
 * remembered here too and simply prompts nothing.
 *
 * **Memory only, and forgotten at sign-out.** After a restart the one
 * reminder push (ADR-0042 § 1) is the way back to an unwritten review, and it
 * carries its own order id.
 */
const lastJobSlice = createSlice({
  name: 'lastJob',
  initialState,
  reducers: {
    jobSeen(state, action: PayloadAction<string>) {
      state.orderId = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(signedOut, () => initialState);
  },
  selectors: {
    selectLastJobOrderId: (state): string | null => state.orderId,
  },
});

export const { jobSeen } = lastJobSlice.actions;
export const { selectLastJobOrderId } = lastJobSlice.selectors;
export const lastJobReducer = lastJobSlice.reducer;
