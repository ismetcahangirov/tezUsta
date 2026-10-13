import type { AdminCustomerDetail, AdminCustomerSuspension } from '@tezusta/types';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { formatDateTime } from '../../format';
import { PageFrame } from '../../shell/PageFrame';
import { useSignedInAdmin } from '../../shell/Shell';
import { OrdersTable } from '../orders/OrdersTable';
import { shortOrderId } from '../orders/rules';
import { useCustomerDetailQuery, useCustomerOrdersInfiniteQuery } from './api';
import { customersCopy } from './copy';
import { type CustomerStatusAction, CustomerStatusDialog } from './CustomerStatusDialog';
import { CustomerStatusBadge } from './CustomerStatusBadge';
import { RevealCustomerPhoneDialog } from './RevealCustomerPhoneDialog';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-h2 font-bold text-text">{title}</h2>
      {children}
    </section>
  );
}

function BackLink() {
  return (
    <Link
      to="/customers"
      className="self-start text-caption text-text-muted underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
    >
      ← {customersCopy.back}
    </Link>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-text-muted">{label}</dt>
      <dd className="text-body text-text">{children}</dd>
    </div>
  );
}

/** One customer's file (#328): profile, counts, addresses, orders, and the account actions. */
export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { data: customer, error, isLoading, refetch } = useCustomerDetailQuery(id);
  const failure = describeFailure(error);

  if (customer === undefined) {
    return (
      <PageFrame title={customersCopy.title}>
        <BackLink />
        {isLoading ? (
          <p role="status" className="text-body text-text-muted">
            {customersCopy.loading}
          </p>
        ) : failure?.status === 404 || failure?.code === 'VALIDATION_FAILED' ? (
          <Banner tone="danger" message={customersCopy.notFound} />
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={customersCopy.detailLoadFailed} />
            <Button
              label={customersCopy.retry}
              variant="secondary"
              onClick={() => void refetch()}
            />
          </div>
        )}
      </PageFrame>
    );
  }

  return <CustomerFile customer={customer} />;
}

type Outcome = { action: 'suspend'; suspension: AdminCustomerSuspension } | { action: 'reinstate' };

function CustomerFile({ customer }: { customer: AdminCustomerDetail }) {
  const me = useSignedInAdmin();
  const canChangeStatus = me.permissions.includes('customers.suspend');
  const canRevealPhone = me.permissions.includes('pii.read');
  const canOpenMaster = me.permissions.includes('masters.read');
  const [pending, setPending] = useState<CustomerStatusAction | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const action: CustomerStatusAction | null =
    customer.status === 'active' ? 'suspend' : customer.status === 'suspended' ? 'reinstate' : null;

  return (
    <PageFrame title={customer.displayName}>
      <BackLink />
      <div className="flex flex-wrap items-center gap-3">
        <CustomerStatusBadge status={customer.status} />
        {customer.status === 'suspended' && customer.statusChangedAt !== null && (
          <span className="text-caption text-text-muted">
            {customersCopy.statusSince} {formatDateTime(customer.statusChangedAt)}
          </span>
        )}
      </div>
      {customer.status === 'suspended' && customer.statusReason !== null && (
        <p className="whitespace-pre-wrap text-body text-text">
          <span className="text-caption text-text-muted">{customersCopy.statusReason}: </span>
          {customer.statusReason}
        </p>
      )}

      {outcome !== null && <OutcomeBanner outcome={outcome} />}

      {(canChangeStatus && action !== null) || canRevealPhone ? (
        <div role="group" aria-label={customersCopy.actions} className="flex flex-wrap gap-3">
          {canChangeStatus && action !== null && (
            <Button
              label={customersCopy[action]}
              variant={action === 'reinstate' ? 'accent' : 'secondary'}
              onClick={() => {
                setOutcome(null);
                setPending(action);
              }}
            />
          )}
          {canRevealPhone && (
            <Button
              label={customersCopy.revealNumber}
              variant="secondary"
              onClick={() => setRevealing(true)}
            />
          )}
        </div>
      ) : null}

      <Section title={customersCopy.profile}>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4 lg:grid-cols-4">
          <Fact label={customersCopy.joined}>{formatDateTime(customer.createdAt)}</Fact>
          <Fact label={customersCopy.phone}>{customer.phoneMasked}</Fact>
          <Fact label={customersCopy.ratings}>{String(customer.ratingCount)}</Fact>
          <Fact label={customersCopy.masterProfile}>
            {customer.masterProfile === null ? (
              customersCopy.noMasterProfile
            ) : canOpenMaster ? (
              <Link
                to={`/masters/${customer.masterProfile.id}`}
                className="font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
              >
                {customer.masterProfile.displayName}
              </Link>
            ) : (
              customer.masterProfile.displayName
            )}
          </Fact>
        </dl>
      </Section>

      <Section title={customersCopy.orderCounts}>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 rounded-md border-hairline border-border bg-surface p-4 lg:grid-cols-4">
          {(Object.keys(customersCopy.counts) as (keyof typeof customersCopy.counts)[]).map(
            (group) => (
              <Fact key={group} label={customersCopy.counts[group]}>
                {String(customer.orderCounts[group])}
              </Fact>
            ),
          )}
        </dl>
      </Section>

      <Section title={customersCopy.addresses}>
        <p className="text-caption text-text-muted">{customersCopy.addressesNote}</p>
        {customer.addresses.length === 0 ? (
          <p className="text-body text-text-muted">{customersCopy.noAddresses}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {customer.addresses.map((address, index) => (
              <li key={index} className="text-body text-text">
                {address.label ?? customersCopy.unnamedAddress}
                {address.isDefault && (
                  <span className="text-caption text-text-muted">
                    {' '}
                    ({customersCopy.defaultAddress})
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={customersCopy.orders}>
        <CustomerOrders customerId={customer.id} />
      </Section>

      {pending !== null && (
        <CustomerStatusDialog
          customerId={customer.id}
          customerName={customer.displayName}
          action={pending}
          masterName={customer.masterProfile?.displayName ?? null}
          onClose={() => setPending(null)}
          onDone={(result) => {
            setPending(null);
            setOutcome(result);
          }}
        />
      )}
      {revealing && (
        <RevealCustomerPhoneDialog
          customerId={customer.id}
          name={customer.displayName}
          onClose={() => setRevealing(false)}
        />
      )}
    </PageFrame>
  );
}

function OutcomeBanner({ outcome }: { outcome: Outcome }) {
  if (outcome.action === 'reinstate') {
    return <Banner message={customersCopy.reinstated} />;
  }
  const { cancelledOrderIds, followUpOrderIds } = outcome.suspension;
  return (
    <div className="flex flex-col gap-2">
      <Banner message={customersCopy.suspended(cancelledOrderIds.length)} />
      {followUpOrderIds.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-body text-text">{customersCopy.followUp}</p>
          <ul className="flex flex-wrap gap-3">
            {followUpOrderIds.map((orderId) => (
              <li key={orderId}>
                <Link
                  to={`/orders/${orderId}`}
                  className="font-mono font-bold underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {shortOrderId(orderId)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CustomerOrders({ customerId }: { customerId: string }) {
  const { data, error, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } =
    useCustomerOrdersInfiniteQuery(customerId);
  return (
    <OrdersTable
      caption={customersCopy.ordersCaption}
      emptyMessage={customersCopy.noOrders}
      pages={data?.pages}
      isLoading={isLoading}
      failed={error !== undefined}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onRetry={() => void refetch()}
      onLoadMore={() => void fetchNextPage()}
    />
  );
}
