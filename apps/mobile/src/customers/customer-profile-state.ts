/**
 * What the customer area should be showing, given the state of the profile
 * check (issue #94).
 *
 * A pure function for `route-guard.ts`'s reason: the cases that matter are a
 * small matrix — a 404 is not a failure here, and a failure is not a 404 — and
 * asserting them should not require mounting a navigator or a store.
 *
 * - `resolving` — the check is in flight and nothing is known yet. Rendering
 *   the customer screens now would fire a burst of requests that 404, and
 *   rendering the name question now would ask a returning customer for a name
 *   they gave months ago.
 * - `ready` — there is a profile; the customer area works.
 * - `missing` — the server said 404, which is exactly "you have no profile".
 *   The first-run question is the answer.
 * - `unavailable` — the check failed for any other reason. **Deliberately not
 *   `missing`.** A 500, a timeout or a flight-mode request tells us nothing
 *   about whether a profile exists, and treating them alike would ask a
 *   long-standing customer to introduce themselves every time their train went
 *   into a tunnel — and then post a create they did not need.
 */
export type CustomerProfileState = 'resolving' | 'ready' | 'missing' | 'unavailable';

export interface CustomerProfileCheck {
  /** Whether the query currently holds a profile for this account. */
  readonly hasProfile: boolean;
  /** RTK Query's `isLoading`: a first load, with nothing cached behind it. */
  readonly isLoading: boolean;
  /** RTK Query's `error`, whatever shape it arrived in. */
  readonly error: unknown;
}

/**
 * The HTTP status, when the failure reached the server and got one back.
 *
 * A local copy of `addresses-errors.ts`'s `statusOf` rather than an import
 * across the feature boundary: each feature owns its own request-state helpers
 * (the rule `Addresses.tsx`'s `isOffline` states), and this is four lines.
 */
function statusOf(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('status' in error)) {
    return undefined;
  }
  return (error as { status?: unknown }).status;
}

export function customerProfileState({
  hasProfile,
  isLoading,
  error,
}: CustomerProfileCheck): CustomerProfileState {
  if (hasProfile) {
    // Ahead of `isLoading` and ahead of `error`: a cached profile plus a
    // failed *re*fetch is still a customer who has a profile, and bouncing
    // them to the name question because the network dropped would be the worst
    // of the four answers.
    return 'ready';
  }

  if (isLoading) {
    return 'resolving';
  }

  if (error === undefined) {
    // No profile, no error, not loading: the query has not been started yet.
    // The gate subscribes on mount, so this is one render, not a state.
    return 'resolving';
  }

  if (statusOf(error) === 404) {
    return 'missing';
  }

  // Everything else — a 5xx, a 401 the refresh could not rescue, and every
  // transport failure, which RTK Query reports as the string `FETCH_ERROR` or
  // `TIMEOUT_ERROR` in the same `status` field rather than as a number. They
  // are one answer here on purpose: none of them is evidence about whether a
  // profile exists, and the screen's response to all of them is "try again".
  return 'unavailable';
}
