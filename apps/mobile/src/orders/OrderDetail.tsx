import { skipToken } from '@reduxjs/toolkit/query';
import { ScrollView, View } from 'react-native';

import { useListAddressesQuery } from '../addresses/addresses-endpoints';
import { formatAddressDetail } from '../addresses/format-address-detail';
import { isTransportFailure } from '../api/base-query';
import { Banner, Button, Card, EmptyState, Skeleton, Text } from '../components';
import { deviceLocale } from '../lib/device-locale';
import { useOrderRoom } from '../realtime';
import { useGetServiceQuery } from '../service-catalogue/service-catalogue-endpoints';
import { useOrderPhotosQuery, useOrderQuery } from './order-endpoints';
import { OrderPhotoThumbnail } from './OrderPhotoThumbnail';
import { OrderStatusCard } from './OrderStatusCard';
import { ORDERS_COPY as copy } from './orders-copy';

/** The same shape check `ServiceCatalogue` and `Addresses` make, for the same four states. */
function isOffline(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    isTransportFailure((error as { status?: unknown }).status)
  );
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const { status } = error as { status?: unknown };
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

/**
 * "There is no order here for you", whichever way the server says it.
 *
 * The API answers **404** for an order that is not the caller's, never 403 —
 * deliberately, so a stranger cannot learn that somebody else's order exists.
 * A 403 is accepted here anyway, because this screen must not render a raw
 * permission error under any circumstances (issue #155): a customer reading
 * "forbidden" learns nothing they can act on, and the retry button an error
 * state carries would be a control that can never succeed.
 */
function isNotAvailable(error: unknown): boolean {
  const status = statusOf(error);
  return status === 404 || status === 403;
}

export interface OrderDetailProps {
  readonly orderId: string;
  /** Back to wherever the customer came from — a tap, a notification, creation. */
  readonly onBack: () => void;
}

/**
 * One order: where it is, what happens next, and what was asked for
 * ([ADR-0029](docs/decisions/ADR-0029-customer-order-screen.md), issue #155).
 *
 * **The id is the only thing it is told.** Nothing about the order arrives
 * through navigation — not from creation, not from a notification — because a
 * status carried in a route parameter is a status that was true when the
 * navigation began, and this is the screen whose whole subject is what has
 * changed since then.
 *
 * **Four request states, rendered deliberately**, the shape `ServiceCatalogue`
 * established: a skeleton while nothing is known, the order once it is, a
 * caption over stale content when a refresh failed, and an empty state when
 * there is nothing behind the failure. A 404 is not one of those failures — the
 * API answers 404 for an order that is not the caller's, never 403, so "no such
 * order" and "not yours" are one plain message here rather than an error with a
 * retry button that can never succeed.
 *
 * **It reads; it does not act.** There is no cancel control, because the
 * cancellation policy is undecided (CLAUDE.md § 1) and a button about money has
 * to be able to say what it costs.
 *
 * **It listens, but it does not own a socket** (issue #170). `useOrderRoom`
 * asks the app's one connection to subscribe to this order while the screen is
 * mounted; an arriving transition patches the RTK Query cache and this
 * component re-renders from the same `useOrderQuery` it already used. There is
 * no socket-specific branch below and no second source of order state — with
 * the socket down, every line here behaves exactly as it did before.
 */
