import type { Address, Order, Service } from '@tezusta/types';
import { useState } from 'react';
import { Image, ScrollView, View } from 'react-native';

import { isTransportFailure } from '../api/base-query';
import { formatAddressDetail, useListAddressesQuery } from '../addresses';
import {
  Banner,
  Button,
  Card,
  EmptyState,
  ProgressBar,
  Skeleton,
  Text,
  TextField,
} from '../components';
import { rawStatusOf, statusOf } from '../addresses/addresses-errors';
import { deviceLocale } from '../lib/device-locale';
import { usePushAccessPrompt } from '../notifications';
import { useGetServiceQuery } from '../service-catalogue/service-catalogue-endpoints';
import {
  useAttachOrderPhotoMutation,
  useCreateOrderMutation,
  useServiceIndicativePriceRangeQuery,
} from './order-endpoints';
import { ORDERS_COPY as copy } from './orders-copy';
import { useOrderPhotos } from './useOrderPhotos';

/**
 * How many photos one order takes. Mirrors the server's own cap, which is the
 * authority — this only stops the customer picking a fifth one the API would
 * refuse anyway.
 */
const MAX_PHOTOS = 4;

/** Matches `createOrderSchema`'s bounds exactly, so the UI never offers what the API refuses. */
const MIN_DESCRIPTION = 10;
const MAX_DESCRIPTION = 2000;

/** Service selection is step 1 and happens on the catalogue; this screen owns 2–4. */
const TOTAL_STEPS = 4;

type Step = 'describe' | 'address' | 'confirm';

const STEP_NUMBER: Record<Step, number> = { describe: 2, address: 3, confirm: 4 };

export interface CreateOrderProps {
  readonly serviceId: string;
  /** Leaving the flow — back to wherever the customer came from. */
  readonly onClose: () => void;
  /** Somewhere to send the customer once the order exists. */
  readonly onCreated?: (order: Order) => void;
}

/**
 * Order creation: describe the problem, choose an address, confirm.
 *
 * **One screen, with the steps in local state** — the pattern the owner chose,
 * and the one `ServiceCatalogue.tsx` already uses for its category drill-down.
 * Splitting the steps into routes later is a change to this file and four new
 * files under `app/`, not a redesign, which is exactly why the flow is shaped
 * this way while the customer root's navigation is still open (CLAUDE.md §17).
 *
 * **Nothing here computes or submits a price.** The range shown at the
 * confirmation step is an estimate the server calculates and explicitly labels
 * as one; the real price is frozen when a master accepts
 * ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)).
 *
 * **The idempotency key is generated once per attempt**, when the flow opens,
 * and reused across every retry of that attempt. Regenerating it per request
 * would defeat the whole mechanism and leave a customer on a flaky connection
 * with two masters on their way to the same tap.
 */
