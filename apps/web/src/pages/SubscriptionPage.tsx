import type {
  MasterSubscription,
  SubscriptionBillingPeriod,
  SubscriptionOffer,
} from '@tezusta/types';
import { type FormEvent, useState } from 'react';

import { describeFailure } from '../api/api-error';
import {
  useAutoRenewalQuery,
  useDisableAutoRenewalMutation,
  useMySubscriptionQuery,
  useOfferQuery,
  useSignOutMutation,
  useStartCheckoutMutation,
  webApi,
} from '../api/web-api';
import { Banner } from '../components/Banner';
import { Button } from '../components/Button';
import { Checkbox } from '../components/Checkbox';
import { copy } from '../copy';
import { goToCheckout, saveSnapshot } from '../checkout-handoff';
import { formatDate, formatMoney } from '../format';
import { useAppDispatch } from '../hooks';
import { signedOut } from '../session/session-slice';
import { Card, PageFrame } from './PageFrame';

const PERIODS: readonly SubscriptionBillingPeriod[] = ['monthly', 'yearly'];

function StatusCard({ subscription }: { subscription: MasterSubscription }) {
  return (
    <Card title={copy.subscription.statusTitle}>
      <p className="text-body-strong font-bold text-text">
        {copy.subscription.status[subscription.status]}
      </p>
      <p className="text-body text-text">
        {copy.subscription.periodEnds(formatDate(subscription.currentPeriodEnd))}
      </p>
      {subscription.graceEndsAt !== null && (
        <p className="text-body text-text">
          {copy.subscription.graceEnds(formatDate(subscription.graceEndsAt))}
        </p>
      )}
      {subscription.nextBillingPeriod !== null && (
        <p className="text-body text-text">
          {copy.subscription.nextQueued(subscription.nextBillingPeriod)}
        </p>
      )}
    </Card>
  );
}

/** "Cancel" is turning auto-renewal off (ADR-0061 § 6, ADR-0058). */
function RenewalCard() {
  const renewal = useAutoRenewalQuery();
  const [disable, disabling] = useDisableAutoRenewalMutation();
  if (renewal.data === undefined) return null;

  if (!renewal.data.enabled) {
    return (
      <Card>
        <p className="text-body text-text">{copy.subscription.renewalOff}</p>
      </Card>
    );
  }
  return (
    <Card>
      <p className="text-body text-text">{copy.subscription.renewalOn}</p>
      {disabling.isError && <Banner tone="danger" message={copy.unexpected} />}
      <Button
        variant="secondary"
        label={copy.subscription.turnOff}
        loadingLabel={copy.subscription.turningOff}
        loading={disabling.isLoading}
        onClick={() => void disable()}
      />
      <p className="text-footnote text-text-muted">{copy.subscription.turnOffNote}</p>
    </Card>
  );
}

function checkoutFailureMessage(error: Parameters<typeof describeFailure>[0]): string {
  const failure = describeFailure(error);
  if (failure?.code === 'SUBSCRIPTION_PURCHASES_CLOSED') return copy.subscription.purchasesClosed;
  if (failure?.code === 'SUBSCRIPTION_PERIOD_ALREADY_QUEUED')
    return copy.subscription.alreadyQueued;
  // `assertCanAcceptWork`'s refusal: not approved, or suspended (ADR-0061 § 4).
  if (failure?.status === 409) return copy.subscription.notEligible;
  if (failure?.status === 429) return copy.rateLimited;
  return copy.unexpected;
}

