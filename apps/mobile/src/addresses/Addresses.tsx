import type { Address } from '@tezusta/types';
import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';

import { isTransportFailure } from '../api/base-query';
import { Banner, Button, EmptyState, IconButton, PlusIcon, Skeleton, Text } from '../components';
import { ADDRESSES_COPY as copy } from './addresses-copy';
import { AddressForm, type AddressFormValues } from './AddressForm';
import { AddressList } from './AddressList';
import { rawStatusOf, statusOf } from './addresses-errors';
import {
  useCreateAddressMutation,
  useDeleteAddressMutation,
  useListAddressesQuery,
  useUpdateAddressMutation,
  type CreateAddressBody,
} from './addresses-endpoints';

type FormState = { kind: 'closed' } | { kind: 'add' } | { kind: 'edit'; address: Address };

/** See `ServiceCatalogue.tsx`'s `isOffline` — the same shape check, unshared
 * because each feature owns its own request-state helpers rather than a
 * cross-feature import for four lines. */
function isOffline(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    isTransportFailure((error as { status?: unknown }).status)
  );
}

/**
 * `AddressFormValues` uses `null` for "not provided", matching `Address`'s
 * own nullable fields. `createAddressSchema` is not nullable for the same
 * fields — only optional — so absence has to be spelled by leaving the key
 * out entirely, not by sending `null` and letting Zod's `.strict()` reject
 * the request as an unknown-shaped value.
 */
function toCreateBody(values: AddressFormValues): CreateAddressBody {
  return {
    formattedAddress: values.formattedAddress,
    latitude: values.latitude,
    longitude: values.longitude,
    ...(values.label !== null ? { label: values.label } : {}),
    ...(values.building !== null ? { building: values.building } : {}),
    ...(values.entrance !== null ? { entrance: values.entrance } : {}),
    ...(values.floor !== null ? { floor: values.floor } : {}),
    ...(values.apartment !== null ? { apartment: values.apartment } : {}),
    ...(values.landmarkNote !== null ? { landmarkNote: values.landmarkNote } : {}),
  };
}

function messageForRowError(error: unknown, genericMessage: string): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  const status = statusOf(error);
  if (status === 404) {
    // Not the caller's, or already gone — never presented as an account
    // problem (issue #90; the API deliberately answers 404 here, not 403).
    return copy.notFoundError;
  }
  return isTransportFailure(rawStatusOf(error)) ? copy.offlineError : genericMessage;
}

/**
 * The customer's saved addresses: list, add, edit, delete, choose the
 * default (issue #90).
 *
 * Shaped like `ServiceCatalogue`: the four request states are read from
 * `currentData` / `isFetching` / `error` rather than inferred from their
 * absence, and the list itself (`AddressList`) is presentational and owns no
 * server state.
 *
 * **Delete and "set default" invalidate and re-render; they never patch the
 * cache with a guess.** Both can change *which* address is the default, and
 * only the server knows which one — `addresses-endpoints.ts` explains why in
 * full. That is also why `updateAddress` is called through two independent
 * mutation hooks here: one for the edit form, one for the row's "make
 * default" action, so a field-level validation error from editing never
 * bleeds into the plain "couldn't set default" banner a row action shows, and
 * the reverse.
 */
/**
 * The modal scrim.
 *
 * `overlay` is a token; **the opacity is not.** `docs/design/design-system.md`
 * §2 says only "scrims, at reduced opacity" and never fixes a number, so 60%
 * is this screen proposing one rather than reading one. It is named here, once,
 * so it is a single value the owner can change or promote into
 * `design-tokens.json` — not a literal buried in JSX that the next screen
 * copies at a slightly different strength.
 */
const SCRIM_CLASS = 'bg-overlay/60';

