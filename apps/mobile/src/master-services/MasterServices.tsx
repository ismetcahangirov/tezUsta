import type { MasterService, Service, ServiceCategory } from '@tezusta/types';
import { useEffect, useMemo, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, ScrollView, View } from 'react-native';

import {
  Banner,
  Button,
  Card,
  ChevronRightIcon,
  EmptyState,
  ListRow,
  Skeleton,
  Text,
  TextField,
} from '../components';
import { appLocale } from '../lib/app-locale';
import { formatOrderPrice } from '../orders/format-order-price';
import { parsePriceInput } from '../orders/parse-price-input';
import {
  useListServiceCategoriesQuery,
  useListServicesQuery,
} from '../service-catalogue/service-catalogue-endpoints';
import { MASTER_SERVICES_COPY as copy } from './master-services-copy';
import {
  useAddOwnServiceMutation,
  useOwnServicesQuery,
  useRemoveOwnServiceMutation,
  useUpdateOwnServiceMutation,
} from './master-services-endpoints';

const FILL = { flex: 1 } as const;

/** The screen's local steps: the list, then a catalogue pick and its price, or one service's edit. */
type Step =
  | { readonly kind: 'list' }
  | { readonly kind: 'pick' }
  | { readonly kind: 'add'; readonly serviceId: string }
  | { readonly kind: 'edit'; readonly serviceId: string };

export interface MasterServicesProps {
  readonly onBack: () => void;
}

/**
 * The services a master offers and what they charge for each
 * ([ADR-0063](../../../../docs/decisions/ADR-0063-master-services-screen.md)),
 * pushed from the Services card on their own profile.
 *
 * **One screen with local steps**, the way order creation is one screen
 * (ADR-0029): the list; "Xidmət əlavə et" opens the catalogue, grouped by
 * category, without the services already on the list; a pick asks for the
 * price, or says the service is priced at inspection; a row opens its edit —
 * the price, a pause, a removal. "Geri" and the hardware back step back
 * through them before they leave the screen.
 *
 * **Names and pricing shapes come from the catalogue**, never from the
 * master's rows, which carry only an id and a price. A service the catalogue
 * has since retired is still listed, under a name that says so, and can only
 * be removed.
 */
