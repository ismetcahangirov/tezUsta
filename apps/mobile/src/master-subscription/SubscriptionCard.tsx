import { View } from 'react-native';

import { Banner } from '../components/Banner';
import { Card } from '../components/Card';
import { ChevronRightIcon } from '../components/icons';
import { ListRow } from '../components/ListRow';
import { Skeleton } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';
import { describeSubscription } from './describe-subscription';
import { MASTER_SUBSCRIPTION_COPY as copy } from './master-subscription-copy';
import { useMySubscription } from './master-subscription-endpoints';

export interface SubscriptionCardProps {
  /** Opens the subscription screen. */
  readonly onOpen: () => void;
  /** Injectable for tests; the card reads the time once per render. */
  readonly now?: Date;
}

/**
 * The master's subscription on their home, above the availability card
 * (#325, ADR-0048): the status, until when, and a warning three days before
 * the end, in grace and once it has expired. The whole row opens the
 * subscription screen.
 *
 * Built from the design system's own `Card`, `ListRow`, `StatusPill` and
 * `Banner` — nothing new to look at (CLAUDE.md §17).
 */
export function SubscriptionCard({ onOpen, now }: SubscriptionCardProps): React.JSX.Element | null {
  const { subscription, failed } = useMySubscription();

  if (subscription === undefined) {
    // A failed read stays out of the way of the master's work: the
    // availability card below is what they came for, and the screen behind
    // this card has its own retry.
    return failed ? null : (
      <View testID="subscription-card-loading">
        <Skeleton className="h-control-lg w-full" />
      </View>
    );
  }

  const summary = describeSubscription(subscription, now ?? new Date());

  return (
    <Card className="gap-3 px-4">
      <ListRow
        title={copy.title}
        subtitle={summary.next === null ? summary.line : `${summary.line}\n${summary.next}`}
        accessibilityLabel={`${copy.title}: ${summary.label}. ${summary.line}`}
        trailing={
          <View className="flex-row items-center gap-2">
            <StatusPill status={summary.tone} label={summary.label} />
            <ChevronRightIcon tone="text-muted" />
          </View>
        }
        onPress={onOpen}
      />
      {summary.warning === null ? null : (
        <Banner className="mb-4" tone={summary.warning.tone} message={summary.warning.message} />
      )}
    </Card>
  );
}
