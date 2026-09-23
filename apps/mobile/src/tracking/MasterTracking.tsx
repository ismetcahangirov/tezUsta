import type { OrderStatus } from '@tezusta/types';

import type { MapPoint } from './map-surface.types';
import { MasterTrackingCard } from './MasterTrackingCard';
import { useMasterTracking } from './useMasterTracking';

export interface MasterTrackingProps {
  readonly orderId: string;
  /** The status the order screen is already showing — the map never reads its own. */
  readonly status: OrderStatus;
  /** The order's own `masterId`, which is how a re-dispatch is noticed. */
  readonly masterId: string | null;
  readonly destination: MapPoint | null;
}

/**
 * The tracking card, wired to the cache (issue #172).
 *
 * Split from {@link MasterTrackingCard} so the card can be reviewed in
 * Storybook and tested state by state without a store, the way
 * `OrderStatusCard` is; this is the one line that decides which state it is
 * in.
 */
export function MasterTracking({
  orderId,
  status,
  masterId,
  destination,
}: MasterTrackingProps): React.JSX.Element | null {
  const view = useMasterTracking(orderId, status, masterId);
  return <MasterTrackingCard view={view} destination={destination} />;
}
