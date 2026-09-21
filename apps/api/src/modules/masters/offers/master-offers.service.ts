import { Injectable } from '@nestjs/common';
import type {
  AcceptedOffer,
  Address,
  DeclinedOffer,
  MasterOffer,
  OfferPhoto,
} from '@tezusta/types';

import { AppError } from '../../../common/errors/app-error';
import { ERROR_CODES } from '../../../common/errors/error-codes.types';
import { NotFoundError } from '../../../common/errors/not-found.error';
import type { OrderOfferRow } from '../../../infra/database/schema/order-offers';
import type { OrderRow } from '../../../infra/database/schema/orders';
import { AddressesService } from '../../addresses/addresses.service';
import type { Actor } from '../../auth/auth.types';
import { OrderDispatchRegistry } from '../../orders/order-dispatch.registry';
import { OrderNotificationsRegistry } from '../../orders/order-notifications.registry';
import { assertOrderTransition } from '../../orders/order-lifecycle';
import { OrderPhotosService } from '../../orders/order-photos.service';
import { OrdersRepository } from '../../orders/orders.repository';
import { MastersService } from '../masters.service';
import { NearbyMastersService } from '../nearby-masters.service';
import { distanceBand } from './distance-band';
import type { LiveOfferRow } from './master-offers.repository';
import { MasterOffersRepository } from './master-offers.repository';

/**
 * How many live offers one feed read returns.
 *
 * Not a configuration knob, because it is not a policy: ADR-0009 broadcasts to
 * the nearest `DISPATCH_MAX_MASTERS_PER_BROADCAST` masters per wave and an
 * unactioned offer expires, so a master with more than a few dozen live offers
 * at once is a symptom rather than a use case. What this bounds is the work one
 * request can ask for — each row mints a presigned URL per attached photo — and
 * a bound that cannot be raised from the environment is a bound that cannot be
 * raised by accident.
 */
const MAX_FEED_OFFERS = 50;

/**
 * Somebody else won the race, or the order stopped being claimable
 * ([ADR-0009](docs/decisions/ADR-0009-dispatch-model.md)).
 *
 * **This is the expected outcome, not an exceptional one.** On a parallel
 * broadcast most masters who tap accept lose, and ADR-0009 accepts that as the
 * price of filling fast. What it does not accept is a loser who cannot tell
 * what happened: "a stale offer that fails on tap is a support ticket", which
 * is why this carries its own code and a sentence a master can act on rather
 * than a bare 409 or — the failure this issue exists to prevent — a 500.
 *
 * 409: the request was well-formed and the caller is who they say they are; it
 * is the state of the world that makes the answer no.
 */
export class OrderAlreadyTakenError extends AppError {
  constructor() {
    super(
      ERROR_CODES.ORDER_ALREADY_TAKEN,
      'Another master has already taken this job.',
      409,
      // Nothing about who took it. The winner's identity is not this master's
      // business, and on a broadcast that reached twenty masters it would be
      // a name handed to nineteen strangers.
    );
    this.name = 'OrderAlreadyTakenError';
    Object.setPrototypeOf(this, OrderAlreadyTakenError.prototype);
  }
}

/**
 * The master's own offer row has already moved on — it expired, or they
 * declined it, or a sweep relabelled it.
 *
 * Distinct from {@link OrderAlreadyTakenError} because the two are different
 * screens: one says the job is gone, the other says this master's chance at it
 * is. `details.status` is the offer's own status, which is a fact about the
 * caller's own row and discloses nothing.
 */
export class OfferNoLongerActionableError extends AppError {
  constructor(status: string) {
    super(ERROR_CODES.OFFER_NO_LONGER_ACTIONABLE, 'This offer is no longer open.', 409, { status });
    this.name = 'OfferNoLongerActionableError';
    Object.setPrototypeOf(this, OfferNoLongerActionableError.prototype);
  }
}

/**
 * The master no longer satisfies the dispatch predicate — offline, out of
 * range, or past the commission-debt ceiling.
 *
 * Deliberately **one** error for the three, with no `details` saying which.
 * `MasterNotEligibleError` can name a verification status because that is the
 * master's own account state, shown to them on their own profile screen. These
 * three are not equivalent: "you are outside the radius" is a statement about
 * where the *customer* is, and an app that learned it by moving and retrying
 * would have a boundary-search oracle for a home address. The honest, safe
 * sentence is that this master cannot take this job right now.
 */
