import type { Order } from '@tezusta/types';
import { useState } from 'react';
import { View } from 'react-native';

import { Banner, Button, Card, Sheet, Text } from '../components';
import { errorCodeOf } from '../master-jobs/error-code';
import { formatOrderPrice } from './format-order-price';
import { useApproveOrderPriceMutation, useDeclineOrderPriceMutation } from './order-endpoints';
import { ORDERS_COPY } from './orders-copy';

const copy = ORDERS_COPY.detail.quote;

/**
 * Whether the order's price is a quote the customer has not approved yet
 * ([ADR-0060](../../../../docs/decisions/ADR-0060-inspection-price-approval.md)).
 * The status card does not show such a figure as "the price": until the
 * customer approves it, it is the master's proposal, and this card shows it.
 */
export function isOpenQuote(order: Order): boolean {
  return order.pricingKind === 'inspection' && order.priceApprovedAt === null;
}

/**
 * The master's quote, with approve and decline (ADR-0060 §§ 2–4).
 *
 * Shown only while the order is `MASTER_ARRIVED` and inspection-priced, and
 * not yet approved. Before the master quotes it says the master is looking.
 *
 * **Both actions name the amount on screen.** If the master replaced the quote
 * a moment earlier, the server answers `ORDER_PRICE_STALE`, the order is
 * re-read, and the card says the price changed instead of approving a figure
 * the customer never saw. A decline cancels the order, so it asks first.
 */
export function PriceApproval({ order }: { readonly order: Order }): React.JSX.Element | null {
  const [approve, approveResult] = useApproveOrderPriceMutation();
  const [decline, declineResult] = useDeclineOrderPriceMutation();
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (order.status !== 'MASTER_ARRIVED' || !isOpenQuote(order)) {
    return null;
  }

  const amountMinor = order.priceMinor;

  if (amountMinor === null) {
    return (
      <Card>
        <Text variant="body" tone="muted">
          {copy.awaiting}
        </Text>
      </Card>
    );
  }

  const busy = approveResult.isLoading || declineResult.isLoading;

  function refused(error: unknown): void {
    setProblem(errorCodeOf(error) === 'ORDER_PRICE_STALE' ? copy.stale : copy.failed);
  }

  return (
    <Card className="gap-3">
      <Text variant="caption" tone="muted">
        {copy.title}
      </Text>
      <Text variant="h2">{formatOrderPrice(amountMinor)}</Text>
      <Text variant="body" tone="muted">
        {copy.hint}
      </Text>
      {problem !== null && <Banner tone="danger" message={problem} />}
      <View className="gap-2">
        <Button
          label={copy.approve}
          variant="accent"
          fullWidth
          loading={approveResult.isLoading}
          disabled={busy}
          onPress={() => {
            setProblem(null);
            void approve({ orderId: order.id, amountMinor }).unwrap().catch(refused);
          }}
        />
        <Button
          label={copy.decline}
          variant="ghost"
          fullWidth
          disabled={busy}
          onPress={() => {
            setProblem(null);
            setConfirming(true);
          }}
        />
      </View>
      {confirming && (
        <Sheet title={copy.declineTitle} className="rounded-md">
          <Text variant="body" tone="muted">
            {copy.declineDescription}
          </Text>
          <View className="flex-row gap-3">
            <Button
              label={copy.declineCancel}
              variant="secondary"
              disabled={busy}
              className="flex-1"
              onPress={() => {
                setConfirming(false);
              }}
            />
            <Button
              label={copy.declineConfirm}
              variant="danger"
              loading={declineResult.isLoading}
              className="flex-1"
              onPress={() => {
                void decline({ orderId: order.id, amountMinor })
                  .unwrap()
                  .catch(refused)
                  .finally(() => {
                    setConfirming(false);
                  });
              }}
            />
          </View>
        </Sheet>
      )}
    </Card>
  );
}
