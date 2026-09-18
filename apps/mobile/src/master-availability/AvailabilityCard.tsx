import type { MasterVerificationStatus } from '@tezusta/types';
import { View } from 'react-native';

import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { AvailabilityToggle } from './AvailabilityToggle';
import {
  useGetAvailabilityQuery,
  useSetAvailabilityMutation,
} from './master-availability-endpoints';
import { MASTER_AVAILABILITY_COPY as copy } from './master-availability-copy';
import { useAvailabilityHeartbeat } from './useAvailabilityHeartbeat';

/**
 * Turns the server's refusal to let a master go online into a sentence they
 * can act on.
 *
 * Driven by `details.verificationStatus`, which `MasterNotEligibleError`
 * carries for exactly this reason: `changes_requested` and `rejected` are
 * deliberately different states with different screens
 * (`docs/product/master-flow.md`), so one generic "you cannot go online" would
 * throw away the only thing that tells a master whether there is anything they
 * can do.
 */
function reasonFor(status: string | undefined): string | undefined {
  const messages: Partial<Record<MasterVerificationStatus, string>> = {
    pending_verification: copy.pendingVerification,
    changes_requested: copy.changesRequested,
    rejected: copy.rejected,
    suspended: copy.suspended,
  };
  return status === undefined ? undefined : messages[status as MasterVerificationStatus];
}

/** Reads `error.details.verificationStatus` out of an RTK Query error, safely. */
function verificationStatusFrom(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return undefined;
  }
  const body = (error as { data?: unknown }).data;
  if (typeof body !== 'object' || body === null || !('error' in body)) {
    return undefined;
  }
  const envelope = (body as { error?: { details?: { verificationStatus?: unknown } } }).error;
  const status = envelope?.details?.verificationStatus;
  return typeof status === 'string' ? status : undefined;
}

/**
 * The availability section of the master's home screen.
 *
 * The container half of the pair: it owns the query, the mutation and the
 * heartbeat, and hands `AvailabilityToggle` a finished state to render. Same
 * split as `ServiceCatalogue` and its lists — a presentational component that
 * took loading and error as props would be a request renderer wearing a
 * toggle's name.
 *
 * `currentData` rather than `data`, and `isFetching` rather than `isLoading`,
 * for the reasons `ServiceCatalogue` gives: never show a previous argument's
 * result under a new heading, and a retry should still show a spinner.
 */
export function AvailabilityCard(): React.JSX.Element {
  const availability = useGetAvailabilityQuery();
  const [setAvailability, setResult] = useSetAvailabilityMutation();

  const state = availability.currentData;

  // The heartbeat only runs while the server says the intent is online. Not
  // while a toggle is mid-flight and not on optimism: presence is the server's
  // fact, and a client that beat on its own belief could keep a master looking
  // reachable after the server had already refused to let them work.
  useAvailabilityHeartbeat(state?.isAvailable === true, state?.heartbeatSeconds ?? 60);

  if (state === undefined) {
    if (availability.error === undefined) {
      return (
        <View className="gap-3">
          <Skeleton className="h-control-md w-full" />
          <Skeleton className="h-control-lg w-full" />
        </View>
      );
    }

    return (
      <EmptyState
        title={copy.loadFailed}
        action={
          <Button
            label={copy.retry}
            variant="secondary"
            onPress={() => {
              void availability.refetch();
            }}
          />
        }
      />
    );
  }

  return (
    <AvailabilityToggle
      availability={state}
      disabled={setResult.isLoading}
      blockedReason={reasonFor(verificationStatusFrom(setResult.error))}
      onChange={(next) => {
        void setAvailability(next);
      }}
    />
  );
}
