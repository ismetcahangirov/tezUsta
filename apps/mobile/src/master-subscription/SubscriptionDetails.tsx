import type { MasterSubscription } from '@tezusta/types';
import { ScrollView, View } from 'react-native';

import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Divider } from '../components/Divider';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { StatusPill } from '../components/StatusPill';
import { Text } from '../components/Text';
import { describeSubscription } from './describe-subscription';
import { formatSubscriptionDate } from './format-subscription-date';
import { MASTER_SUBSCRIPTION_COPY as copy } from './master-subscription-copy';
import { useMySubscription } from './master-subscription-endpoints';

export interface SubscriptionDetailsProps {
  readonly onBack: () => void;
  readonly now?: Date;
}

function Fact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View className="flex-row items-center justify-between gap-4 py-3">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="body-strong" className="flex-shrink text-right">
        {value}
      </Text>
    </View>
  );
}

/**
 * `null` when the row cannot say: a period with no billing period is a trial
 * or granted days, and once it has expired the status no longer tells which —
 * an expired trial, the commonest lapse while purchases are closed, must not
 * read as granted days.
 */
function periodLabel(subscription: MasterSubscription): string | null {
  if (subscription.status === 'trialing') return copy.details.trialPeriod;
  if (subscription.billingPeriod !== null) return copy.period[subscription.billingPeriod];
  return subscription.status === 'expired' ? null : copy.details.grantedPeriod;
}

/**
 * The subscription screen (#325, ADR-0049): where the subscription stands,
 * the period and its end, any period paid in advance, the grace end, and how
 * renewing works — outside the app, with no price, link or button to buy
 * (ADR-0046 § 7).
 */
export function SubscriptionDetails({ onBack, now }: SubscriptionDetailsProps): React.JSX.Element {
  const { subscription, failed, retry } = useMySubscription();

  return (
    <ScrollView className="flex-1">
      <View className="gap-6 p-6">
        <View className="flex-row items-center justify-between">
          <Text variant="h1">{copy.title}</Text>
          <Button label={copy.back} variant="ghost" size="sm" onPress={onBack} />
        </View>

        {subscription === undefined ? (
          failed ? (
            <EmptyState
              title={copy.loadFailed}
              action={<Button label={copy.retry} variant="secondary" onPress={retry} />}
            />
          ) : (
            <Skeleton className="h-control-lg w-full" />
          )
        ) : subscription === null ? (
          <Card className="p-4">
            <Text variant="body">{copy.details.none}</Text>
          </Card>
        ) : (
          <Body subscription={subscription} now={now ?? new Date()} />
        )}

        <Text variant="caption" tone="muted">
          {copy.details.howToRenew}
        </Text>
      </View>
    </ScrollView>
  );
}

function Body({
  subscription,
  now,
}: {
  subscription: MasterSubscription;
  now: Date;
}): React.JSX.Element {
  const summary = describeSubscription(subscription, now);
  const date = formatSubscriptionDate;
  const period = periodLabel(subscription);

  return (
    <View className="gap-4">
      {summary.warning === null ? null : (
        <Banner tone={summary.warning.tone} message={summary.warning.message} />
      )}
      <Card className="px-4">
        <View className="flex-row items-center justify-between py-3">
          <Text variant="caption" tone="muted">
            {copy.details.status}
          </Text>
          <StatusPill status={summary.tone} label={summary.label} />
        </View>
        {period === null ? null : (
          <>
            <Divider />
            <Fact label={copy.details.period} value={period} />
          </>
        )}
        <Divider />
        <Fact label={copy.details.periodEnd} value={date(subscription.currentPeriodEnd)} />
        {subscription.graceEndsAt === null ? null : (
          <>
            <Divider />
            <Fact label={copy.details.graceEnd} value={date(subscription.graceEndsAt)} />
          </>
        )}
        {subscription.nextBillingPeriod === null ? null : (
          <>
            <Divider />
            <Fact
              label={copy.details.nextPeriod}
              value={`${copy.period[subscription.nextBillingPeriod]} · ${date(subscription.currentPeriodEnd)}`}
            />
          </>
        )}
        <Divider />
        <Fact
          label={copy.details.receivesWork}
          value={summary.receivesWork ? copy.details.yes : copy.details.no}
        />
      </Card>
      {subscription.nextBillingPeriod === null ? null : (
        <Text variant="caption" tone="muted">
          {copy.details.queuedExplanation}
        </Text>
      )}
    </View>
  );
}
