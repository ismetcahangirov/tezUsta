import type { OrderStatus, PartyRating } from '@tezusta/types';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Card, StatusPill, Text } from '../components';
import { PartyRatingLine } from '../reviews/PartyRatingLine';
import { REVIEWS_COPY } from '../reviews/reviews-copy';
import { formatOrderPrice } from './format-order-price';
import { presentOrderStatus } from './order-status-presentation';
import { ORDERS_COPY as copy } from './orders-copy';

export interface OrderStatusCardProps {
  readonly status: OrderStatus;
  /**
   * Integer minor units, or `null` while the order has no price — which is
   * every order that has not been accepted
   * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)).
   */
  readonly priceMinor: number | null;
  /**
   * A control beside the status pill — the call entry point (ADR-0040 § 6).
   * A slot rather than a prop about calling, so the card stays presentational
   * and knows nothing about who may call whom.
   */
  readonly action?: ReactNode;
  /**
   * The assigned master's rating (ADR-0042 § 6, issue #228) — `null` or absent
   * while no master is assigned, and then nothing is shown. The API sends it
   * exactly while the order names a master, so this card never decides who is
   * assigned; it shows what it was given.
   */
  readonly masterRating?: PartyRating | null | undefined;
}

/**
 * Where the order is, what happens next, and what it costs
 * ([ADR-0029](docs/decisions/ADR-0029-customer-order-screen.md)).
 *
 * **Presentational: it owns no server state and makes no request.** Everything
 * it renders arrives as a prop, which is what lets every one of the fourteen
 * statuses be rendered in a test and reviewed in Storybook without a store.
 *
 * **A pill and a sentence, not a stepper.** The lifecycle is not a line —
 * re-dispatch loops back to `SEARCHING`, a dispute branches, and
 * `NO_MASTER_FOUND` ends the journey early — so a position on a track would be
 * a claim the state machine does not support. The sentence under the pill is
 * the half a person waiting at home is actually reading.
 *
 * **A null price is not an empty price.** It is said out loud, because "the
 * master who takes the job sets it" is information and a blank line is not.
 */
export function OrderStatusCard({
  status,
  priceMinor,
  action,
  masterRating,
}: OrderStatusCardProps): React.JSX.Element {
  const presentation = presentOrderStatus(status);

  return (
    <Card className="gap-3">
      <View className="flex-row items-center justify-between gap-3">
        <StatusPill status={presentation.tone} label={presentation.label} />
        {action}
      </View>

      <Text variant="body">{presentation.next}</Text>

      <View className="gap-1">
        <Text variant="caption" tone="muted">
          {copy.detail.price}
        </Text>
        {priceMinor === null ? (
          <Text variant="body" tone="muted">
            {copy.detail.priceNotSet}
          </Text>
        ) : (
          <Text variant="body-strong">{formatOrderPrice(priceMinor)}</Text>
        )}
      </View>

      {masterRating !== null && masterRating !== undefined && (
        <PartyRatingLine label={REVIEWS_COPY.rating.master} rating={masterRating} />
      )}
    </Card>
  );
}
