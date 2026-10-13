import type { MasterSubscription } from '@tezusta/types';

import { api } from '../api/api-slice';

const MINE = { type: 'MasterSubscription', id: 'ME' } as const;

/**
 * `GET /masters/me/subscription` (#322, #325). Tagged, so a refusal that
 * says the subscription has lapsed, a push about it, or the screen coming back
 * into focus can ask for the server's answer again rather than trusting the
 * last one.
 *
 * The offer (`GET /subscription`) is deliberately not read here: it carries
 * the prices, and the app shows none (ADR-0046 § 7).
 */
export const masterSubscriptionApi = api.injectEndpoints({
  endpoints: (build) => ({
    getMySubscription: build.query<MasterSubscription, void>({
      query: () => '/masters/me/subscription',
      providesTags: [MINE],
    }),
  }),
});

export const { useGetMySubscriptionQuery } = masterSubscriptionApi;

/** Asks for the master's subscription again, wherever it is shown. */
export const refreshMySubscription = (): ReturnType<typeof api.util.invalidateTags> =>
  api.util.invalidateTags([MINE]);

export interface MySubscription {
  /** `undefined` while loading, `null` for a master with no subscription yet. */
  readonly subscription: MasterSubscription | null | undefined;
  readonly failed: boolean;
  readonly retry: () => void;
  /** When the server last answered, so a caller can tell a read made after an event of its own. */
  readonly readAt: number | undefined;
}

const STATUSES: readonly string[] = ['trialing', 'active', 'past_due', 'cancelled', 'expired'];
const PERIODS: readonly (string | null)[] = ['monthly', 'yearly', null];

/**
 * Whether a response is shaped like a subscription. Checked rather than
 * trusted: the card sits on the master's home, and a body this release cannot
 * read — an older or newer server, a proxy's error page — must hide one card,
 * not take the home down with it.
 */
function isMasterSubscription(data: unknown): data is MasterSubscription {
  if (typeof data !== 'object' || data === null) return false;
  const value = data as Record<string, unknown>;
  return (
    typeof value.status === 'string' &&
    STATUSES.includes(value.status) &&
    typeof value.currentPeriodEnd === 'string' &&
    typeof value.entitled === 'boolean' &&
    PERIODS.includes(value.billingPeriod as string | null) &&
    PERIODS.includes(value.nextBillingPeriod as string | null) &&
    (value.graceEndsAt === null || typeof value.graceEndsAt === 'string')
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404;
}

/**
 * The subscription, with "none yet" told apart from "could not load": the
 * server answers 404 for a master verification has not approved, and that is
 * a state to show, not an error.
 */
export function useMySubscription(): MySubscription {
  const query = useGetMySubscriptionQuery();
  const retry = (): void => void query.refetch();
  const readAt = query.fulfilledTimeStamp;
  if (query.currentData !== undefined) {
    return isMasterSubscription(query.currentData)
      ? { subscription: query.currentData, failed: false, retry, readAt }
      : { subscription: undefined, failed: true, retry, readAt };
  }
  if (isNotFound(query.error)) {
    return { subscription: null, failed: false, retry, readAt };
  }
  return { subscription: undefined, failed: query.error !== undefined, retry, readAt };
}
