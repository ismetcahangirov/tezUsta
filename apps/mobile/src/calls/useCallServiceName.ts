import { skipToken } from '@reduxjs/toolkit/query';
import type { CallPartyKind } from '@tezusta/types';

import { deviceLocale } from '../lib/device-locale';
import { useCurrentJobQuery } from '../master-jobs/master-jobs-endpoints';
import { useOrderQuery } from '../orders/order-endpoints';
import { useGetServiceQuery } from '../service-catalogue/service-catalogue-endpoints';

/**
 * The name of the service a call's order is for, or null until it is known.
 *
 * **Read from what the two sides already read**, so it is almost never a
 * request of its own: the customer's order screen holds the order, the master's
 * job screen holds the job, and the catalogue entry is cached by both. A
 * customer reads `GET /orders/:id`; a master cannot — that route is the
 * customer's — and reads the one job they hold instead, which is the only order
 * a master can be on a call about.
 *
 * `viewer` is this phone's side of the order, not the other party's.
 */
export function useCallServiceName(orderId: string, viewer: CallPartyKind): string | null {
  const order = useOrderQuery(viewer === 'customer' ? orderId : skipToken);
  const job = useCurrentJobQuery(viewer === 'master' ? undefined : skipToken);

  const heldJob = job.currentData?.job;
  const serviceId =
    viewer === 'customer'
      ? order.currentData?.serviceId
      : heldJob?.orderId === orderId
        ? heldJob.serviceId
        : undefined;

  const service = useGetServiceQuery(
    serviceId === undefined ? skipToken : { id: serviceId, locale: deviceLocale() },
  );
  return service.currentData?.name ?? null;
}