export function Addresses(): React.JSX.Element {
  const list = useListAddressesQuery();
  const [createAddress, createResult] = useCreateAddressMutation();
  const [updateAddress, updateResult] = useUpdateAddressMutation();
  const [promoteDefault, promoteResult] = useUpdateAddressMutation();
  const [deleteAddress, deleteResult] = useDeleteAddressMutation();

  const [form, setForm] = useState<FormState>({ kind: 'closed' });

  const items = list.currentData;

  const busyId =
    deleteResult.isLoading && deleteResult.originalArgs !== undefined
      ? deleteResult.originalArgs
      : promoteResult.isLoading && promoteResult.originalArgs !== undefined
        ? promoteResult.originalArgs.id
        : null;

  const rowBannerMessage =
    messageForRowError(deleteResult.error, copy.deleteError) ??
    messageForRowError(promoteResult.error, copy.saveError);

  /**
   * Clears every result the screen is still showing an error for.
   *
   * A failed row action has no sheet of its own to close, so without this a
   * customer who lost signal mid-delete is still being told deletion failed
   * after reconnecting and successfully adding an address. Clearing it here
   * and at the start of the next row action — rather than on the next
   * successful list read — is what keeps the banner visible long enough to be
   * read: a *failed* mutation still invalidates its tag, so the refetch lands
   * almost immediately and would otherwise wipe the message before anyone saw
   * it.
   */
  function clearRowActionErrors(): void {
    deleteResult.reset();
    promoteResult.reset();
  }

  function closeForm(): void {
    setForm({ kind: 'closed' });
    createResult.reset();
    updateResult.reset();
    clearRowActionErrors();
  }

  async function handleSubmit(values: AddressFormValues): Promise<void> {
    if (form.kind === 'add') {
      try {
        await createAddress(toCreateBody(values)).unwrap();
        closeForm();
      } catch {
        // createResult.error is what AddressForm renders next; the sheet
        // stays open so the customer does not lose what they typed.
      }
    } else if (form.kind === 'edit') {
      try {
        await updateAddress({ id: form.address.id, patch: values }).unwrap();
        closeForm();
      } catch {
        // Same as above, via updateResult.error.
      }
    }
  }

  return (
    <View className="flex-1">
      <View className="gap-6 p-6">
        <View className="flex-row items-center justify-between">
          <Text variant="h1">{copy.title}</Text>
          <IconButton
            accessibilityLabel={copy.addAction}
            icon={<PlusIcon tone="on-inverse" />}
            onPress={() => {
              setForm({ kind: 'add' });
            }}
          />
        </View>

        {rowBannerMessage !== undefined && <Banner tone="danger" message={rowBannerMessage} />}

        {/*
          A stale banner only where there is genuinely stale content to
          caption — a refresh failed with a previously loaded list still on
          screen, exactly the case `ServiceCatalogue` guards the same way.
        */}
        {list.error !== undefined && items !== undefined && (
          <Banner
            message={isOffline(list.error) ? copy.staleNotice : copy.errorTitle}
            action={
              <Button
                label={copy.retry}
                variant="ghost"
                size="sm"
                loading={list.isFetching}
                onPress={() => {
                  void list.refetch();
                }}
              />
            }
          />
        )}

        <AddressesBody
          items={items}
          isFetching={list.isFetching}
          error={list.error}
          busyId={busyId}
          onRetry={() => {
            void list.refetch();
          }}
          onAdd={() => {
            setForm({ kind: 'add' });
          }}
          onEdit={(address) => {
            setForm({ kind: 'edit', address });
          }}
          onDelete={(address) => {
            clearRowActionErrors();
            void deleteAddress(address.id);
          }}
          onSetDefault={(address) => {
            clearRowActionErrors();
            void promoteDefault({ id: address.id, patch: { isDefault: true } });
          }}
        />
      </View>

      <Modal
        visible={form.kind !== 'closed'}
        transparent
        animationType="slide"
        onRequestClose={closeForm}
      >
        {/*
          Nothing in the inventory hosts a bottom sheet yet — `Sheet` is
          presentation only by design (`components/Sheet.tsx`: "gesture
          handling and the backdrop belong to whatever presents it") and this
          is its first screen use. `Modal` plus a scrim `Pressable` is the
          mechanical minimum needed to show one at all: a bare platform
          primitive and the `overlay` token, not an invented backdrop.
        */}
        <View className="flex-1 justify-end">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.cancel}
            onPress={closeForm}
            className={`absolute inset-0 ${SCRIM_CLASS}`}
          />
          <View>
            {form.kind === 'add' && (
              <AddressForm
                mode="add"
                submitting={createResult.isLoading}
                error={createResult.error}
                onSubmit={(values) => {
                  void handleSubmit(values);
                }}
                onCancel={closeForm}
              />
            )}
            {form.kind === 'edit' && (
              <AddressForm
                mode="edit"
                initial={form.address}
                submitting={updateResult.isLoading}
                error={updateResult.error}
                onSubmit={(values) => {
                  void handleSubmit(values);
                }}
                onCancel={closeForm}
              />
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

interface AddressesBodyProps {
  items: readonly Address[] | undefined;
  isFetching: boolean;
  error: unknown;
  busyId: string | null;
  onRetry: () => void;
  onAdd: () => void;
  onEdit: (address: Address) => void;
  onDelete: (address: Address) => void;
  onSetDefault: (address: Address) => void;
}

/** Split out so the states read as a list, in the order they actually occur — same shape as `CatalogueBody`. */
function AddressesBody({
  items,
  isFetching,
  error,
  busyId,
  onRetry,
  onAdd,
  onEdit,
  onDelete,
  onSetDefault,
}: AddressesBodyProps): React.JSX.Element {
  if (items === undefined) {
    if (error === undefined) {
      return <AddressesSkeleton />;
    }

    /**
     * **A 404 here is not a failure.** The API answers 404 for "no addresses
     * you can see" and for "you have no customer profile yet" alike — the
     * same deliberate 404-not-403 that keeps `GET /addresses/:id` from
     * confirming a stranger's row exists. Rendering the generic error would
     * tell a brand-new customer to check an internet connection that is
     * working, and hand them a retry button that can never succeed.
     *
     * The empty state is the truthful answer to both: they have no addresses,
     * and adding one is what to do next.
     */
    if (statusOf(error) === 404) {
      return (
        <EmptyState
          title={copy.emptyTitle}
          description={copy.emptyDescription}
          action={<Button label={copy.addAction} variant="accent" onPress={onAdd} />}
        />
      );
    }

    return (
      <EmptyState
        title={copy.errorTitle}
        description={copy.errorDescription}
        action={<Button label={copy.retry} loading={isFetching} onPress={onRetry} />}
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        title={copy.emptyTitle}
        description={copy.emptyDescription}
        action={<Button label={copy.addAction} variant="accent" onPress={onAdd} />}
      />
    );
  }

  return (
    <AddressList
      addresses={items}
      busyId={busyId}
      onEdit={onEdit}
      onDelete={onDelete}
      onSetDefault={onSetDefault}
    />
  );
}

/** Three rows' worth of placeholder. `accessible` is load-bearing — see `CatalogueSkeleton`. */
function AddressesSkeleton(): React.JSX.Element {
  return (
    <View accessible accessibilityLabel={copy.loading} className="gap-6">
      {[0, 1, 2].map((row) => (
        <Skeleton key={row} className="h-control-lg w-full" />
      ))}
    </View>
  );
}
