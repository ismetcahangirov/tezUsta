import type { AdminMasterSubscription, MasterVerificationStatus } from '@tezusta/types';
import { useState } from 'react';

import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { formatDateTime } from '../../format';
import { useSignedInAdmin } from '../../shell/Shell';
import { formatAzn } from '../catalogue/money';
import { useMasterSubscriptionQuery } from './api';
import { subscriptionCopy as text } from './copy';
import { CancelSubscriptionDialog, GrantDialog } from './SubscriptionDialogs';

/**
 * Days are granted once verification has approved the master — or to a
 * suspended one, in compensation. Before approval a grant would take the
 * trial approval starts, and the server refuses it.
 */
function grantable(status: MasterVerificationStatus): boolean {
  return status === 'active' || status === 'suspended';
}

/** Cancelling makes sense only while something renews: an active period, or one in grace. */
function cancellable(view: AdminMasterSubscription): boolean {
  const status = view.subscription?.status;
  return status === 'active' || status === 'past_due';
}

/**
 * One master's subscription on their file (#324): where it stands, its
 * history with what each period was paid at, and — for
 * `subscriptions.manage` — granting days and cancelling.
 */
export function MasterSubscriptionPanel({
  masterId,
  masterName,
  verificationStatus,
}: {
  masterId: string;
  masterName: string;
  verificationStatus: MasterVerificationStatus;
}) {
  const me = useSignedInAdmin();
  const canManage = me.permissions.includes('subscriptions.manage');
  const { data, isLoading, isError } = useMasterSubscriptionQuery(masterId);
  const [dialog, setDialog] = useState<'grant' | 'cancel' | null>(null);
  const [done, setDone] = useState<'grant' | 'cancel' | null>(null);

  if (isLoading) {
    return (
      <p role="status" className="text-body text-text-muted">
        {text.loading}
      </p>
    );
  }
  if (isError || data === undefined) {
    return <Banner tone="danger" message={text.master.loadFailed} />;
  }

  const subscription = data.subscription;

  return (
    <div className="flex flex-col gap-3">
      {done !== null && <Banner message={text.master.done[done]} />}

      {subscription === null ? (
        <p className="text-body text-text-muted">{text.master.none}</p>
      ) : (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4 lg:grid-cols-3">
          <Fact label={text.master.status} value={text.status[subscription.status]} />
          <Fact
            label={text.master.billingPeriod}
            value={
              subscription.billingPeriod === null
                ? subscription.status === 'trialing'
                  ? text.none
                  : text.master.granted
                : text.period[subscription.billingPeriod]
            }
          />
          <Fact
            label={text.master.periodEnd}
            value={formatDateTime(subscription.currentPeriodEnd)}
          />
          {subscription.graceEndsAt !== null && (
            <Fact label={text.master.graceEnd} value={formatDateTime(subscription.graceEndsAt)} />
          )}
          {subscription.nextBillingPeriod !== null && (
            <Fact label={text.master.queued} value={text.period[subscription.nextBillingPeriod]} />
          )}
          <Fact
            label={text.master.entitled}
            value={subscription.entitled ? text.master.yes : text.master.no}
          />
        </dl>
      )}

      {canManage && (
        <div role="group" aria-label={text.master.title} className="flex flex-wrap gap-3">
          {grantable(verificationStatus) && (
            <Button
              label={text.master.grant}
              variant="secondary"
              onClick={() => {
                setDone(null);
                setDialog('grant');
              }}
            />
          )}
          {cancellable(data) && (
            <Button
              label={text.master.cancel}
              variant="secondary"
              onClick={() => {
                setDone(null);
                setDialog('cancel');
              }}
            />
          )}
        </div>
      )}

      <h3 className="text-caption font-bold text-text">{text.master.history}</h3>
      {data.events.length === 0 ? (
        <p className="text-body text-text-muted">{text.master.noEvents}</p>
      ) : (
        <ol aria-label={text.master.history} className="flex flex-col gap-2">
          {data.events.map((event) => (
            <li
              key={`${event.createdAt}-${event.kind}`}
              className="flex flex-col gap-1 rounded-md border-hairline border-border bg-surface px-4 py-3"
            >
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="text-body-strong font-bold text-text">
                  {text.master.event[event.kind] ?? event.kind}
                </span>
                <span className="text-caption text-text-muted">
                  {formatDateTime(event.periodStart)} – {formatDateTime(event.periodEnd)}
                  {event.amountMinor !== null &&
                    ` · ${text.master.paidAt(formatAzn(event.amountMinor))}`}
                  {' · '}
                  {text.master.by(text.master.actor(event.actor))} ·{' '}
                  {formatDateTime(event.createdAt)}
                </span>
              </div>
              {event.reason !== null && (
                <p className="whitespace-pre-wrap text-body text-text">{event.reason}</p>
              )}
            </li>
          ))}
        </ol>
      )}

      {dialog === 'grant' && (
        <GrantDialog
          masterId={masterId}
          masterName={masterName}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setDone('grant');
          }}
        />
      )}
      {dialog === 'cancel' && (
        <CancelSubscriptionDialog
          masterId={masterId}
          masterName={masterName}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            setDone('cancel');
          }}
        />
      )}
    </div>
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