export class MasterNotEligibleForOfferError extends AppError {
  constructor() {
    super(
      ERROR_CODES.MASTER_NOT_ELIGIBLE_FOR_OFFER,
      'You cannot take this job right now. Check that you are online and still nearby.',
      409,
    );
    this.name = 'MasterNotEligibleForOfferError';
    Object.setPrototypeOf(this, MasterNotEligibleForOfferError.prototype);
  }
}

/**
 * `orders_one_active_per_master` — the partial unique index over the four
 * active statuses — refusing a second live job.
 *
 * The index is the enforcement, and this is the translation. Without it the
 * master sees a 500 built from a constraint violation, which tells them
 * nothing and tells an operator that something broke when nothing did: the
 * database correctly refused a thing the product forbids.
 */
export class MasterHasActiveOrderError extends AppError {
  constructor() {
    super(
      ERROR_CODES.MASTER_HAS_ACTIVE_ORDER,
      'You are already on a job. Finish or cancel it before taking another.',
      409,
    );
    this.name = 'MasterHasActiveOrderError';
    Object.setPrototypeOf(this, MasterHasActiveOrderError.prototype);
  }
}

/**
 * The master's side of dispatch (issue #101): the offer feed, decline, and
 * accept.
 *
 * **Nothing here takes a master id.** The responding master is resolved from
 * the actor, so there is no request shape in which a caller names somebody
 * else — the rule every `/masters/me/...` surface in this module follows.
 *
 * **Nothing here writes offers.** Creating them, widening the radius and
 * expiring them belong to the dispatch engine; this file only moves a row a
 * master responded to.
 *
 * The three rules this class exists to keep, in the order they are easiest to
 * lose:
 *
 * 1. **The offer card carries no address, no customer name and no phone
 *    number.** A broadcast reaches every eligible master in range, so anything
 *    on the card is handed to everyone who never takes the job (CLAUDE.md §11,
 *    `docs/product/master-flow.md`). The exact address is revealed to the
 *    winner, at accept, and to nobody else.
 * 2. **Eligibility is re-evaluated at the instant of the accept.** An offer
 *    sent three minutes ago is not authorization: a master who was suspended,
 *    went offline, drove out of range or passed the debt ceiling in between is
 *    refused.
 * 3. **The race is decided by one conditional `UPDATE`, and the transition
 *    table is consulted as well.** They answer different questions — the
 *    `WHERE` decides who wins, the table decides whether the edge is legal at
 *    all — and skipping either because the other exists is how this gets
 *    subtly wrong.
 */
@Injectable()
export class MasterOffersService {
  constructor(
    private readonly offers: MasterOffersRepository,
    private readonly masters: MastersService,
    private readonly nearby: NearbyMastersService,
    private readonly orders: OrdersRepository,
    private readonly photos: OrderPhotosService,
    private readonly addresses: AddressesService,
    /**
     * The slot the dispatch engine fills at boot, and the only thing this
     * module knows about dispatch (issue #120).
     *
     * `OrdersModule` offers it and this module already imports `OrdersModule`,
     * so telling the engine an order has stopped searching costs no new module
     * edge — importing `DispatchModule` here would add one into a module that
     * already depends on orders, and `no-circular` is not the only reason not
     * to (CLAUDE.md §14).
     */
    private readonly dispatch: OrderDispatchRegistry,
    private readonly orderNotifications: OrderNotificationsRegistry,
  ) {}

  /**
   * The caller's own live offers, newest first.
   *
   * The photos are fetched through the existing order-photo read path
   * (`OrderPhotosService.presignAttachedForOffers`) rather than a second one,
   * and they are the only thing on this card that touches the order's own
   * records at all. Everything else comes from the offer row and the order's
   * description.
   *
   * **Two queries for the whole feed, not one per card** (CLAUDE.md §12).
   * This endpoint is polled continuously by every online master until EPIC 9's
   * realtime channel replaces the polling, and a photo query per offer made it
   * up to `MAX_FEED_OFFERS + 1` round trips per read. The photos come back in
   * one batched statement, and orders whose `photo_count` is still zero are
   * left out of even that — the common case, since an order with no photos can
   * never have had one attached.
   */
  async listOwn(actor: Actor): Promise<MasterOffer[]> {
    const master = await this.masters.getOwn(actor);
    const rows = await this.offers.listLiveForMaster(master.id, MAX_FEED_OFFERS);

    const photosByOrder = await this.photos.presignAttachedForOffers(
      rows.filter((row) => row.photoCount > 0).map((row) => row.orderId),
    );

    return rows.map((row) => toOfferCard(row, photosByOrder.get(row.orderId) ?? []));
  }

