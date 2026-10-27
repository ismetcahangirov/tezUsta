import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

/**
 * Whether an unsent message is on its way or has been refused.
 *
 * There is no `sent`: a message the server accepted leaves the outbox in the
 * same moment it enters the history cache, carrying the server's id and
 * timestamp. Something the server has not acknowledged is the only thing this
 * slice ever holds.
 */
export type OutboxStatus = 'sending' | 'failed';

/** A photo on an unsent message: already confirmed by the server, drawn from the phone's copy. */
export interface OutboxPhoto {
  readonly attachmentId: string;
  /** The prepared JPEG in the app's cache, deleted once the message settles (#408). */
  readonly uri: string;
}

/** A message the user wrote that the server has not (yet) accepted. */
export interface OutboxEntry {
  /** The client's own id, until the server assigns the real one. */
  readonly localId: string;
  /** May be empty when the message carries photos. */
  readonly body: string;
  /** Empty for text alone (#456). */
  readonly photos: readonly OutboxPhoto[];
  /** When the user pressed send, ISO-8601 by this phone's clock. Display only. */
  readonly createdAt: string;
  readonly status: OutboxStatus;
  /**
   * Set on a failure that sending again cannot fix: a photo the server could
   * not process (`MESSAGE_ATTACHMENT_UNUSABLE`). No resend is offered.
   */
  readonly unsendable?: true;
}

export interface OutboxState {
  /** Per order, newest first — the order the conversation list renders in. */
  byOrder: Record<string, OutboxEntry[]>;
}

const initialState: OutboxState = { byOrder: {} };

/** One shared empty list, so a selector for an order with nothing pending is referentially stable. */
const NOTHING: readonly OutboxEntry[] = [];

/**
 * What the user has written and the server has not acknowledged (issue #182).
 *
 * **Client state, so a slice rather than the RTK Query cache** (ADR-0017). The
 * server has never heard of these messages — that is what makes them unsent —
 * and the history cache is refetched after every reconnection, which would
 * silently wipe a failed message the user still means to retry. The rule this
 * slice exists for is the issue's: a failed send is visibly failed and
 * retryable, **never silently dropped**. It survives a refetch because it is
 * not in the thing being refetched.
 *
 * It is also why the optimistic bubble is not an entry patched into the
 * history: a history page that contained a message with a made-up id would be
 * a page of server state that the server never said.
 */
const outboxSlice = createSlice({
  name: 'outbox',
  initialState,
  reducers: {
    messageQueued(state, action: PayloadAction<{ orderId: string; entry: OutboxEntry }>) {
      const { orderId, entry } = action.payload;
      // The photos copied into a fresh array: the payload's is `readonly`, and
      // the draft holds a mutable one.
      state.byOrder[orderId] = [
        { ...entry, photos: [...entry.photos] },
        ...(state.byOrder[orderId] ?? []),
      ];
    },
    messageFailed(
      state,
      action: PayloadAction<{ orderId: string; localId: string; unsendable?: boolean }>,
    ) {
      const entry = update(state, action.payload, 'failed');
      if (entry !== undefined && action.payload.unsendable === true) {
        (entry as { unsendable?: true }).unsendable = true;
      }
    },
    messageRetried(state, action: PayloadAction<{ orderId: string; localId: string }>) {
      update(state, action.payload, 'sending');
    },
    /** The server accepted it; the history cache now holds it under its real id. */
    messageSettled(state, action: PayloadAction<{ orderId: string; localId: string }>) {
      const { orderId, localId } = action.payload;
      const remaining = (state.byOrder[orderId] ?? []).filter((entry) => entry.localId !== localId);
      if (remaining.length === 0) {
        delete state.byOrder[orderId];
      } else {
        state.byOrder[orderId] = remaining;
      }
    },
  },
  selectors: {
    selectOutbox: (state, orderId: string): readonly OutboxEntry[] =>
      state.byOrder[orderId] ?? NOTHING,
  },
});

function update(
  state: OutboxState,
  { orderId, localId }: { orderId: string; localId: string },
  status: OutboxStatus,
): OutboxEntry | undefined {
  const entry = state.byOrder[orderId]?.find((candidate) => candidate.localId === localId);
  if (entry !== undefined) {
    // An Immer draft: the `readonly` on the contract is for readers, and this
    // reducer is the one place allowed to write it.
    (entry as { status: OutboxStatus }).status = status;
  }
  return entry;
}

export const { messageQueued, messageFailed, messageRetried, messageSettled } = outboxSlice.actions;
export const outboxReducer = outboxSlice.reducer;
export const { selectOutbox } = outboxSlice.selectors;