function BuyCard({
  offer,
  subscription,
}: {
  offer: SubscriptionOffer;
  subscription: MasterSubscription | undefined;
}) {
  const [period, setPeriod] = useState<SubscriptionBillingPeriod>('monthly');
  // ADR-0058: off unless the master asks for it.
  const [autoRenew, setAutoRenew] = useState(false);
  const [startCheckout, checkout] = useStartCheckoutMutation();
  const [leaving, setLeaving] = useState(false);
  const [badLink, setBadLink] = useState(false);

  if (!offer.purchasesOpen) {
    return (
      <Card title={copy.subscription.buyTitle}>
        <p className="text-body text-text">{copy.subscription.purchasesClosed}</p>
      </Card>
    );
  }

  async function onPay(event: FormEvent) {
    event.preventDefault();
    setBadLink(false);
    const result = await startCheckout({ billingPeriod: period, autoRenew });
    if ('error' in result) return;
    if (subscription !== undefined) saveSnapshot(subscription);
    setLeaving(true);
    if (!goToCheckout(result.data.checkoutUrl)) {
      setLeaving(false);
      setBadLink(true);
    }
  }

  return (
    <Card title={copy.subscription.buyTitle}>
      <form className="flex flex-col gap-4" onSubmit={(event) => void onPay(event)}>
        {checkout.isError && (
          <Banner tone="danger" message={checkoutFailureMessage(checkout.error)} />
        )}
        {badLink && <Banner tone="danger" message={copy.unexpected} />}
        <fieldset className="flex flex-col gap-3">
          <legend className="sr-only">{copy.subscription.buyTitle}</legend>
          {PERIODS.map((option) => {
            const price = offer[option];
            if (price === null) return null;
            return (
              <label key={option} className="flex items-center gap-3 text-body text-text">
                <input
                  type="radio"
                  name="billing-period"
                  value={option}
                  checked={period === option}
                  onChange={() => setPeriod(option)}
                  className="accent-inverse-surface"
                />
                <span className="font-bold">{copy.subscription.period[option]}</span>
                <span>{copy.subscription.price(formatMoney(price.priceMinor), option)}</span>
              </label>
            );
          })}
        </fieldset>
        <Checkbox
          label={copy.subscription.autoRenewConsent}
          checked={autoRenew}
          onChange={(event) => setAutoRenew(event.target.checked)}
        />
        <Button
          type="submit"
          variant="accent"
          label={copy.subscription.pay}
          loadingLabel={copy.subscription.paying}
          loading={checkout.isLoading || leaving}
        />
      </form>
    </Card>
  );
}

/**
 * The master's subscription: where it stands, auto-renewal, and buying a
 * period (ADR-0061 § 6). A master verification has not yet approved has no
 * subscription (404), sees why, and is refused at checkout by the server.
 */
export function SubscriptionPage() {
  const dispatch = useAppDispatch();
  const subscription = useMySubscriptionQuery();
  const offer = useOfferQuery();
  const [signOut, signingOut] = useSignOutMutation();

  async function onSignOut() {
    await signOut();
    dispatch(webApi.util.resetApiState());
    dispatch(signedOut());
  }

  const subscriptionFailure = describeFailure(subscription.error);
  const notVerified = subscriptionFailure?.status === 404;

  return (
    <PageFrame
      action={
        <Button
          variant="ghost"
          label={copy.subscription.signOut}
          loading={signingOut.isLoading}
          onClick={() => void onSignOut()}
        />
      }
    >
      {subscription.isLoading || offer.isLoading ? (
        <p className="text-body text-text-muted">{copy.loading}</p>
      ) : (
        <>
          {subscription.data !== undefined && <StatusCard subscription={subscription.data} />}
          {notVerified && (
            <Card title={copy.subscription.statusTitle}>
              <p className="text-body text-text">{copy.subscription.notVerified}</p>
            </Card>
          )}
          {(subscription.isError && !notVerified) || offer.isError ? (
            <Card>
              <Banner tone="danger" message={copy.subscription.loadFailed} />
              <Button
                variant="secondary"
                label={copy.retry}
                onClick={() => {
                  void subscription.refetch();
                  void offer.refetch();
                }}
              />
            </Card>
          ) : null}
          {subscription.data !== undefined && <RenewalCard />}
          {offer.data !== undefined && (
            <BuyCard offer={offer.data} subscription={subscription.data} />
          )}
        </>
      )}
    </PageFrame>
  );
}