  /**
   * Declines one offer — permanently (ADR-0009).
   *
   * "That master is never offered this order again, in any later round or
   * re-dispatch" is not enforced by anything here: it is enforced by the row
   * staying at `declined` and by `order_offers_order_master_unique` making a
   * second row for the pair impossible, so every later round that re-offers by
   * updating `offered` rows passes this one by without having to know it
   * exists.
   *
   * Declining something already expired, declined or lost is a clear 409 with
   * the offer's own status in `details`, never a 500 — the second time a
   * master taps "no thanks" on a flaky connection must not look like a broken
   * server.
   */
  async decline(actor: Actor, offerId: string): Promise<DeclinedOffer> {
    const master = await this.masters.getOwn(actor);
    await this.requireOwnOffer(offerId, master.id);

    const declined = await this.offers.decline(offerId, master.id, new Date());
    if (declined === undefined) {
      // Lost the update race with an expiry sweep, a concurrent accept, or
      // this master's own second tap. Re-read to say which, rather than
      // guessing: the row is the truth and it is one query away.
      const current = await this.requireOwnOffer(offerId, master.id);
      throw new OfferNoLongerActionableError(current.status);
    }

    return { offerId: declined.id, status: 'declined' };
  }

  /**
   * **Accept — the guard.**
   *
   * The order of the checks is the design, and each one is here because the
   * others cannot answer its question:
   *
   * 1. **Is this offer the caller's, and is it live?** A stranger's offer id
   *    answers 404, never 403 — an offer's existence says that a particular
   *    master was near a particular job at a particular time.
   * 2. **Has somebody already taken the order?** Answered here so that a late
   *    tap and a lost race produce the *same* code; without it the late tap
   *    would fall into the transition table and come back as a generic invalid
   *    transition for what is plainly "somebody beat you to it".
   * 3. **Is the edge legal at all?** `assertOrderTransition` against the one
   *    table that knows (`order-lifecycle.ts`), with `claimingMaster` as the
   *    actor — the actor kind that exists precisely for a master who is not
   *    yet assigned. This is what refuses an accept on a `CANCELLED` or
   *    `NO_MASTER_FOUND` order with a specific code. **It does not decide the
   *    race**, and the conditional `UPDATE` does not decide legality.
   * 4. **May this master take work at all?** `assertCanAcceptWork` re-reads
   *    verification from the database — issue #39's "a suspended master cannot
   *    accept, even with a token issued before suspension" — and gives a
   *    specific answer ("suspended" versus "not verified yet") that the
   *    predicate below cannot, because the predicate is a boolean.
   * 5. **Does the whole dispatch predicate still hold?** Verified, available
   *    *and live*, offers the service, inside this round's radius, debt at or
   *    under `MAX_COMMISSION_DEBT_MINOR` — re-evaluated now, against this
   *    order's job site and the radius the round that reached this master
   *    actually used (`order_offers.radius_m`).
   * 6. **The claim itself**, which is where correctness lives rather than in
   *    any of the above. Everything before this point is an early, friendlier
   *    answer; none of it is load-bearing against a concurrent accept, because
   *    two requests can pass all five checks together. Only the `WHERE` clause
   *    can separate them.
   */
  async accept(actor: Actor, offerId: string): Promise<AcceptedOffer> {
    const master = await this.masters.getOwn(actor);
    const offer = await this.requireActionableOffer(offerId, master.id);

    const order = await this.orders.findById(offer.orderId);
    if (order === undefined) {
      // The offer references the order by a `restrict` foreign key, so this is
      // an order still in `DRAFT` — an in-flight creation nothing outside
      // `OrdersRepository` may see. Not reachable from a broadcast, and the
      // honest answer to "show me a thing you may not see" is 404.
      throw new NotFoundError();
    }

    if (order.masterId !== null) {
      throw new OrderAlreadyTakenError();
    }

    assertOrderTransition(order.status, 'ACCEPTED', {
      kind: 'master',
      isAssignedMaster: false,
    });

    await this.masters.assertCanAcceptWork(master.id);

    const address = await this.requireOrderAddress(order);
    await this.assertStillEligible(master.id, order, offer, address);

    const outcome = await this.offers.claim({
      offerId: offer.id,
      orderId: order.id,
      masterId: master.id,
      actorUserId: actor.userId,
      now: new Date(),
    });

    switch (outcome.kind) {
      case 'lost':
        throw new OrderAlreadyTakenError();
      case 'offer_gone': {
        // The row moved under this master between the pre-checks and the
        // claim — an expiry sweep, or their own concurrent decline. Re-read
        // to say **which**, the way `decline` does, rather than reporting
        // `'expired'` for both: the repository raises one signal for the two
        // and the row is one query away. Telling a master their offer lapsed
        // when they declined it is a different, and untrue, story.
        const current = await this.requireOwnOffer(offer.id, master.id);
        throw new OfferNoLongerActionableError(current.status);
      }
      case 'already_working':
        throw new MasterHasActiveOrderError();
      case 'claimed':
        /**
         * The race is over, so the rest of the broadcast schedule is waste
         * (issue #120). Announced rather than cancelled here: which jobs a
         * search owns is the engine's business, and this module does not know
         * that a schedule exists.
         *
         * **Nothing depends on this having worked.** Every remaining tick
         * still guards on the database — the wave insert's
         * `exists (... status = 'SEARCHING') for share` and the give-up's
         * conditional `UPDATE` — so a cancellation that fails, or that finds a
         * job id BullMQ has already recycled, costs a handful of reads and
         * writes nothing. `ended` therefore swallows its own failures: the
         * order is committed as `ACCEPTED` and this master is on their way,
         * and a queue error must not tell them they lost a job they won.
         */
        await this.dispatch.ended(order.id);
        /**
         * The customer's spinner stops here (#144).
         *
         * After the transaction and never inside it, for the reason above,
         * and the accepting master is not told: they are the actor, and
         * `OrderNotificationsService` removes the actor from the recipients.
         * Nothing in this method names the customer — the registry is handed
         * the committed row and works out who the parties are.
         */
        await this.orderNotifications.transitioned({
          orderId: outcome.order.id,
          customerId: outcome.order.customerId,
          masterId: outcome.order.masterId,
          to: outcome.order.status,
          actorUserId: actor.userId,
        });
        return toAcceptedOffer(offer.id, outcome.order, address);
    }
  }

