import type { Service, ServiceCategory } from '@tezusta/types';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { isTransportFailure } from '../api/base-query';
import { Banner, Button, EmptyState, Skeleton, Text } from '../components';
import { deviceLocale } from '../lib/device-locale';
import { CategoryList } from './CategoryList';
import { SERVICE_CATALOGUE_COPY as copy } from './service-catalogue-copy';
import { useListServiceCategoriesQuery, useListServicesQuery } from './service-catalogue-endpoints';
import { ServiceList } from './ServiceList';

export interface ServiceCatalogueProps {
  /** What happens when a customer picks a service. Order creation is EPIC 6. */
  onSelectService?: (service: Service) => void;
}

/**
 * True when a request failed without reaching the server, which is what a
 * customer experiences as "offline".
 *
 * RTK Query's `error` is either a `FetchBaseQueryError` or a `SerializedError`
 * — only the first has a `status` — so the shape is checked, not cast.
 */
function isOffline(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    isTransportFailure(error.status)
  );
}

/**
 * Whichever request is on screen, narrowed to the four facts every branch
 * below needs.
 *
 * **`items` comes from `currentData`, never from `data`.** RTK Query's `data`
 * deliberately falls back to the *previous argument's* result while a new one
 * is in flight — that is what makes a list feel continuous on a refetch, and
 * it is exactly wrong here: opening "Electrical" while its request is in
 * flight would leave plumbing's services on screen under the heading
 * "Electrical", and, if that request then failed, would leave them there under
 * a banner asserting they are a saved copy of it. `currentData` is scoped to
 * the argument actually being displayed.
 *
 * `isFetching` rather than `isLoading` for the same family of reason:
 * `isLoading` is false whenever any previous result exists, so a retry after a
 * failure would show no sign of anything happening.
 */
interface CatalogueRequest {
  readonly items: readonly { id: string; displayOrder: number }[] | undefined;
  readonly isFetching: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * The catalogue screen's body: categories, then the services inside one.
 *
 * **The drill-down is local state, not a route.** Which screens exist and how
 * they are arranged is the owner's decision and is still open (CLAUDE.md §17,
 * `docs/design/design-system.md` §9 — "the navigation pattern"). Pushing a
 * second route would answer that question by accident. A `useState` inside one
 * screen is the smallest thing that works and the easiest to replace with a
 * route later — which is why the two lists are separate presentational
 * components rather than one component with a mode.
 *
 * It is also not Redux. The selected category is read by one component and
 * survives nothing; ADR-0017 puts *shared* client state in a slice.
 *
 * **Every state a request can be in has a branch**, and each branch is decided
 * by reading the state rather than by inferring it from the absence of data:
 * nothing has arrived and no error means "still loading", not "failed". Four
 * states — loading, empty, failed with nothing to show, and failed with
 * something stale to show. The last is the one usually missing, and the one
 * that matters on a mobile network.
 */
export function ServiceCatalogue({ onSelectService }: ServiceCatalogueProps): React.JSX.Element {
  const [category, setCategory] = useState<ServiceCategory | null>(null);
  const locale = deviceLocale();

  const categories = useListServiceCategoriesQuery({ locale });
  const services = useListServicesQuery(
    category === null ? { locale } : { locale, categoryId: category.id },
    { skip: category === null },
  );

  const active: CatalogueRequest =
    category === null
      ? {
          items: categories.currentData,
          isFetching: categories.isFetching,
          error: categories.error,
          refetch: () => void categories.refetch(),
        }
      : {
          items: services.currentData,
          isFetching: services.isFetching,
          error: services.error,
          refetch: () => void services.refetch(),
        };

  return (
    <ScrollView>
      <View className="gap-6 p-6">
        <View className="gap-2">
          <Text variant="h1">{category === null ? copy.title : category.name}</Text>
          {category !== null && (
            <Button
              label={copy.allCategories}
              variant="ghost"
              size="sm"
              className="self-start"
              onPress={() => {
                setCategory(null);
              }}
            />
          )}
        </View>

        {/*
          A stale banner only where there is genuinely stale content to caption:
          `items` is the CURRENT argument's data, so "showing a saved list" can
          no longer be said over rows belonging to a different category.
        */}
        {active.error !== undefined && active.items !== undefined && (
          <Banner
            message={isOffline(active.error) ? copy.staleNotice : copy.errorTitle}
            action={
              <Button
                label={copy.retry}
                variant="ghost"
                size="sm"
                loading={active.isFetching}
                onPress={active.refetch}
              />
            }
          />
        )}

        <CatalogueBody
          request={active}
          isCategoryList={category === null}
          categories={categories.currentData ?? []}
          services={services.currentData ?? []}
          onSelectCategory={setCategory}
          onSelectService={onSelectService}
        />
      </View>
    </ScrollView>
  );
}

/**
 * Split out so the states read as a list rather than as nested ternaries
 * inside the layout, in the order they actually occur.
 */
function CatalogueBody({
  request,
  isCategoryList,
  categories,
  services,
  onSelectCategory,
  onSelectService,
}: {
  request: CatalogueRequest;
  isCategoryList: boolean;
  categories: readonly ServiceCategory[];
  services: readonly Service[];
  onSelectCategory: (category: ServiceCategory) => void;
  onSelectService: ((service: Service) => void) | undefined;
}): React.JSX.Element {
  if (request.items === undefined) {
    /**
     * Nothing to show yet. An error here means the attempt is over; anything
     * else — in flight, or not yet started — is still loading. Reading `error`
     * rather than inferring failure from the absence of data is what stops a
     * cold mount from committing a tree that says "could not load" before
     * anything has been tried.
     */
    return request.error === undefined ? (
      <CatalogueSkeleton />
    ) : (
      <EmptyState
        title={copy.errorTitle}
        description={copy.errorDescription}
        action={
          <Button label={copy.retry} loading={request.isFetching} onPress={request.refetch} />
        }
      />
    );
  }

  if (request.items.length === 0) {
    return (
      <EmptyState
        title={isCategoryList ? copy.emptyTitle : copy.emptyCategoryTitle}
        {...(isCategoryList ? { description: copy.emptyDescription } : {})}
      />
    );
  }

  return isCategoryList ? (
    <CategoryList categories={categories} onSelect={onSelectCategory} />
  ) : (
    <ServiceList
      services={services}
      onSelect={(service) => {
        onSelectService?.(service);
      }}
    />
  );
}

/**
 * Four rows' worth of placeholder — roughly what fits above the fold. A
 * placeholder longer than the content it stands in for makes the arrival feel
 * like a collapse.
 *
 * `accessible` on the container is load-bearing, not decoration: without it
 * the group is not an accessibility element on iOS and the label is never
 * read, leaving a screen-reader user with four unnamed boxes.
 */
function CatalogueSkeleton(): React.JSX.Element {
  return (
    <View accessible accessibilityLabel={copy.loading} className="gap-6">
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-control-md w-full" />
      ))}
    </View>
  );
}
