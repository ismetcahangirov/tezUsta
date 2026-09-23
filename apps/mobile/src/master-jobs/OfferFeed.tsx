import type { MasterOffer } from '@tezusta/types';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Banner, Button, Card, EmptyState, Skeleton, Text } from '../components';
import { deviceLocale } from '../lib/device-locale';
import { formatOrderPrice } from '../orders/format-order-price';
import { useGetServiceQuery } from '../service-catalogue/service-catalogue-endpoints';
import { errorCodeOf } from './error-code';
import {
  useAcceptOfferMutation,
  useDeclineOfferMutation,
  useOffersQuery,
} from './master-jobs-endpoints';
import { MASTER_JOBS_COPY } from './master-jobs-copy';

const copy = MASTER_JOBS_COPY.feed;

/**
 * How often the "time left" line is recomputed. A clock, not a request: the
 * feed itself is refreshed only by the socket and by mounting.
 */
const CLOCK_TICK_MS = 15_000;

/** Now, re-read every {@link CLOCK_TICK_MS}, so an expired card leaves on its own. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, CLOCK_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, []);

  return now;
}

/** Accept's refusals, each as a sentence the master can act on (#101). */
function acceptFailureMessage(error: unknown): string {
  switch (errorCodeOf(error)) {
    case 'ORDER_ALREADY_TAKEN':
      return copy.taken;
    case 'OFFER_NO_LONGER_ACTIONABLE':
      return copy.expired;
    case 'MASTER_HAS_ACTIVE_ORDER':
      return copy.alreadyWorking;
    case 'MASTER_NOT_ELIGIBLE_FOR_OFFER':
    case 'MASTER_NOT_ELIGIBLE':
      return copy.notEligible;
    default:
      return copy.failed;
  }
}

export interface OfferFeedProps {
  /** Called with the order id once an accept has been won. */
  readonly onAccepted: (orderId: string) => void;
}

/**
 * The master's live offers, with accept and decline (issue #199).
 *
 * **What a card shows is what the server put on it, and nothing else.** The
 * card carries no address and no distance in metres — only a band — because a
 * broadcast reaches every eligible master and most of them never take the job
 * (#101). The exact address arrives with the accept.
 *
 * An offer whose window has run out leaves the list on the client's clock as
 * well as the server's: tapping it could only fail.
 */
export function OfferFeed({ onAccepted }: OfferFeedProps): React.JSX.Element {
  const offers = useOffersQuery();
  const [accept, acceptResult] = useAcceptOfferMutation();
  const [decline, declineResult] = useDeclineOfferMutation();
  const [failure, setFailure] = useState<string | null>(null);
  const now = useNow();

  const live = offers.currentData?.filter((offer) => Date.parse(offer.expiresAt) > now);
  const busy = acceptResult.isLoading || declineResult.isLoading;

  return (
    <View className="gap-3">
      <Text variant="h2">{copy.title}</Text>

      {failure !== null && <Banner tone="danger" message={failure} />}

      {live === undefined ? (
        offers.error === undefined ? (
          <View className="gap-3">
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-full" />
          </View>
        ) : (
          <EmptyState
            title={copy.loadFailed}
            action={
              <Button
                label={copy.retry}
                variant="secondary"
                loading={offers.isFetching}
                onPress={() => {
                  void offers.refetch();
                }}
              />
            }
          />
        )
      ) : live.length === 0 ? (
        <EmptyState title={copy.emptyTitle} description={copy.emptyDescription} />
      ) : (
        live.map((offer) => (
          <OfferCard
            key={offer.id}
            offer={offer}
            now={now}
            disabled={busy}
            onAccept={() => {
              setFailure(null);
              void accept(offer.id)
                .unwrap()
                .then((accepted) => {
                  onAccepted(accepted.orderId);
                })
                .catch((error: unknown) => {
                  setFailure(acceptFailureMessage(error));
                });
            }}
            onDecline={() => {
              setFailure(null);
              void decline(offer.id)
                .unwrap()
                .catch(() => {
                  // Declining something that already expired or was taken is
                  // a 409 with nothing for the master to do: the invalidation
                  // has already removed the card, which is the outcome they
                  // asked for.
                });
            }}
          />
        ))
      )}
    </View>
  );
}

interface OfferCardProps {
  readonly offer: MasterOffer;
  readonly now: number;
  readonly disabled: boolean;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}

function OfferCard({
  offer,
  now,
  disabled,
  onAccept,
  onDecline,
}: OfferCardProps): React.JSX.Element {
  const service = useGetServiceQuery({ id: offer.serviceId, locale: deviceLocale() });
  const minutesLeft = Math.floor((Date.parse(offer.expiresAt) - now) / 60_000);

  return (
    <Card className="gap-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1 gap-1">
          <Text variant="body-strong">{service.currentData?.name ?? ''}</Text>
          <Text variant="caption" tone="muted">
            {copy.distance[offer.distanceBand]}
          </Text>
        </View>
        <Text variant="body-strong">
          {offer.priceMinor === null ? copy.priceOnSite : formatOrderPrice(offer.priceMinor)}
        </Text>
      </View>

      <Text variant="body" numberOfLines={3}>
        {offer.description}
      </Text>

      <Text variant="caption" tone="muted">
        {minutesLeft < 1 ? copy.expiringNow : copy.expiresIn(minutesLeft)}
      </Text>

      <View className="flex-row gap-3">
        <Button
          label={copy.decline}
          variant="secondary"
          disabled={disabled}
          onPress={onDecline}
          className="flex-1"
        />
        <Button
          label={copy.accept}
          variant="accent"
          disabled={disabled}
          onPress={onAccept}
          className="flex-1"
        />
      </View>
    </Card>
  );
}