export function CreateOrder({
  serviceId,
  onClose,
  onCreated,
}: CreateOrderProps): React.JSX.Element {
  const locale = deviceLocale();
  const service = useGetServiceQuery({ id: serviceId, locale });
  const addresses = useListAddressesQuery();
  const priceRange = useServiceIndicativePriceRangeQuery(serviceId);

  const [step, setStep] = useState<Step>('describe');
  const [description, setDescription] = useState('');
  const [addressId, setAddressId] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => newIdempotencyKey());
  const [created, setCreated] = useState<Order | null>(null);

  const photos = useOrderPhotos(MAX_PHOTOS);
  const [createOrder, createResult] = useCreateOrderMutation();
  // One of the two moments the app asks for notification permission. A
  // customer who has just placed an order is waiting to hear that somebody
  // took it, which is the only honest reason to show this dialog — see
  // `usePushAccessPrompt`.
  const askForPushAccess = usePushAccessPrompt();
  const [attachPhoto] = useAttachOrderPhotoMutation();

  const trimmed = description.trim();
  const descriptionError =
    trimmed.length === 0
      ? undefined
      : trimmed.length < MIN_DESCRIPTION
        ? copy.descriptionTooShort
        : trimmed.length > MAX_DESCRIPTION
          ? copy.descriptionTooLong
          : undefined;
  const canDescribe = trimmed.length >= MIN_DESCRIPTION && trimmed.length <= MAX_DESCRIPTION;

  const chosenAddress = addresses.currentData?.find((address) => address.id === addressId);

  async function submit(): Promise<void> {
    if (chosenAddress === undefined) {
      return;
    }
    try {
      const order = await createOrder({
        serviceId,
        addressId: chosenAddress.id,
        description: trimmed,
        idempotencyKey,
      }).unwrap();

      // Attaching is deliberately after creation and deliberately not awaited
      // as a precondition of success: the order exists, and a photo that fails
      // to attach must not turn a created order into an error the customer
      // reads as "nothing happened" (`docs/product/customer-flow.md`).
      await Promise.allSettled(
        photos.readyPhotoIds().map(async (photoId) => attachPhoto({ orderId: order.id, photoId })),
      );

      setCreated(order);
      onCreated?.(order);

      // After the order exists, never before: the prompt has to follow the
      // thing that justifies it. It resolves on its own and blocks nothing.
      askForPushAccess();
    } catch {
      // createResult.error is what the banner below renders. The flow stays
      // where it is, with everything the customer typed still in place, and
      // the same idempotency key ready for the retry.
    }
  }

  if (created !== null) {
    return (
      <View className="flex-1 justify-center p-6">
        <EmptyState
          title={copy.createdTitle}
          description={copy.createdDescription}
          action={<Button label={copy.done} variant="accent" onPress={onClose} />}
        />
      </View>
    );
  }

  return (
    <View className="flex-1">
      <View className="gap-4 p-6">
        <View className="flex-row items-center justify-between">
          <Button
            label={step === 'describe' ? copy.cancel : copy.back}
            variant="ghost"
            size="sm"
            onPress={() => {
              if (step === 'describe') {
                onClose();
              } else {
                setStep(step === 'confirm' ? 'address' : 'describe');
              }
            }}
          />
          <Text variant="caption" tone="muted">
            {copy.stepLabel(STEP_NUMBER[step], TOTAL_STEPS)}
          </Text>
        </View>
        <ProgressBar
          value={STEP_NUMBER[step]}
          max={TOTAL_STEPS}
          accessibilityLabel={copy.stepLabel(STEP_NUMBER[step], TOTAL_STEPS)}
        />
      </View>

      {createResult.error !== undefined ? (
        <View className="px-6 pb-4">
          <Banner tone="danger" message={submitErrorMessage(createResult.error)} />
        </View>
      ) : null}

      <ScrollView className="flex-1">
        <View className="gap-6 px-6 pb-10">
          {step === 'describe' ? (
            <DescribeStep
              description={description}
              error={descriptionError}
              photos={photos}
              onChange={setDescription}
            />
          ) : null}

          {step === 'address' ? (
            <AddressStep
              addresses={addresses.currentData}
              isLoading={addresses.currentData === undefined && addresses.error === undefined}
              error={addresses.error}
              selectedId={addressId}
              onSelect={setAddressId}
              onRetry={() => void addresses.refetch()}
            />
          ) : null}

          {step === 'confirm' ? (
            <ConfirmStep
              service={service.currentData}
              address={chosenAddress}
              description={trimmed}
              photoCount={photos.readyPhotoIds().length}
              priceRange={priceRange.currentData}
            />
          ) : null}
        </View>
      </ScrollView>

      <View className="border-t border-border p-6">
        {step === 'confirm' ? (
          <Button
            label={copy.submit}
            variant="accent"
            fullWidth
            loading={createResult.isLoading}
            disabled={chosenAddress === undefined || createResult.isLoading}
            onPress={() => void submit()}
          />
        ) : (
          <Button
            label={copy.next}
            variant="accent"
            fullWidth
            disabled={step === 'describe' ? !canDescribe : addressId === null}
            onPress={() => {
              setStep(step === 'describe' ? 'address' : 'confirm');
            }}
          />
        )}
      </View>
    </View>
  );
}

function submitErrorMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 404) {
    return copy.notFoundError;
  }
  return isTransportFailure(rawStatusOf(error)) ? copy.offlineError : copy.submitFailed;
}

/**
 * A key per attempt, not per request.
 *
 * `crypto.randomUUID` is not reliably present in a React Native runtime, and
 * pulling a uuid package in for one string would be a dependency for a few
 * lines of our own code (CLAUDE.md §10). The server only requires a bounded,
 * non-empty string that is stable across retries and different between
 * attempts; the timestamp makes collisions between two attempts by the same
 * customer impossible in practice, and the key is scoped per customer anyway.
 */
function newIdempotencyKey(): string {
  return `order-${String(Date.now())}-${Math.random().toString(36).slice(2, 12)}`;
}

interface DescribeStepProps {
  readonly description: string;
  readonly error: string | undefined;
  readonly photos: ReturnType<typeof useOrderPhotos>;
  readonly onChange: (value: string) => void;
}

function DescribeStep({
  description,
  error,
  photos,
  onChange,
}: DescribeStepProps): React.JSX.Element {
  return (
    <View className="gap-6">
      <View className="gap-2">
        <Text variant="h2">{copy.describeTitle}</Text>
        <Text variant="body" tone="muted">
          {copy.describeHint}
        </Text>
      </View>

      <DescriptionField description={description} error={error} onChange={onChange} />

      <View className="gap-3">
        <Text variant="body-strong">{copy.photosTitle}</Text>
        <Text variant="caption" tone="muted">
          {copy.photosHint}
        </Text>

        {photos.permissionDenied ? (
          <Banner tone="neutral" message={copy.photoPermissionDenied} />
        ) : null}
        {photos.photos.some((photo) => photo.status === 'failed') ? (
          <Banner tone="neutral" message={copy.photoFailed} />
        ) : null}

        <View className="flex-row flex-wrap gap-3">
          {photos.photos.map((photo) => (
            <View key={photo.localId} className="gap-1">
              <Image
                source={{ uri: photo.uri }}
                accessibilityIgnoresInvertColors
                className="size-20 rounded-md"
              />
              <Button
                label={copy.removePhoto}
                variant="ghost"
                size="sm"
                onPress={() => {
                  photos.remove(photo.localId);
                }}
              />
            </View>
          ))}
        </View>

        <Button
          label={photos.photos.length >= MAX_PHOTOS ? copy.photoLimitReached : copy.addPhoto}
          variant="secondary"
          loading={photos.isPicking}
          disabled={photos.photos.length >= MAX_PHOTOS || photos.isPicking}
          onPress={() => void photos.pick()}
        />
      </View>
    </View>
  );
}

interface DescriptionFieldProps {
  readonly description: string;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}

function DescriptionField({
  description,
  error,
  onChange,
}: DescriptionFieldProps): React.JSX.Element {
  // `TextField` is a single-line control by design; a problem description is a
  // paragraph, so the multiline props are set here rather than by inventing a
  // second field component the design system does not define.
  return (
    <TextField
      label={copy.descriptionLabel}
      placeholder={copy.descriptionPlaceholder}
      value={description}
      onChangeText={onChange}
      multiline
      numberOfLines={4}
      maxLength={MAX_DESCRIPTION}
      {...(error === undefined ? {} : { error })}
    />
  );
}

interface AddressStepProps {
  readonly addresses: readonly Address[] | undefined;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onRetry: () => void;
}

