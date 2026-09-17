import type { Service, ServiceCategory } from '@tezusta/types';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { isTransportFailure } from '../api/base-query';
import { Banner, Button, EmptyState, Skeleton, Text } from '../components';
import { CategoryList } from './CategoryList';
import { SERVICE_CATALOGUE_COPY as copy } from './service-catalogue-copy';
import { useListServiceCategoriesQuery, useListServicesQuery } from './service-catalogue-endpoints';
import { ServiceList } from './ServiceList';

export interface ServiceCatalogueProps {
  /** What happens when a customer picks a service. Order creation is EPIC 6. */
  onSelectService?: (service: Service) => void;
}

/**
 * True when a request failed without reaching the server, which is what the
 * customer experiences as "offline".
 *
 * RTK Query's `error` is either a `FetchBaseQueryError` or a `SerializedError`
 * — only the first has a `status` — so the shape is checked rather than cast.
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
 * What every branch below needs to know about whichever request is on screen,
 * with the two differently-typed results narrowed to the parts they share.
 */
interface CatalogueRequest {
  readonly itemCount: number | undefined;
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly refetch: () => void;
}

/**
 * The catalogue screen's body: categories, then the services inside one.
 *
 * **The drill-down is local state, not a route.** Which screens exist and how
 * they are arranged is the owner's decision and is still open (CLAUDE.md §17,
 * `docs/design/design-system.md` §9 — "the navigation pattern"). Pushing a
 * second route here would answer that question by accident. A `useState`
 * inside one screen is the smallest thing that works and the easiest to
 * replace with a route once the pattern is decided — which is why the two
 * lists are separate presentational components rather than one component with
 * a mode.
 *
 * It is also not Redux. The selected category is read by one component and
 * survives nothing; ADR-0017 puts *shared* client state in a slice, and this is
 * neither shared nor wanted by anybody else.
 *
 * **Every state a request can be in has a branch**: first load, empty, failed
 * with nothing to show, and failed with something stale to show. The last is
 * the one that is easy to omit and the one that matters on a mobile network —
 * RTK Query keeps the previous result while a refetch fails, so the customer
 * keeps a usable list and is told it may be out of date, rather than watching a
 * working screen turn into an error page.
 */
export function ServiceCatalogue({ onSelectService }: ServiceCatalogueProps): React.JSX.Element {
  const [category, setCategory] = useState<ServiceCategory | null>(null);

  const categories = useListServiceCategoriesQuery();
  const services = useListServicesQuery(category === null ? {} : { categoryId: category.id }, {
    skip: category === null,
  });

  const active: CatalogueRequest =
    category === null
      ? {
          itemCount: categories.data?.items.length,
          isLoading: categories.isLoading,
          error: categories.error,
          refetch: () => void categories.refetch(),
        }
      : {
          itemCount: services.data?.items.length,
          isLoading: services.isLoading,
          error: services.error,
          refetch: () => void services.refetch(),
        };

  const showsStaleContent = active.error !== undefined && active.itemCount !== undefined;

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

        {showsStaleContent && (
          <Banner
            message={isOffline(active.error) ? copy.staleNotice : copy.errorTitle}
            action={
              <Button label={copy.retry} variant="ghost" size="sm" onPress={active.refetch} />
            }
          />
        )}

        {active.isLoading ? (
          <CatalogueSkeleton />
        ) : active.itemCount === undefined ? (
          <EmptyState
            title={copy.errorTitle}
            description={copy.errorDescription}
            action={<Button label={copy.retry} onPress={active.refetch} />}
          />
        ) : active.itemCount === 0 ? (
          <EmptyState
            title={category === null ? copy.emptyTitle : copy.emptyCategoryTitle}
            {...(category === null ? { description: copy.emptyDescription } : {})}
          />
        ) : category === null ? (
          <CategoryList categories={categories.data?.items ?? []} onSelect={setCategory} />
        ) : (
          <ServiceList
            services={services.data?.items ?? []}
            onSelect={(service) => {
              onSelectService?.(service);
            }}
          />
        )}
      </View>
    </ScrollView>
  );
}

/**
 * Four rows' worth of placeholder — roughly what fits above the fold. A
 * placeholder longer than the content it stands in for makes the arrival feel
 * like a collapse.
 */
function CatalogueSkeleton(): React.JSX.Element {
  return (
    <View className="gap-6" accessibilityLabel={copy.loading}>
      {[0, 1, 2, 3].map((row) => (
        <Skeleton key={row} className="h-control-md w-full" />
      ))}
    </View>
  );
}
