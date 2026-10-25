import type { MasterService } from '@tezusta/types';

import { api } from '../api/api-slice';

export interface AddOwnServiceArg {
  readonly serviceId: string;
  /** Required for a fixed-price service, absent for an inspection-priced one. */
  readonly priceMinor?: number;
}

export interface UpdateOwnServiceArg {
  readonly serviceId: string;
  readonly priceMinor?: number;
  readonly isActive?: boolean;
}

/**
 * What a change to the master's services redraws besides their list: the
 * Services card on their profile, which is the public profile the customer
 * reads (ADR-0054 § 3).
 */
const CHANGED_TAGS = ['MasterService', { type: 'MasterProfile' as const }] as const;

/**
 * The services the master offers, with their own prices (ADR-0063). Every
 * route is the caller's own: no master id is ever sent.
 *
 * **The server decides whether a price belongs.** A fixed-price service needs
 * one and an inspection-priced service refuses one (`PriceShapeMismatchError`,
 * 422); the screen draws the field from the catalogue's pricing shape so the
 * refusal is only ever the catalogue having changed underneath it.
 */
export const masterServicesApi = api.injectEndpoints({
  endpoints: (build) => ({
    /** `GET /masters/me/services`: every service the master offers, paused ones included. */
    ownServices: build.query<readonly MasterService[], void>({
      query: () => '/masters/me/services',
      providesTags: ['MasterService'],
    }),

    addOwnService: build.mutation<MasterService, AddOwnServiceArg>({
      query: (body) => ({ url: '/masters/me/services', method: 'POST', body }),
      invalidatesTags: CHANGED_TAGS,
    }),

    updateOwnService: build.mutation<MasterService, UpdateOwnServiceArg>({
      query: ({ serviceId, ...body }) => ({
        url: `/masters/me/services/${serviceId}`,
        method: 'PATCH',
        body,
      }),
      invalidatesTags: CHANGED_TAGS,
    }),

    removeOwnService: build.mutation<void, string>({
      query: (serviceId) => ({ url: `/masters/me/services/${serviceId}`, method: 'DELETE' }),
      invalidatesTags: CHANGED_TAGS,
    }),
  }),
});

export const {
  useOwnServicesQuery,
  useAddOwnServiceMutation,
  useUpdateOwnServiceMutation,
  useRemoveOwnServiceMutation,
} = masterServicesApi;
