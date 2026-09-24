import type { AdminOrderDetail, AdminOrderParty, OrderStatus } from '@tezusta/types';
import { type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router';

import { describeFailure } from '../../api/api-error';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { formatDateTime, formatMoney } from '../../format';
import { useAppDispatch } from '../../hooks';
import { openInNewTab } from '../../open-in-new-tab';
import { PageFrame } from '../../shell/PageFrame';
import { useSignedInAdmin } from '../../shell/Shell';
import { type OrderParty, ordersApi, useOrderDetailQuery, useOrderTranscriptQuery } from './api';
import { ordersCopy } from './copy';
import { OrderStatusBadge } from './OrderStatusBadge';
import { OverrideDialog } from './OverrideDialog';
import { RevealPhoneDialog } from './RevealPhoneDialog';
import { OVERRIDE_PERMISSIONS, shortOrderId } from './rules';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-h2 font-bold text-text">{title}</h2>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 rounded-md border-hairline border-border bg-surface p-4">
      {children}
    </div>
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

function BackLink() {
  return (
    <Link
      to="/orders"
      className="self-start text-caption text-text-muted underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
    >
      ← {ordersCopy.back}
    </Link>
  );
}

/** One order (#249): what it is, who is on it, what happened to it, and the override. */
export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { data: order, error, isLoading, refetch } = useOrderDetailQuery(id);
  const failure = describeFailure(error);

  if (order === undefined) {
    return (
      <PageFrame title={ordersCopy.ordersTitle}>
        <BackLink />
        {isLoading ? (
          <p role="status" className="text-body text-text-muted">
            {ordersCopy.loading}
          </p>
        ) : failure?.status === 404 || failure?.code === 'VALIDATION_FAILED' ? (
          <Banner tone="danger" message={ordersCopy.notFound} />
        ) : (
          <div className="flex flex-col items-start gap-3">
            <Banner tone="danger" message={ordersCopy.detailLoadFailed} />
            <Button label={ordersCopy.retry} variant="secondary" onClick={() => void refetch()} />
          </div>
        )}
      </PageFrame>
    );
  }

  return <OrderFile order={order} />;
}

