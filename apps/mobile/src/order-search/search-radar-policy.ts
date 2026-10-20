import type { OrderSearchProgress, OrderStatus } from '@tezusta/types';

import type { ConnectionStatus } from '../realtime/connection-slice';

/**
 * What the search radar shows (issue #398, ADR-0055 § 1–6).
 *
 * - `hidden`: the order is not searching, or the server says it has stopped
 *   (`409 ORDER_NOT_SEARCHING`) — the order's own refetch swaps the card for
 *   whatever comes next, so this is not an error to show.
 * - `loading`: searching, nothing read yet. The address and the pulse; no ring
 *   and no count.
 * - `live`: the last read, current.
 * - `reconnecting`: the socket is retrying. The last read stays drawn, the
 *   pulse stops, and the sentence says the search goes on.
 * - `error`: the read failed. A sentence that the search continues, blaming
 *   nobody.
 */
export type RadarView =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'live'; readonly progress: OrderSearchProgress }
  | { readonly kind: 'reconnecting'; readonly progress: OrderSearchProgress | null }
  | { readonly kind: 'error' };

/** Why the last read failed, as far as the radar cares. */
export type RadarReadFailure = 'not-searching' | 'other' | null;

export interface RadarInputs {
  readonly status: OrderStatus;
  readonly progress: OrderSearchProgress | null;
  readonly failure: RadarReadFailure;
  readonly connection: ConnectionStatus;
}

/** Pure, so every state is testable without a store or a socket. */
export function deriveRadarView({ status, progress, failure, connection }: RadarInputs): RadarView {
  if (status !== 'SEARCHING' || failure === 'not-searching') {
    return { kind: 'hidden' };
  }
  if (connection === 'reconnecting') {
    return { kind: 'reconnecting', progress };
  }
  if (progress !== null) {
    return { kind: 'live', progress };
  }
  if (failure === 'other') {
    return { kind: 'error' };
  }
  return { kind: 'loading' };
}

/** A failed read, sorted: 409 means the order moved on; anything else is a failure. */
export function radarFailureOf(error: unknown): RadarReadFailure {
  if (error === undefined || error === null) {
    return null;
  }
  const status =
    typeof error === 'object' && 'status' in error ? (error as { status?: unknown }).status : null;
  return status === 409 ? 'not-searching' : 'other';
}

/** Whether the pulse should run in this state, before reduce motion is considered. */
export function radarIsSearchingVisibly(view: RadarView): boolean {
  return view.kind === 'loading' || view.kind === 'live';
}