export function MasterServices({ onBack }: MasterServicesProps): React.JSX.Element {
  const locale = appLocale();
  const own = useOwnServicesQuery();
  const catalogue = useListServicesQuery({ locale });
  const categories = useListServiceCategoriesQuery({ locale });
  const [step, setStep] = useState<Step>({ kind: 'list' });

  const back = (): void => {
    if (step.kind === 'list') {
      onBack();
    } else {
      setStep(step.kind === 'add' ? { kind: 'pick' } : { kind: 'list' });
    }
  };

  // Android's back steps back too, until the list, where it leaves as usual.
  useEffect(() => {
    if (step.kind === 'list') {
      return undefined;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setStep(step.kind === 'add' ? { kind: 'pick' } : { kind: 'list' });
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [step.kind]);

  const byId = useMemo(
    () => new Map((catalogue.currentData ?? []).map((service) => [service.id, service])),
    [catalogue.currentData],
  );

  const offered = own.currentData;
  if (offered === undefined || catalogue.currentData === undefined) {
    const failed = own.isError || catalogue.isError;
    return (
      <Frame title={copy.title} onBack={onBack}>
        {failed ? (
          <EmptyState
            title={copy.errorTitle}
            action={
              <Button
                label={copy.retry}
                loading={own.isFetching || catalogue.isFetching}
                onPress={() => {
                  if (own.isError) void own.refetch();
                  if (catalogue.isError) void catalogue.refetch();
                }}
              />
            }
          />
        ) : (
          <View accessible accessibilityLabel={copy.loading} className="gap-4">
            <Skeleton className="h-control-lg w-full" />
            <Skeleton className="h-control-lg w-full" />
          </View>
        )}
      </Frame>
    );
  }

  const toList = (): void => {
    setStep({ kind: 'list' });
  };

  if (step.kind === 'pick') {
    const taken = new Set(offered.map((row) => row.serviceId));
    return (
      <Frame title={copy.add} onBack={back}>
        <CataloguePick
          services={catalogue.currentData.filter((service) => !taken.has(service.id))}
          categories={categories.currentData ?? []}
          onPick={(serviceId) => {
            setStep({ kind: 'add', serviceId });
          }}
        />
      </Frame>
    );
  }

  if (step.kind === 'add') {
    const service = byId.get(step.serviceId);
    return (
      <KeyboardAvoidingView behavior="padding" style={FILL}>
        <Frame title={service?.name ?? copy.retired} onBack={back}>
          {service !== undefined && <AddForm service={service} onDone={toList} />}
        </Frame>
      </KeyboardAvoidingView>
    );
  }

  if (step.kind === 'edit') {
    const row = offered.find((candidate) => candidate.serviceId === step.serviceId);
    const service = byId.get(step.serviceId);
    return (
      <KeyboardAvoidingView behavior="padding" style={FILL}>
        <Frame title={service?.name ?? copy.retired} onBack={back}>
          {row !== undefined && (
            // A fresh form per version of the row, so a saved price is the field's new start.
            <EditForm key={row.updatedAt} row={row} service={service} onDone={toList} />
          )}
        </Frame>
      </KeyboardAvoidingView>
    );
  }

  return (
    <Frame title={copy.title} onBack={back}>
      <ScrollView className="flex-1">
        <View className="gap-6 pb-10">
          {offered.length === 0 ? (
            <EmptyState
              title={copy.emptyTitle}
              description={copy.emptyDescription}
              action={
                <Button
                  label={copy.add}
                  onPress={() => {
                    setStep({ kind: 'pick' });
                  }}
                />
              }
            />
          ) : (
            <>
              <Card className="px-4">
                {offered.map((row) => {
                  const name = byId.get(row.serviceId)?.name ?? copy.retired;
                  const price = priceText(row.priceMinor);
                  return (
                    <ListRow
                      key={row.serviceId}
                      title={name}
                      {...(row.isActive ? {} : { subtitle: copy.paused })}
                      accessibilityLabel={`${name}, ${price}${row.isActive ? '' : `, ${copy.paused}`}`}
                      trailing={<Text variant="body-strong">{price}</Text>}
                      onPress={() => {
                        setStep({ kind: 'edit', serviceId: row.serviceId });
                      }}
                    />
                  );
                })}
              </Card>
              <Button
                label={copy.add}
                fullWidth
                onPress={() => {
                  setStep({ kind: 'pick' });
                }}
              />
            </>
          )}
        </View>
      </ScrollView>
    </Frame>
  );
}

function Frame({
  title,
  onBack,
  children,
}: {
  readonly title: string;
  readonly onBack: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View className="flex-1 gap-4 px-6 pt-6">
      <View className="flex-row items-center justify-between gap-4">
        <Text variant="h1" accessibilityRole="header" numberOfLines={2} className="flex-1">
          {title}
        </Text>
        <Button label={copy.back} variant="ghost" size="sm" onPress={onBack} />
      </View>
      {children}
    </View>
  );
}

/**
 * The catalogue services not yet on the list, under their categories' names in
 * the catalogue's order. A service whose category the app could not read is
 * still offered, after the rest, rather than hidden.
 */
function CataloguePick({
  services,
  categories,
  onPick,
}: {
  readonly services: readonly Service[];
  readonly categories: readonly ServiceCategory[];
  readonly onPick: (serviceId: string) => void;
}): React.JSX.Element {
  if (services.length === 0) {
    return <EmptyState title={copy.allAdded} />;
  }

  const known = new Set(categories.map((category) => category.id));
  const groups: { key: string; title: string | null; services: readonly Service[] }[] = [
    ...categories.map((category) => ({
      key: category.id,
      title: category.name,
      services: services.filter((service) => service.categoryId === category.id),
    })),
    {
      key: 'other',
      title: null,
      services: services.filter((service) => !known.has(service.categoryId)),
    },
  ].filter((group) => group.services.length > 0);

  return (
    <ScrollView className="flex-1">
      <View className="gap-6 pb-10">
        {groups.map((group) => (
          <View key={group.key} className="gap-2">
            {group.title !== null && <Text variant="h2">{group.title}</Text>}
            <Card className="px-4">
              {group.services.map((service) => (
                <ListRow
                  key={service.id}
                  title={service.name}
                  trailing={<ChevronRightIcon tone="text-muted" />}
                  onPress={() => {
                    onPick(service.id);
                  }}
                />
              ))}
            </Card>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

/** The price for a picked service, or the word that it has none in advance. */
function AddForm({
  service,
  onDone,
}: {
  readonly service: Service;
  readonly onDone: () => void;
}): React.JSX.Element {
  const [add, result] = useAddOwnServiceMutation();
  const fixed = service.pricing.kind === 'fixed';

  return (
    <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
      <View className="gap-6 pb-10">
        {result.isError && <Banner tone="danger" message={copy.failed} />}
        {fixed ? (
          <PriceForm
            initial=""
            submitLabel={copy.confirmAdd}
            submitting={result.isLoading}
            onSubmit={(priceMinor) => {
              void add({ serviceId: service.id, priceMinor })
                .unwrap()
                .then(onDone)
                .catch(() => undefined);
            }}
          />
        ) : (
          <>
            <Text tone="muted">{copy.inspectionHint}</Text>
            <Button
              label={copy.confirmAdd}
              fullWidth
              loading={result.isLoading}
              onPress={() => {
                void add({ serviceId: service.id })
                  .unwrap()
                  .then(onDone)
                  .catch(() => undefined);
              }}
            />
          </>
        )}
      </View>
    </ScrollView>
  );
}

/**
 * One offered service: its price (a fixed-price service only), a pause or a
 * resume, and a removal. A retired service can only be removed: the server
 * refuses any other change to it.
 */
function EditForm({
  row,
  service,
  onDone,
}: {
  readonly row: MasterService;
  readonly service: Service | undefined;
  readonly onDone: () => void;
}): React.JSX.Element {
  const [update, updateResult] = useUpdateOwnServiceMutation();
  const [remove, removeResult] = useRemoveOwnServiceMutation();
  const busy = updateResult.isLoading || removeResult.isLoading;
  const failed = updateResult.isError || removeResult.isError;

  const done = (pending: Promise<unknown>): void => {
    void pending.then(onDone).catch(() => undefined);
  };

  return (
    <ScrollView className="flex-1" keyboardShouldPersistTaps="handled">
      <View className="gap-6 pb-10">
        {failed && <Banner tone="danger" message={copy.failed} />}
        {service?.pricing.kind === 'fixed' && (
          <PriceForm
            initial={row.priceMinor === null ? '' : priceInputText(row.priceMinor)}
            submitLabel={copy.save}
            submitting={updateResult.isLoading}
            disabled={busy}
            onSubmit={(priceMinor) => {
              done(update({ serviceId: row.serviceId, priceMinor }).unwrap());
            }}
          />
        )}
        {service?.pricing.kind === 'inspection' && <Text tone="muted">{copy.inspectionHint}</Text>}
        <View className="gap-3">
          {service !== undefined && (
            <Button
              label={row.isActive ? copy.pause : copy.resume}
              variant="secondary"
              fullWidth
              disabled={busy}
              onPress={() => {
                done(update({ serviceId: row.serviceId, isActive: !row.isActive }).unwrap());
              }}
            />
          )}
          <Button
            label={copy.remove}
            variant="danger"
            fullWidth
            loading={removeResult.isLoading}
            disabled={busy}
            onPress={() => {
              done(remove(row.serviceId).unwrap());
            }}
          />
        </View>
      </View>
    </ScrollView>
  );
}

/** The price field and its button. A press with no valid price says so rather than sending it. */
function PriceForm({
  initial,
  submitLabel,
  submitting,
  disabled = false,
  onSubmit,
}: {
  readonly initial: string;
  readonly submitLabel: string;
  readonly submitting: boolean;
  readonly disabled?: boolean;
  readonly onSubmit: (priceMinor: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(initial);
  const [touched, setTouched] = useState(false);
  const amountMinor = parsePriceInput(text);

  return (
    <View className="gap-3">
      <TextField
        label={copy.priceLabel}
        value={text}
        onChangeText={setText}
        keyboardType="decimal-pad"
        maxLength={10}
        editable={!submitting}
        {...(touched && amountMinor === null ? { error: copy.priceInvalid } : {})}
      />
      <Button
        label={submitLabel}
        fullWidth
        loading={submitting}
        disabled={disabled && !submitting}
        onPress={() => {
          setTouched(true);
          if (amountMinor !== null) {
            onSubmit(amountMinor);
          }
        }}
      />
    </View>
  );
}

function priceText(priceMinor: number | null): string {
  return priceMinor === null ? copy.priceAfterInspection : formatOrderPrice(priceMinor);
}

/** A stored price as the field shows it: "45", or "45,50" — the comma an Azerbaijani keyboard offers. */
function priceInputText(priceMinor: number): string {
  const manats = Math.floor(priceMinor / 100);
  const qepik = priceMinor % 100;
  return qepik === 0 ? String(manats) : `${String(manats)},${String(qepik).padStart(2, '0')}`;
}