export function OrderDetail({ orderId, onBack }: OrderDetailProps): React.JSX.Element {
  useOrderRoom(orderId);
  const order = useOrderQuery(orderId);
  const photos = useOrderPhotosQuery(orderId);

  const current = order.currentData;

  // Skipped until the order is known, because the service id is on the order.
  // `skipToken` rather than `{ skip }` so the argument is never a placeholder
  // that could be requested by accident.
  const service = useGetServiceQuery(
    current === undefined ? skipToken : { id: current.serviceId, locale: deviceLocale() },
  );

  /**
   * The customer's own addresses, to name the one this order is going to.
   *
   * `Order` carries `addressId` and nothing else on purpose: an order that
   * copied the address would let the two drift. The list is already in the
   * cache by the time anybody reaches this screen — creation reads it — so this
   * is usually not a request at all. An address the customer has since deleted
   * simply does not resolve, and the screen says so with a dash rather than
   * inventing a line.
   */
  const addresses = useListAddressesQuery();
  const address = addresses.currentData?.find((candidate) => candidate.id === current?.addressId);

  if (current === undefined) {
    return (
      <OrderDetailFrame onBack={onBack}>
        {order.error === undefined ? (
          <OrderDetailSkeleton />
        ) : isNotAvailable(order.error) ? (
          <EmptyState
            title={copy.detail.notFoundTitle}
            description={copy.detail.notFoundDescription}
          />
        ) : (
          <EmptyState
            title={copy.detail.errorTitle}
            description={copy.detail.errorDescription}
            action={
              <Button
                label={copy.retry}
                loading={order.isFetching}
                onPress={() => {
                  void order.refetch();
                }}
              />
            }
          />
        )}
      </OrderDetailFrame>
    );
  }

  return (
    <OrderDetailFrame onBack={onBack}>
      <ScrollView className="flex-1">
        <View className="gap-4 pb-10">
          {/* A caption only where there is genuinely stale content to caption. */}
          {order.error !== undefined && (
            <Banner
              message={isOffline(order.error) ? copy.detail.staleNotice : copy.detail.errorTitle}
              action={
                <Button
                  label={copy.retry}
                  variant="ghost"
                  size="sm"
                  loading={order.isFetching}
                  onPress={() => {
                    void order.refetch();
                  }}
                />
              }
            />
          )}

          <OrderStatusCard status={current.status} priceMinor={current.priceMinor} />

          <Card className="gap-4">
            <Field
              label={copy.detail.service}
              value={service.currentData?.name ?? copy.detail.servicePending}
            />
            <Field
              label={copy.detail.address}
              value={address === undefined ? copy.detail.addressPending : address.formattedAddress}
              detail={address === undefined ? undefined : formatAddressDetail(address)}
            />
            <Field label={copy.detail.problem} value={current.description} />
          </Card>

          <OrderPhotos
            orderId={current.id}
            photoIds={photos.currentData?.map((photo) => photo.id)}
          />
        </View>
      </ScrollView>
    </OrderDetailFrame>
  );
}

interface OrderDetailFrameProps {
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}

/** The title row every state shares, so back is reachable from all of them. */
function OrderDetailFrame({ onBack, children }: OrderDetailFrameProps): React.JSX.Element {
  return (
    <View className="flex-1 gap-4 p-6">
      <View className="flex-row items-center justify-between">
        <Text variant="h1">{copy.detail.title}</Text>
        <Button label={copy.detail.back} variant="ghost" size="sm" onPress={onBack} />
      </View>
      {children}
    </View>
  );
}

interface FieldProps {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | undefined;
}

function Field({ label, value, detail }: FieldProps): React.JSX.Element {
  return (
    <View className="gap-1">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="body">{value}</Text>
      {detail !== undefined && detail !== '' && (
        <Text variant="caption" tone="muted">
          {detail}
        </Text>
      )}
    </View>
  );
}

interface OrderPhotosProps {
  readonly orderId: string;
  readonly photoIds: readonly string[] | undefined;
}

/**
 * The attached photos, or nothing at all.
 *
 * **An order with no photos renders no section**, rather than an empty state
 * telling somebody about a thing they chose not to do: photos are optional at
 * creation and most orders will not have them. The same is true while the list
 * is still loading — a heading with a spinner under it is noise on a screen
 * whose subject is elsewhere.
 */
function OrderPhotos({ orderId, photoIds }: OrderPhotosProps): React.JSX.Element | null {
  if (photoIds === undefined || photoIds.length === 0) {
    return null;
  }

  return (
    <View className="gap-2">
      <Text variant="caption" tone="muted">
        {copy.detail.photos}
      </Text>
      <View className="flex-row flex-wrap gap-3">
        {photoIds.map((photoId) => (
          <OrderPhotoThumbnail key={photoId} orderId={orderId} photoId={photoId} />
        ))}
      </View>
    </View>
  );
}

/** `accessible` is load-bearing — see `CatalogueSkeleton`: it gives the state a name to find. */
function OrderDetailSkeleton(): React.JSX.Element {
  return (
    <View accessible accessibilityLabel={copy.detail.loading} className="gap-4">
      <Skeleton className="h-control-lg w-full" />
      <Skeleton className="h-control-lg w-full" />
    </View>
  );
}
