import type { MasterJob } from '@tezusta/types';
import { useState } from 'react';
import { View } from 'react-native';

import { Banner, Button, Card, Text, TextField } from '../components';
import { formatOrderPrice } from '../orders/format-order-price';
import { parsePriceInput } from '../orders/parse-price-input';
import { useQuoteJobPriceMutation } from './master-jobs-endpoints';
import { MASTER_JOBS_COPY } from './master-jobs-copy';

const copy = MASTER_JOBS_COPY.job.quote;

/**
 * Whether this job's work is waiting for the customer to approve a price
 * ([ADR-0060](../../../../docs/decisions/ADR-0060-inspection-price-approval.md)
 * § 2). The server refuses the start anyway; this is what lets the screen say
 * why before the master taps.
 */
export function awaitsPriceApproval(job: MasterJob): boolean {
  return job.pricingKind === 'inspection' && job.priceApprovedAt === null;
}

/**
 * The price of an inspection-priced job, entered on site (ADR-0060 § 1).
 *
 * Shown only while the master is `MASTER_ARRIVED` on such a job. Until the
 * customer approves, the master may send a quote and replace it; once
 * approved, the card only states the figure, which is frozen (§ 3).
 *
 * The amount is parsed from the digits by `parsePriceInput`, so what is sent
 * is always whole qəpik and never a float that rounds.
 */
export function InspectionQuote({ job }: { readonly job: MasterJob }): React.JSX.Element | null {
  const [quote, quoteResult] = useQuoteJobPriceMutation();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [failed, setFailed] = useState(false);

  if (job.status !== 'MASTER_ARRIVED' || job.pricingKind !== 'inspection') {
    return null;
  }

  if (job.priceApprovedAt !== null && job.priceMinor !== null) {
    return (
      <Card>
        <Text variant="body-strong">{copy.approved(formatOrderPrice(job.priceMinor))}</Text>
      </Card>
    );
  }

  const amountMinor = parsePriceInput(text);

  return (
    <Card className="gap-3">
      <Text variant="body-strong">{copy.title}</Text>
      <Text variant="body" tone="muted">
        {copy.hint}
      </Text>
      {failed && <Banner tone="danger" message={copy.failed} />}
      {job.priceMinor !== null && (
        <Text variant="body">{copy.waiting(formatOrderPrice(job.priceMinor))}</Text>
      )}
      <TextField
        label={copy.label}
        value={text}
        onChangeText={setText}
        keyboardType="decimal-pad"
        maxLength={10}
        {...(touched && amountMinor === null ? { error: copy.invalid } : {})}
      />
      <Button
        label={job.priceMinor === null ? copy.send : copy.update}
        variant="primary"
        fullWidth
        loading={quoteResult.isLoading}
        onPress={() => {
          setTouched(true);
          if (amountMinor === null) {
            return;
          }
          setFailed(false);
          void quote({ orderId: job.orderId, amountMinor })
            .unwrap()
            .then(() => {
              setText('');
              setTouched(false);
            })
            .catch(() => {
              setFailed(true);
            });
        }}
      />
    </Card>
  );
}

/** What stands under a start button that is waiting for the customer. */
export function StartBlockedNote(): React.JSX.Element {
  return (
    <View>
      <Text variant="caption" tone="muted">
        {copy.startBlocked}
      </Text>
    </View>
  );
}
