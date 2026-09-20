import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Button, EmptyState, Skeleton } from '../components';
import { customerProfileState } from './customer-profile-state';
import { CUSTOMERS_COPY as copy } from './customers-copy';
import { useGetOwnCustomerQuery } from './customers-endpoints';
import { ProfileSetup } from './ProfileSetup';

/**
 * Stands between a signed-in account and the customer area, and asks the one
 * question the API cannot proceed without (issue #94).
 *
 * ## It renders instead of redirecting
 *
 * The first-run question is not a destination. It is the condition of entering
 * the customer area at all, so this swaps what the group renders rather than
 * pushing a route: there is nothing to navigate back to, nothing to deep-link
 * into, and no redirect that can fight the auth guard for the same frame.
 * `route-guard.ts` is untouched by this — it decides which *group* a user
 * belongs in, and this decides what that group is able to show once they are
 * in it.
 *
 * ## Four states, and `missing` is the only one that asks anything
 *
 * The distinction the whole thing rests on is that a 404 from
 * `GET /customers/me` is an **answer** — "you have no profile" — while a 500
 * or a dead network is not. `customer-profile-state.ts` keeps them apart, and
 * has the tests. Conflating them would ask a long-standing customer to
 * introduce themselves every time their train went into a tunnel.
 *
 * ## It is mounted per role, not at the root
 *
 * A master is not a customer and must never meet this screen. Mounting it in
 * `app/(customer)/_layout.tsx` rather than in the root layout is what makes
 * that structural instead of a condition somebody has to remember — the master
 * group and `(shared)` never render it, so no `POST /customers` can be
 * provoked for an account that did not ask to be one.
 */
export function CustomerProfileGate({ children }: { children: ReactNode }): React.JSX.Element {
  const profile = useGetOwnCustomerQuery();

  const state = customerProfileState({
    // `currentData`, not `data`: `data` keeps the previous argument's result
    // while a new one is in flight, which for a `void`-argument query is the
    // same thing — but reading the fresh field is the habit the rest of the
    // app follows (`Addresses.tsx`, `ServiceCatalogue.tsx`) and the one that
    // stays correct if this query ever takes an argument.
    hasProfile: profile.currentData !== undefined,
    isLoading: profile.isLoading,
    error: profile.error,
  });

  if (state === 'ready') {
    return <>{children}</>;
  }

  if (state === 'missing') {
    return <ProfileSetup />;
  }

  if (state === 'unavailable') {
    return (
      <View className="flex-1 justify-center p-6">
        <EmptyState
          title={copy.errorTitle}
          description={copy.errorDescription}
          action={
            <Button
              label={copy.retry}
              variant="secondary"
              onPress={() => {
                void profile.refetch();
              }}
            />
          }
        />
      </View>
    );
  }

  return (
    <View className="flex-1 justify-center p-6">
      {/* The label goes on the `Skeleton`, which is what turns it into one
          announced loading region rather than a silent box — see its own
          doc comment on why that is conditional. */}
      <Skeleton className="h-control-lg w-full rounded-full" accessibilityLabel={copy.loading} />
    </View>
  );
}