function OrderFile({ order }: { order: AdminOrderDetail }) {
  const me = useSignedInAdmin();
  const [overriding, setOverriding] = useState(false);
  const [changedTo, setChangedTo] = useState<OrderStatus | null>(null);
  const canOverride =
    order.transitions.length > 0 &&
    OVERRIDE_PERMISSIONS.some((permission) => me.permissions.includes(permission));

  return (
    <PageFrame title={ordersCopy.orderTitle(shortOrderId(order.id))}>
      <BackLink />
      <div className="flex flex-wrap items-center gap-3">
        <OrderStatusBadge status={order.status} />
        {canOverride && (
          <Button
            label={ordersCopy.override}
            variant="secondary"
            onClick={() => {
              setChangedTo(null);
              setOverriding(true);
            }}
          />
        )}
      </div>
      {changedTo !== null && (
        <Banner message={ordersCopy.overrideDone(ordersCopy.status[changedTo])} />
      )}

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Section title={ordersCopy.summary}>
          <Card>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3">
              <Fact label={ordersCopy.service}>{order.serviceName}</Fact>
              <Fact label={ordersCopy.price}>
                {order.priceMinor === null ? ordersCopy.priceNotSet : formatMoney(order.priceMinor)}
              </Fact>
              <Fact label={ordersCopy.created}>{formatDateTime(order.createdAt)}</Fact>
              <Fact label={ordersCopy.accepted}>
                {order.acceptedAt === null ? ordersCopy.none : formatDateTime(order.acceptedAt)}
              </Fact>
              <Fact label={ordersCopy.updated}>{formatDateTime(order.updatedAt)}</Fact>
              <Fact label={ordersCopy.redispatches}>{order.redispatchCount}</Fact>
              <div className="col-span-full">
                <Fact label={ordersCopy.description}>
                  <span className="whitespace-pre-wrap">{order.description}</span>
                </Fact>
              </div>
            </dl>
          </Card>
        </Section>

        <Section title={ordersCopy.address}>
          <Card>
            <p className="text-body text-text">{order.address.formattedAddress}</p>
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3">
              {(Object.keys(ordersCopy.addressParts) as (keyof typeof ordersCopy.addressParts)[])
                .filter((part) => order.address[part] !== null)
                .map((part) => (
                  <Fact key={part} label={ordersCopy.addressParts[part]}>
                    {order.address[part]}
                  </Fact>
                ))}
            </dl>
          </Card>
        </Section>
      </div>

      <Section title={ordersCopy.parties}>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PartyCard
            orderId={order.id}
            party="customer"
            label={ordersCopy.customer}
            person={order.customer}
          />
          <PartyCard
            orderId={order.id}
            party="master"
            label={ordersCopy.master}
            person={order.master}
          />
        </div>
      </Section>

      <Section title={ordersCopy.history}>
        {order.history.length === 0 ? (
          <p className="text-body text-text-muted">{ordersCopy.noHistory}</p>
        ) : (
          <ol aria-label={ordersCopy.history} className="flex flex-col gap-2">
            {order.history.map((entry, index) => (
              <li
                key={`${entry.createdAt}-${String(index)}`}
                className="flex flex-col gap-1 rounded-md border-hairline border-border bg-surface px-4 py-3"
              >
                <div className="flex flex-wrap items-baseline gap-x-3">
                  <span className="text-body-strong font-bold text-text">
                    {ordersCopy.historyEntry(
                      ordersCopy.status[entry.fromStatus],
                      ordersCopy.status[entry.toStatus],
                    )}
                  </span>
                  <span className="text-caption text-text-muted">
                    {ordersCopy.by(entry.actorAdminName ?? ordersCopy.actor[entry.actorKind])} ·{' '}
                    {formatDateTime(entry.createdAt)}
                  </span>
                </div>
                {entry.reason !== null && (
                  <p className="whitespace-pre-wrap text-body text-text">{entry.reason}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </Section>

      <Section title={ordersCopy.photos}>
        <Photos orderId={order.id} photos={order.photos} />
      </Section>

      {order.transcriptAvailable && (
        <Section title={ordersCopy.transcript}>
          <Transcript orderId={order.id} />
        </Section>
      )}

      {overriding && (
        <OverrideDialog
          orderId={order.id}
          transitions={order.transitions}
          permissions={me.permissions}
          onClose={() => setOverriding(false)}
          onDone={(to) => {
            setOverriding(false);
            setChangedTo(to);
          }}
        />
      )}
    </PageFrame>
  );
}

function PartyCard({
  orderId,
  party,
  label,
  person,
}: {
  orderId: string;
  party: OrderParty;
  label: string;
  person: AdminOrderParty | null;
}) {
  const me = useSignedInAdmin();
  const [revealing, setRevealing] = useState(false);

  return (
    <Card>
      <h3 className="text-caption font-bold text-text-muted">{label}</h3>
      {person === null ? (
        <p className="text-body text-text-muted">{ordersCopy.noMaster}</p>
      ) : (
        <>
          <p className="text-body-strong font-bold text-text">{person.displayName}</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-body text-text">
              {person.phoneMasked === '' ? ordersCopy.noPhone : person.phoneMasked}
            </span>
            {me.permissions.includes('pii.read') && person.phoneMasked !== '' && (
              <Button
                label={ordersCopy.revealNumber}
                aria-label={`${ordersCopy.revealNumber}: ${label}`}
                variant="secondary"
                onClick={() => setRevealing(true)}
              />
            )}
          </div>
          {revealing && (
            <RevealPhoneDialog
              orderId={orderId}
              party={party}
              name={person.displayName}
              onClose={() => setRevealing(false)}
            />
          )}
        </>
      )}
    </Card>
  );
}

function Photos({ orderId, photos }: { orderId: string; photos: AdminOrderDetail['photos'] }) {
  const dispatch = useAppDispatch();
  const [opening, setOpening] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function open(photoId: string) {
    setOpening(photoId);
    setFailed(false);
    const opened = await openInNewTab(async () => {
      const result = await dispatch(
        ordersApi.endpoints.orderPhotoDownload.initiate({ orderId, photoId }, { track: false }),
      );
      return result.data?.url;
    });
    setOpening(null);
    setFailed(!opened);
  }

  if (photos.length === 0) {
    return <p className="text-body text-text-muted">{ordersCopy.noPhotos}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {failed && <Banner tone="danger" message={ordersCopy.openFailed} />}
      <ul className="flex flex-wrap gap-3">
        {photos.map((photo, index) => (
          <li
            key={photo.id}
            className="flex items-center gap-3 rounded-md border-hairline border-border bg-surface px-4 py-2"
          >
            <span className="text-body text-text">{ordersCopy.photo(index + 1)}</span>
            <span className="text-caption text-text-muted">{formatDateTime(photo.createdAt)}</span>
            <Button
              label={ordersCopy.open}
              loadingLabel={ordersCopy.opening}
              loading={opening === photo.id}
              variant="secondary"
              aria-label={`${ordersCopy.open} ${ordersCopy.photo(index + 1)}`}
              onClick={() => void open(photo.id)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Loaded only when asked for — each read is audited (ADR-0043 § 6). */
function Transcript({ orderId }: { orderId: string }) {
  const [requested, setRequested] = useState(false);
  const { data, isLoading, isError, refetch } = useOrderTranscriptQuery(orderId, {
    skip: !requested,
  });

  if (!requested) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-caption text-text-muted">{ordersCopy.transcriptHint}</p>
        <Button
          label={ordersCopy.loadTranscript}
          variant="secondary"
          onClick={() => setRequested(true)}
        />
      </div>
    );
  }
  if (isLoading) {
    return (
      <p role="status" className="text-body text-text-muted">
        {ordersCopy.loading}
      </p>
    );
  }
  if (isError || data === undefined) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Banner tone="danger" message={ordersCopy.transcriptFailed} />
        <Button label={ordersCopy.retry} variant="secondary" onClick={() => void refetch()} />
      </div>
    );
  }
  if (data.conversations.length === 0) {
    return <p className="text-body text-text-muted">{ordersCopy.noConversations}</p>;
  }
  return (
    <div className="flex flex-col gap-4">
      {data.conversations.map((conversation, index) => (
        <Card key={conversation.id}>
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h3 className="text-body-strong font-bold text-text">
              {ordersCopy.conversation(index + 1)}
            </h3>
            <span className="text-caption text-text-muted">
              {ordersCopy.openedAt} {formatDateTime(conversation.openedAt)}
              {conversation.closedAt !== null &&
                ` · ${ordersCopy.closedAt} ${formatDateTime(conversation.closedAt)}`}
            </span>
          </div>
          {conversation.messages.length === 0 ? (
            <p className="text-body text-text-muted">{ordersCopy.noMessages}</p>
          ) : (
            <ol className="flex flex-col gap-2">
              {conversation.messages.map((message) => (
                <li key={message.id} className="flex flex-col gap-1">
                  <span className="text-caption text-text-muted">
                    <span className="font-bold">{ordersCopy.sender[message.senderKind]}</span> ·{' '}
                    {formatDateTime(message.createdAt)}
                  </span>
                  <p className="whitespace-pre-wrap text-body text-text">{message.body}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      ))}
    </div>
  );
}
