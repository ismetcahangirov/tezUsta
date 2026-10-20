import type { OrderStatus } from '@tezusta/types';
import { skipToken } from '@reduxjs/toolkit/query';

import { selectConnectionStatus } from '../realtime/connection-slice';
import { useAppSelector } from '../store/hooks';
import type { MapPoint } from '../tracking/map-surface.types';
import { useOrderSearchQuery } from './order-search-endpoints';
import { SearchRadarCard } from './SearchRadarCard';
import { deriveRadarView, radarFailureOf } from './search-radar-policy';

export interface SearchRadarProps {
  readonly orderId: string;
  /** This screen's own order status: the radar exists only while it is `SEARCHING`. */
  readonly status: OrderStatus;
  readonly destination: MapPoint | null;
}

/**
 * The search radar wired to the cache (issue #398), as `MasterTracking`
 * wires the tracking card.
 *
 * **Subscribed only while searching.** Outside `SEARCHING` the query is
 * skipped, and `keepUnusedDataFor: 0` drops the cells the moment the order
 * moves on — an accept, a give-up, a cancellation.
 */
export function SearchRadar({
  orderId,
  status,
  destination,
}: SearchRadarProps): React.JSX.Element | null {
  const searching = status === 'SEARCHING';
  const { data, error } = useOrderSearchQuery(searching ? orderId : skipToken);
  const connection = useAppSelector(selectConnectionStatus);

  const view = deriveRadarView({
    status,
    progress: data ?? null,
    failure: radarFailureOf(error),
    connection,
  });

  return <SearchRadarCard view={view} centre={destination} />;
}