  /**
   * The exact address of a job this master won — readable after the accept and
   * by nobody else.
   *
   * Addressed by the **offer** rather than by the order, because the offer is
   * the only handle this surface hands a master and an order id they never
   * received is not an identifier they should have to hold. The authorization
   * is two facts together, and neither alone is enough: the offer is theirs
   * and reads `accepted`, **and** the order's `master_id` is still them. The
   * second is what makes a re-dispatch take the address back — a master who
   * accepted and then cancelled keeps an `accepted` offer row, and must not
   * keep the customer's home address with it.
   *
   * 404 for every failure, including "you are no longer on this job": a
   * distinguishable answer would let a master confirm that an address exists
   * behind an id they can no longer see.
   */
  async getAddress(actor: Actor, offerId: string): Promise<Address> {
    const master = await this.masters.getOwn(actor);
    const offer = await this.requireOwnOffer(offerId, master.id);

    if (offer.status !== 'accepted') {
      throw new NotFoundError();
    }

    const order = await this.orders.findById(offer.orderId);
    if (order === undefined || order.masterId !== master.id) {
      throw new NotFoundError();
    }

    return this.requireOrderAddress(order);
  }

  /**
   * The whole dispatch predicate, re-asked about this master, now.
   *
   * The radius is **this offer's own `radius_m`** rather than the
   * configured initial radius: rounds widen (ADR-0009), and a master legitimately
   * reached by a 6 km round must not be refused against a 3 km one. It is the
   * round's boundary as recorded on the row, which is exactly the radius this
   * master was invited within.
   */
  private async assertStillEligible(
    masterId: string,
    order: OrderRow,
    offer: OrderOfferRow,
    address: Address,
  ): Promise<void> {
    const eligible = await this.nearby.isEligible(masterId, {
      serviceId: order.serviceId,
      latitude: address.latitude,
      longitude: address.longitude,
      radiusM: offer.radiusM,
    });

    if (!eligible) {
      throw new MasterNotEligibleForOfferError();
    }
  }