function AddressStep({
  addresses,
  isLoading,
  error,
  selectedId,
  onSelect,
  onRetry,
}: AddressStepProps): React.JSX.Element {
  if (isLoading) {
    return <Skeleton accessibilityLabel={copy.addressTitle} className="h-40 w-full" />;
  }

  if (addresses === undefined) {
    // A 404 means "you have none", not a failure — the same reading
    // `Addresses.tsx` takes, and for the same reason: the API answers 404 for
    // an absent customer profile too (#94).
    return statusOf(error) === 404 ? (
      <EmptyState title={copy.addressEmptyTitle} description={copy.addressEmptyDescription} />
    ) : (
      <EmptyState
        title={copy.addressLoadFailed}
        action={<Button label={copy.retry} onPress={onRetry} />}
      />
    );
  }

  if (addresses.length === 0) {
    return <EmptyState title={copy.addressEmptyTitle} description={copy.addressEmptyDescription} />;
  }

  return (
    <View className="gap-4">
      <View className="gap-2">
        <Text variant="h2">{copy.addressTitle}</Text>
        <Text variant="body" tone="muted">
          {copy.addressHint}
        </Text>
      </View>

      <View className="gap-3">
        {addresses.map((address) => {
          const detail = formatAddressDetail(address);
          return (
            <Button
              key={address.id}
              label={
                detail === '' ? address.formattedAddress : `${address.formattedAddress}, ${detail}`
              }
              variant={address.id === selectedId ? 'accent' : 'secondary'}
              fullWidth
              onPress={() => {
                onSelect(address.id);
              }}
            />
          );
        })}
      </View>
    </View>
  );
}

interface ConfirmStepProps {
  readonly service: Service | undefined;
  readonly address: Address | undefined;
  readonly description: string;
  readonly photoCount: number;
  readonly priceRange:
    | {
        readonly pricingKind: 'fixed';
        readonly range: { minMinor: number; maxMinor: number; currency: string } | null;
      }
    | { readonly pricingKind: 'inspection' }
    | undefined;
}

function ConfirmStep({
  service,
  address,
  description,
  photoCount,
  priceRange,
}: ConfirmStepProps): React.JSX.Element {
  return (
    <View className="gap-4">
      <Text variant="h2">{copy.confirmTitle}</Text>

      <Card className="gap-3 p-4">
        <Row label={copy.confirmService} value={service?.name ?? ''} />
        <Row label={copy.confirmAddress} value={address?.formattedAddress ?? ''} />
        <Row label={copy.confirmProblem} value={description} />
        {photoCount > 0 ? <Row label={copy.confirmPhotos} value={String(photoCount)} /> : null}
      </Card>

      <Card surface="alt" className="gap-2 p-4">
        <PriceEstimate priceRange={priceRange} />
      </Card>
    </View>
  );
}

function PriceEstimate({ priceRange }: Pick<ConfirmStepProps, 'priceRange'>): React.JSX.Element {
  if (priceRange === undefined) {
    return (
      <Text variant="body" tone="muted">
        {copy.priceUnknown}
      </Text>
    );
  }

  if (priceRange.pricingKind === 'inspection') {
    return (
      <>
        <Text variant="body-strong">{copy.priceInspection}</Text>
        <Text variant="caption" tone="muted">
          {copy.priceInspectionNote}
        </Text>
      </>
    );
  }

  if (priceRange.range === null) {
    return (
      <Text variant="body" tone="muted">
        {copy.priceUnknown}
      </Text>
    );
  }

  return (
    <>
      <Text variant="caption" tone="muted">
        {copy.priceEstimateLabel}
      </Text>
      <Text variant="body-strong">
        {formatMinor(priceRange.range.minMinor)} – {formatMinor(priceRange.range.maxMinor)}{' '}
        {priceRange.range.currency}
      </Text>
      <Text variant="caption" tone="muted">
        {copy.priceEstimateNote}
      </Text>
    </>
  );
}

/** Integer minor units to a displayed amount. `1500` is `15.00`. */
function formatMinor(minor: number): string {
  return (minor / 100).toFixed(2);
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <View className="gap-1">
      <Text variant="caption" tone="muted">
        {label}
      </Text>
      <Text variant="body">{value}</Text>
    </View>
  );
}
