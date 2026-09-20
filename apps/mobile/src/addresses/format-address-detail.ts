import type { Address } from '@tezusta/types';

import { ADDRESSES_COPY as copy } from './addresses-copy';

/**
 * Folds the Baku addressing detail — building, entrance, floor, apartment,
 * landmark note — into one line for a list row.
 *
 * Order follows how a master actually reads their way to a door: the building
 * first, then narrowing inward through the entrance and floor to the
 * apartment, with the landmark note last because it is the one field that is
 * not a coordinate within the building at all.
 *
 * A field is omitted rather than rendered empty — `Address` makes every one of
 * these nullable exactly because a customer who knows only the street is still
 * better served by a saved address than by nothing (`packages/types/src/address.ts`).
 */
export function formatAddressDetail(
  address: Pick<Address, 'building' | 'entrance' | 'floor' | 'apartment' | 'landmarkNote'>,
): string {
  const parts: string[] = [];
  if (address.building !== null) {
    parts.push(`${copy.buildingPrefix} ${address.building}`);
  }
  if (address.entrance !== null) {
    parts.push(`${copy.entrancePrefix} ${address.entrance}`);
  }
  if (address.floor !== null) {
    parts.push(`${copy.floorPrefix} ${address.floor}`);
  }
  if (address.apartment !== null) {
    parts.push(`${copy.apartmentPrefix} ${address.apartment}`);
  }
  if (address.landmarkNote !== null) {
    parts.push(address.landmarkNote);
  }
  return parts.join(copy.detailSeparator);
}
