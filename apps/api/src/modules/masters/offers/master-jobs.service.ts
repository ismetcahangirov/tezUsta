import { Injectable } from '@nestjs/common';
import type { Address, CurrentMasterJob, MasterJob, PartyRating } from '@tezusta/types';

import { NotFoundError } from '../../../common/errors/not-found.error';
import { toPartyRating } from '../../../common/rating/party-rating';
import type { OrderRow } from '../../../infra/database/schema/orders';
import { AddressesService } from '../../addresses/addresses.service';
import type { Actor } from '../../auth/auth.types';
import { MastersService } from '../masters.service';
import { MasterOffersRepository } from './master-offers.repository';

/**
 * The job a master is on right now (issue #198).
 *
 * **A service of its own rather than a method on `MasterOffersService`, and
 * the reason is a test.** `MasterOffersService` injects `NearbyMastersService`
 * for the accept path's eligibility re-check, and
 * `nearby-masters.integration.test.ts` allows exactly one controller to reach
 * that query — because a route over it is a route over every master's
 * position. A read that needs only the offer table and an address has no
 * business inheriting that reach, so it does not.
 */
@Injectable()
export class MasterJobsService {
  constructor(
    private readonly offers: MasterOffersRepository,
    private readonly masters: MastersService,
    private readonly addresses: AddressesService,
  ) {}

  /**
   * The engaged order, or `null`.
   *
   * **Resolved from `orders.master_id` on every call**, never from the offer
   * row and never from anything the app remembers: a re-dispatch, a customer
   * cancellation and a completion each take the job — and the customer's
   * address with it — away on the very next read. The same two-fact rule
   * `MasterOffersService#getAddress` applies, reached from the order's side.
   *
   * `null` is an answer, not a 404: an online master with no job is the
   * ordinary case, and the app reads this on mount, on every socket reconnect
   * and on every transition event for its own order.
   */
  async current(actor: Actor): Promise<CurrentMasterJob> {
    const master = await this.masters.getOwn(actor);
    const engaged = await this.offers.findEngagedJob(master.id);

    if (engaged === undefined) {
      return { job: null };
    }

    const address = await this.addresses.findForOrderDispatch(engaged.order.addressId);
    if (address === undefined) {
      // Held by a `restrict` foreign key and only ever soft-deleted, so not
      // reachable — thrown rather than defaulted, for
      // `MasterOffersService#requireOrderAddress`'s reason.
      throw new NotFoundError();
    }

    return {
      job: toMasterJob(
        engaged.offerId,
        engaged.order,
        address,
        toPartyRating(engaged.customerRatingSum, engaged.customerRatingCount),
      ),
    };
  }
}

/**
 * The engaged order, as the master doing it may see it.
 *
 * An explicit field list, for `toOfferCard`'s reason: `customerId`,
 * `addressId`, `redispatchCount` and every column added to `orders` later stay
 * off a master's phone unless somebody adds them here on purpose.
 */
function toMasterJob(
  offerId: string,
  order: OrderRow,
  address: Address,
  customerRating: PartyRating,
): MasterJob {
  if (order.acceptedAt === null) {
    // `orders_accepted_at_requires_master` makes an engaged order without an
    // accept time unrepresentable; thrown for `toAcceptedOffer`'s reason.
    throw new Error('The engaged order carries no accepted_at.');
  }

  return {
    orderId: order.id,
    offerId,
    status: order.status,
    serviceId: order.serviceId,
    description: order.description,
    priceMinor: order.priceMinor,
    acceptedAt: order.acceptedAt.toISOString(),
    address,
    customerRating,
  };
}
