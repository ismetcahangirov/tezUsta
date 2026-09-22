import type { OrderStatus } from '@tezusta/types';
import { View } from 'react-native';

import { Card, StatusPill, Text } from '../components';
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
export function OrderStatusCard({ status, priceMinor }: OrderStatusCardProps): React.JSX.Element {
  const presentation = presentOrderStatus(status);

  return (
    <Card className="gap-3">
      <StatusPill status={presentation.tone} label={presentation.label} />

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
    </Card>
  );
}
