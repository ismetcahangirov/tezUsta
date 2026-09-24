import type {
  AdminCatalogue,
  AdminCatalogueCategory,
  AdminCatalogueService,
  ServicePricingKind,
} from '@tezusta/types';

import { adminApi } from '../../api/admin-api';

/** `{ az, en?, ru? }` — `az` is the fallback every reader relies on. */
export type LocalizedName = { readonly az: string } & Readonly<Record<string, string>>;

export interface CategoryCreate {
  readonly slug: string;
  readonly name: LocalizedName;
  readonly displayOrder?: number;
  readonly isActive?: boolean;
}

export type CategoryPatch = Partial<CategoryCreate>;

export interface ServiceCreate {
  readonly categoryId: string;
  readonly slug: string;
  readonly name: LocalizedName;
  readonly pricingKind: ServicePricingKind;
  readonly basePriceMinor?: number | null;
  readonly displayOrder?: number;
  readonly isActive?: boolean;
}

export type ServicePatch = Partial<ServiceCreate>;

/**
 * The catalogue editor's endpoints (issue #244's API, `catalogue.manage`).
 * Every write invalidates the one `Catalogue` tag, so the editor always shows
 * what the server now holds — order included — rather than a local guess.
 */
export const catalogueApi = adminApi
  .enhanceEndpoints({ addTagTypes: ['Catalogue'] })
  .injectEndpoints({
    endpoints: (build) => ({
      catalogue: build.query<AdminCatalogue, void>({
        query: () => '/admin/catalogue',
        providesTags: ['Catalogue'],
      }),
      createCategory: build.mutation<AdminCatalogueCategory, CategoryCreate>({
        query: (body) => ({ url: '/admin/catalogue/categories', method: 'POST', body }),
        invalidatesTags: ['Catalogue'],
      }),
      updateCategory: build.mutation<
        AdminCatalogueCategory,
        { readonly id: string; readonly patch: CategoryPatch }
      >({
        query: ({ id, patch }) => ({
          url: `/admin/catalogue/categories/${encodeURIComponent(id)}`,
          method: 'PATCH',
          body: patch,
        }),
        invalidatesTags: ['Catalogue'],
      }),
      reorderCategories: build.mutation<AdminCatalogue, readonly string[]>({
        query: (ids) => ({
          url: '/admin/catalogue/categories/order',
          method: 'PUT',
          body: { ids },
        }),
        invalidatesTags: ['Catalogue'],
      }),
      reorderServices: build.mutation<
        AdminCatalogue,
        { readonly categoryId: string; readonly ids: readonly string[] }
      >({
        query: ({ categoryId, ids }) => ({
          url: `/admin/catalogue/categories/${encodeURIComponent(categoryId)}/services/order`,
          method: 'PUT',
          body: { ids },
        }),
        invalidatesTags: ['Catalogue'],
      }),
      createService: build.mutation<AdminCatalogueService, ServiceCreate>({
        query: (body) => ({ url: '/admin/catalogue/services', method: 'POST', body }),
        invalidatesTags: ['Catalogue'],
      }),
      updateService: build.mutation<
        AdminCatalogueService,
        { readonly id: string; readonly patch: ServicePatch }
      >({
        query: ({ id, patch }) => ({
          url: `/admin/catalogue/services/${encodeURIComponent(id)}`,
          method: 'PATCH',
          body: patch,
        }),
        invalidatesTags: ['Catalogue'],
      }),
    }),
  });

export const {
  useCatalogueQuery,
  useCreateCategoryMutation,
  useUpdateCategoryMutation,
  useReorderCategoriesMutation,
  useReorderServicesMutation,
  useCreateServiceMutation,
  useUpdateServiceMutation,
} = catalogueApi;
