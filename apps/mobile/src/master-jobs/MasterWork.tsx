import { View } from 'react-native';

import { ListRow, StatusPill, Text } from '../components';
import { useGetAvailabilityQuery } from '../master-availability/master-availability-endpoints';
import { useCurrentJobQuery } from './master-jobs-endpoints';
import { MASTER_JOBS_COPY } from './master-jobs-copy';
import { OfferFeed } from './OfferFeed';

export interface MasterWorkProps {
  /** Opens the job screen — after an accept, or from the current-job row. */
  readonly onOpenJob: () => void;
}

/**
 * The work half of the master's home, under the availability card
 * (issue #199, ADR-0036).
 *
 * **One of three things, never two at once**: the job the master is on, or —
 * with no job and online — the offers dispatch is sending them, or nothing.
 * A master on a job cannot accept another (`orders_one_active_per_master`),
 * so showing the feed beside the job would be showing buttons that can only
 * fail. An offline master is offered nothing, and the availability card above
 * already says so.
 */
export function MasterWork({ onOpenJob }: MasterWorkProps): React.JSX.Element | null {
  const availability = useGetAvailabilityQuery();
  const job = useCurrentJobQuery();

  const current = job.currentData?.job;

  if (current !== undefined && current !== null) {
    const copy = MASTER_JOBS_COPY;
    const statusLabel = copy.job.status[current.status as keyof typeof copy.job.status];

    return (
      <View className="gap-3">
        <Text variant="h2">{copy.current.title}</Text>
        <ListRow
          title={current.address.formattedAddress}
          subtitle={current.description}
          trailing={
            statusLabel === undefined ? undefined : (
              <StatusPill status="active" label={statusLabel} />
            )
          }
          onPress={onOpenJob}
        />
      </View>
    );
  }

  if (availability.currentData?.isAvailable !== true || current === undefined) {
    return null;
  }

  return <OfferFeed onAccepted={onOpenJob} />;
}
