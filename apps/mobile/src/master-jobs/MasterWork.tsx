import { View } from 'react-native';

import { ListRow, StatusPill, Text } from '../components';
import { useGetAvailabilityQuery } from '../master-availability/master-availability-endpoints';
import { OrderReviewPrompt } from '../reviews';
import { useAppSelector } from '../store/hooks';
import { selectLastJobOrderId } from './last-job-slice';
import { useCurrentJobQuery } from './master-jobs-endpoints';
import { MASTER_JOBS_COPY } from './master-jobs-copy';
import { OfferFeed } from './OfferFeed';

export interface MasterWorkProps {
  /** Opens the job screen — after an accept, or from the current-job row. */
  readonly onOpenJob: () => void;
  /**
   * Opens the review of the job this master last finished (issue #227).
   * Absent, home shows no review prompt.
   */
  readonly onOpenReview?: ((orderId: string) => void) | undefined;
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
 *
 * **And, with no job, the ask to review the last one** (issue #227,
 * ADR-0042 § 1) — above the feed, because it is about work already done. It
 * is the job screen's prompt again, for the master who went straight home: the
 * card asks the server about the job this session last saw and shows only
 * while that job may still be reviewed and has not been.
 */
export function MasterWork({ onOpenJob, onOpenReview }: MasterWorkProps): React.JSX.Element | null {
  const availability = useGetAvailabilityQuery();
  const job = useCurrentJobQuery();
  const lastOrderId = useAppSelector(selectLastJobOrderId);

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

  if (current === undefined) {
    return null;
  }

  const online = availability.currentData?.isAvailable === true;

  return (
    <View className="gap-6">
      {onOpenReview !== undefined && (
        <OrderReviewPrompt orderId={lastOrderId} viewer="master" onPress={onOpenReview} />
      )}
      {online && <OfferFeed onAccepted={onOpenJob} />}
    </View>
  );
}