  /**
   * The order's address row.
   *
   * Every order holds its address by a `restrict` foreign key and addresses are
   * soft-deleted, so a missing row here is not reachable. Thrown rather than
   * defaulted, because the alternative — accepting against coordinates of
   * `(0, 0)` — would put a master in the Gulf of Guinea and pass the radius
   * check for nobody.
   */
  private async requireOrderAddress(order: OrderRow): Promise<Address> {
    const address = await this.addresses.findForOrderDispatch(order.addressId);
    if (address === undefined) {
      throw new NotFoundError();
    }
    return address;
  }

  /** This master's own offer, or the same 404 a nonexistent id gets. */
  private async requireOwnOffer(offerId: string, masterId: string): Promise<OrderOfferRow> {
    const offer = await this.offers.findOwnOffer(offerId, masterId);
    if (offer === undefined) {
      throw new NotFoundError();
    }
    return offer;
  }

  /**
   * This master's own offer, and still open.
   *
   * `expires_at` is checked here as well as the status, for the reason the
   * feed checks both: an offer's window running out is a fact about the clock,
   * and whether a sweep has relabelled the row yet is a fact about a background
   * job. A master must not be able to claim a job through an offer that expired
   * four minutes ago because nothing has got round to saying so.
   *
   * A `lost` row answers {@link OrderAlreadyTakenError} rather than "no longer
   * open": it means this master already tapped accept on this order and did not
   * win, and telling them their offer lapsed would be a different — and
   * untrue — story.
   */
  private async requireActionableOffer(offerId: string, masterId: string): Promise<OrderOfferRow> {
    const offer = await this.requireOwnOffer(offerId, masterId);

    if (offer.status === 'lost') {
      throw new OrderAlreadyTakenError();
    }
    if (offer.status !== 'offered') {
      throw new OfferNoLongerActionableError(offer.status);
    }
    if (offer.expiresAt.getTime() <= Date.now()) {
      throw new OfferNoLongerActionableError('expired');
    }

    return offer;
  }
}

/**
 * The card, with the distance already blurred into a band and the photos
 * already signed.
 *
 * Written as an explicit field list rather than a spread, for
 * `toMasterResponse`'s reason and with far more at stake: a column added to
 * `orders` or `order_offers` later must not reach a broadcast audience
 * because nobody remembered to exclude it. `orderId`, `customerId`,
 * `addressId`, `distanceM`, `photoCount`, `round` and `radiusM` are all
 * absent, and each absence is deliberate.
 *
 * The photos arrive as an argument rather than being fetched here, so that
 * building a card cannot be a database call — which is what made the feed
 * 1 + N. A free function for the same reason: with nothing left to read, it
 * needs none of the service's dependencies.
 */
function toOfferCard(row: LiveOfferRow, photos: readonly OfferPhoto[]): MasterOffer {
  return {
    id: row.id,
    serviceId: row.serviceId,
    description: row.description,
    photos,
    distanceBand: distanceBand(row.distanceM),
    priceMinor: row.priceMinor,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * The winner's response.
 *
 * `priceMinor` comes off the **claimed row** rather than from anything read
 * earlier: it is whatever the conditional `UPDATE`'s subquery actually froze,
 * which is the only number that will ever be billed (ADR-0013). Reading it
 * back from the card, or from the master's profile, would be reporting a price
 * the order does not have.
 */
function toAcceptedOffer(offerId: string, order: OrderRow, address: Address): AcceptedOffer {
  if (order.acceptedAt === null) {
    // The same statement wrote `accepted_at`, and
    // `orders_accepted_at_requires_master` would have refused the row
    // otherwise. Thrown rather than asserted away, because returning a
    // half-built acceptance to a master who is about to drive somewhere is
    // worse than failing loudly.
    throw new Error('The claimed order carries no accepted_at.');
  }

  return {
    offerId,
    orderId: order.id,
    serviceId: order.serviceId,
    description: order.description,
    priceMinor: order.priceMinor,
    acceptedAt: order.acceptedAt.toISOString(),
    address,
  };
}
