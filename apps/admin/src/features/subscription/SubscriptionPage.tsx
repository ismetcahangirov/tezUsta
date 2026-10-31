import type {
  AdminSubscription,
  AdminSubscriptionPriceVersion,
  SubscriptionBillingPeriod,
} from '@tezusta/types';
import { type ReactNode, useState } from 'react';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Table, TD_CLASS, TH_CLASS } from '../../components/Table';
import { copy } from '../../copy';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useSignedInAdmin } from '../../shell/Shell';
import { formatAzn } from '../catalogue/money';
import { useAdminSubscriptionQuery } from './api';
import { subscriptionCopy as text } from './copy';
import { PricesDialog, SettingsDialog, WithdrawDialog } from './SubscriptionDialogs';

const PERIODS: readonly SubscriptionBillingPeriod[] = ['monthly', 'yearly'];

type OpenDialog =
  | { readonly kind: 'prices' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'withdraw'; readonly price: AdminSubscriptionPriceVersion };

/**
 * The subscription offer (#324, ADR-0046 § 5): the two prices, any scheduled
 * change, trial, grace and whether purchases are open, and every price
 * version ever entered. Edits need `subscriptions.manage`; without it the page
 * is read-only and its controls are not rendered. The server enforces the
 * permission regardless.
 */
export function SubscriptionPage() {
  const { data, error, isLoading, refetch } = useAdminSubscriptionQuery();

  return (
    <PageFrame title={copy.nav.subscription}>
      <p className="max-w-3xl text-lead text-text-muted">{text.intro}</p>
      {isLoading ? (
        <p role="status" className="text-body text-text-muted">
          {text.loading}
        </p>
      ) : data === undefined ? (
        <div className="flex flex-col items-start gap-3">
          <Banner
            tone="danger"
            message={
              describeFailure(error)?.status === 403 ? text.errors.FORBIDDEN : text.loadFailed
            }
          />
          <Button label={text.retry} variant="secondary" onClick={() => void refetch()} />
        </div>
      ) : (
        <Offer offer={data} />
      )}
    </PageFrame>
  );
}

function Offer({ offer }: { offer: AdminSubscription }) {
  const me = useSignedInAdmin();
  const canManage = me.permissions.includes('subscriptions.manage');
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const close = () => setDialog(null);

  return (
    <>
      <Section
        title={text.prices}
        action={
          canManage && (
            <Button
              label={text.changePrices}
              variant="secondary"
              onClick={() => setDialog({ kind: 'prices' })}
            />
          )
        }
      >
        <dl className="grid grid-cols-2 gap-4">
          {PERIODS.map((period) => {
            const current = offer[period];
            const scheduled = offer.scheduled[period];
            return (
              <div
                key={period}
                className="flex flex-col gap-1 rounded-md border-hairline border-border bg-surface p-4"
              >
                <dt className="text-caption text-text-muted">{text.period[period]}</dt>
                <dd className="text-display text-text">
                  {current === null ? text.noPrice : formatAzn(current.priceMinor)}
                </dd>
                {scheduled !== null && scheduled.priceMinor !== null && (
                  <dd className="flex flex-wrap items-center gap-3 text-caption text-text">
                    <span>
                      {text.scheduledFrom(
                        formatAzn(scheduled.priceMinor),
                        formatDateTime(scheduled.effectiveFrom),
                      )}
                    </span>
                    {canManage && (
                      <Button
                        label={text.withdraw}
                        variant="secondary"
                        onClick={() => setDialog({ kind: 'withdraw', price: scheduled })}
                      />
                    )}
                  </dd>
                )}
              </div>
            );
          })}
        </dl>
      </Section>

      <Section
        title={text.settings}
        action={
          canManage && (
            <Button
              label={text.changeSettings}
              variant="secondary"
              onClick={() => setDialog({ kind: 'settings' })}
            />
          )
        }
      >
        <dl className="grid grid-cols-3 gap-4 rounded-md border-hairline border-border bg-surface p-4">
          <Fact label={text.trialDays} value={text.days(offer.trialDays)} />
          <Fact label={text.graceDays} value={text.days(offer.graceDays)} />
          <Fact label={text.purchasesOpen} value={offer.purchasesOpen ? text.open : text.closed} />
        </dl>
      </Section>

      <Section title={text.history}>
        {offer.priceHistory.length === 0 ? (
          <p className="text-body text-text-muted">{text.noHistory}</p>
        ) : (
          <Table caption={text.historyCaption}>
            <thead>
              <tr>
                <th scope="col" className={TH_CLASS}>
                  {text.historyColumns.period}
                </th>
                <th scope="col" className={TH_CLASS}>
                  {text.historyColumns.price}
                </th>
                <th scope="col" className={TH_CLASS}>
                  {text.historyColumns.effectiveFrom}
                </th>
                <th scope="col" className={TH_CLASS}>
                  {text.historyColumns.entered}
                </th>
                <th scope="col" className={TH_CLASS}>
                  {text.historyColumns.state}
                </th>
              </tr>
            </thead>
            <tbody>
              {offer.priceHistory.map((row) => (
                <tr key={row.id}>
                  <td className={TD_CLASS}>{text.period[row.billingPeriod]}</td>
                  <td className={TD_CLASS}>
                    {row.priceMinor === null ? text.none : formatAzn(row.priceMinor)}
                  </td>
                  <td className={TD_CLASS}>
                    {row.state === 'withdrawal' ? text.none : formatDateTime(row.effectiveFrom)}
                  </td>
                  <td className={TD_CLASS}>{formatDateTime(row.createdAt)}</td>
                  <td className={TD_CLASS}>{text.priceState[row.state]}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Section>

      {dialog?.kind === 'prices' && <PricesDialog offer={offer} onClose={close} onDone={close} />}
      {dialog?.kind === 'settings' && (
        <SettingsDialog offer={offer} onClose={close} onDone={close} />
      )}
      {dialog?.kind === 'withdraw' && (
        <WithdrawDialog price={dialog.price} onClose={close} onDone={close} />
      )}
    </>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-body-strong text-text">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-body text-text">{value}</dd>
    </div>
  );
}
