import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';

import { isUniqueViolation } from '../../../infra/database/database-error';
import { DATABASE_CONNECTION } from '../../../infra/database/database.tokens';
import type { Database } from '../../../infra/database/database.types';
import { masterServices } from '../../../infra/database/schema/masters';
import type { OrderOfferRow } from '../../../infra/database/schema/order-offers';
import { orderOffers } from '../../../infra/database/schema/order-offers';
import type { OrderRow } from '../../../infra/database/schema/orders';
import { orders } from '../../../infra/database/schema/orders';
import { OrdersRepository } from '../../orders/orders.repository';

/**
 * One row of the offer feed, before photos and before the distance has been
 * blurred into a band.
 *
 * `distanceM` is on this shape and **not** on the wire contract. It is read so
 * `distanceBand` can turn it into a band, and it stops here
 * (`docs/product/master-flow.md`).
 */
export interface LiveOfferRow {
  readonly id: string;
  readonly orderId: string;
  readonly serviceId: string;
  readonly description: string;
  readonly distanceM: number;
  /** This master's own current price for the order's service, or null. */
  readonly priceMinor: number | null;
  readonly expiresAt: Date;
}

/**
 * What happened when a master tapped accept.
 *
 * A union rather than an exception per case, because only one of these is
 * exceptional. Losing the race is the **ordinary** outcome on ADR-0009's
 * model — most masters who tap lose — and a repository that threw for it would
 * be describing the normal path as an error.
 */
export type ClaimOutcome =
  | { readonly kind: 'claimed'; readonly order: OrderRow }
  /** Somebody else got there first, or the order stopped being claimable. */
  | { readonly kind: 'lost' }
  /** This master's own offer row moved under them — a concurrent decline or expiry sweep. */
  | { readonly kind: 'offer_gone' }
  /** `orders_one_active_per_master`: this master already holds a live job. */
  | { readonly kind: 'already_working' };

/**
 * The master-facing half of `order_offers` (issue #101): read a master's own
 * live offers, decline one, and claim one.
 *
 * **It does not write offers.** Creating and expiring them is the dispatch
 * engine's, and lives on its own side of this table — this file only ever
 * moves a row that already exists into the state the responding master put it
 * in.
 *
 * Drizzle queries only, no business rules and no HTTP
 * (`docs/architecture/backend-architecture.md` § Module rules). Whether the
 * master was still eligible is `NearbyMastersService`'s answer and whether the
 * edge is legal is `order-lifecycle.ts`'s; this file knows only how to write
 * the result down atomically.
 */
@Injectable()
export class MasterOffersRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    private readonly ordersRepository: OrdersRepository,
  ) {}

  /**
   * This master's own live offers, newest first.
   *
   * Four terms, and each one removes a row a master must not be shown:
   *
   * - `status = 'offered'` — a declined, expired, lost or accepted offer is
   *   not live, which is the acceptance criterion "expired, declined and lost
   *   offers are not in the feed" and, for `declined`, ADR-0009's permanence
   *   rule showing up as a `WHERE` clause rather than as a habit.
   * - `expires_at > now()` — an offer whose window has run out is gone the
   *   moment it runs out, whether or not a sweep has relabelled the row yet.
   *   Trusting `status` alone would show a master an offer that tapping
   *   cannot claim, which ADR-0009 calls a support ticket.
   * - the join to `orders` on `status = 'SEARCHING'` — the customer may have
   *   cancelled, or dispatch may have given up, since the broadcast.
   * - the join to `master_services` — a master who has since retired or paused
   *   this service is no longer eligible, so the offer would be refused on
   *   tap. It is also where the card's price comes from, re-read now rather
   *   than carried from the broadcast.
   *
   * The first two are served by `order_offers_master_status_created_idx`,
   * whose leading columns are exactly `(master_id, status, created_at desc)`.
   *
   * **Bounded by `limit` rather than paginated.** A feed is a live working
   * set, not a history: an offer that has scrolled past a master's attention
   * has expired by the time they reach page two, and a cursor would be an API
   * for reading offers that no longer exist.
   */
  async listLiveForMaster(masterId: string, limit: number): Promise<LiveOfferRow[]> {
    return this.db
      .select({
        id: orderOffers.id,
        orderId: orderOffers.orderId,
        serviceId: orders.serviceId,
        description: orders.description,
        distanceM: orderOffers.distanceM,
        priceMinor: masterServices.priceMinor,
        expiresAt: orderOffers.expiresAt,
      })
      .from(orderOffers)
      .innerJoin(orders, and(eq(orders.id, orderOffers.orderId), eq(orders.status, 'SEARCHING')))
      .innerJoin(
        masterServices,
        and(
          eq(masterServices.masterId, orderOffers.masterId),
          eq(masterServices.serviceId, orders.serviceId),
          eq(masterServices.isActive, true),
        ),
      )
      .where(
        and(
          eq(orderOffers.masterId, masterId),
          eq(orderOffers.status, 'offered'),
          gt(orderOffers.expiresAt, sql`now()`),
        ),
      )
      .orderBy(desc(orderOffers.createdAt))
      .limit(limit);
  }

  /**
   * One offer, **scoped to the master it was made to**.
   *
   * The master id is in the `WHERE` rather than checked by the caller
   * afterwards, for `OrdersRepository.findByIdForCustomer`'s reason: a read
   * that can return somebody else's row, even briefly, is a read that will
   * eventually be used without the check. Another master's offer id therefore
   * reads as absent, which the service turns into 404 rather than 403 — a 403
   * would confirm the offer exists, and an offer's existence says that a
   * particular master was near a particular job.
   */
  async findOwnOffer(offerId: string, masterId: string): Promise<OrderOfferRow | undefined> {
    const [row] = await this.db
      .select()
      .from(orderOffers)
      .where(and(eq(orderOffers.id, offerId), eq(orderOffers.masterId, masterId)))
      .limit(1);

    return row;
  }

  /**
   * Declines one offer, if it is still declinable.
   *
   * Conditional on `status = 'offered'` in the same statement, so a decline
   * racing an expiry sweep or a concurrent accept cannot overwrite the outcome
   * that already happened. Zero rows means somebody — or something — got there
   * first, and the service re-reads the row to say which.
   *
   * **The decline is permanent by construction, not by policy code here.**
   * `order_offers_order_master_unique` allows one row per `(order, master)`
   * ever, and a widening round re-offers by updating rows that are still
   * `offered`; a row parked at `declined` is therefore invisible to every
   * later round without anything having to remember to exclude it.
   */
  async decline(offerId: string, masterId: string, now: Date): Promise<OrderOfferRow | undefined> {
    const [row] = await this.db
      .update(orderOffers)
      .set({ status: 'declined', respondedAt: now })
      .where(
        and(
          eq(orderOffers.id, offerId),
          eq(orderOffers.masterId, masterId),
          eq(orderOffers.status, 'offered'),
        ),
      )
      .returning();

    return row;
  }

  /**
   * **The statement that decides the race, and the transaction around it.**
   *
   * ADR-0009: "concurrent accept correctness is now the single most important
   * invariant in the backend". Several masters will tap accept in the same
   * second and exactly one must win, and the only mechanism that can promise
   * that is a condition the database evaluates *as part of* the write:
   *
   * ```sql
   * update orders set ... where id = $1 and status = 'SEARCHING' and master_id is null
   * ```
   *
   * Read-then-write cannot do it — two requests both observe `SEARCHING` and
   * both write. Neither can a Redis lock, which ADR-0009 rules out explicitly:
   * a lock can expire in the middle of an operation and a `WHERE` clause
   * cannot. Zero rows returned **is** the answer "you lost", and it is the
   * ordinary outcome rather than an error.
   *
   * **The price is frozen in that same statement, from a subquery, not from a
   * parameter** ([ADR-0013](docs/decisions/ADR-0013-price-freeze-point.md)).
   * `NearbyMasterCandidate.priceMinor` says why in as many words: the number
   * on the offer card was read at broadcast time, the master may have edited
   * their price since, and the value the order is billed at must be the one
   * stored when the claim commits. A subquery correlated on `orders.service_id`
   * is what makes "read the price" and "assign the master" one operation with
   * nothing able to interleave between them.
   *
   * A master with no active `master_services` row for an inspection-priced
   * service freezes **null**, which `orders_price_requires_master` and
   * `orders_price_positive` both permit. Never zero: null and zero mean
   * different things and ADR-0013 depends on the difference.
   *
   * The three writes that follow ride in the same transaction, because a crash
   * between any two of them leaves a state nothing can repair:
   *
   * 1. the winner's own offer row becomes `accepted`;
   * 2. every other **live** offer on this order becomes `lost` — `declined`
   *    and `expired` rows are left alone, because each of those records
   *    something that actually happened and `lost` would overwrite it;
   * 3. the `SEARCHING -> ACCEPTED` transition is appended to the audit trail,
   *    through `OrdersRepository.recordTransition` rather than by writing
   *    another module's table from here.
   *
   * `orders_one_active_per_master` — the partial unique index over the four
   * active statuses — fires on step 0 when this master already holds a live
   * job. It is the only unique index this transaction can violate (nothing
   * here touches the idempotency key), so a unique violation is reported as
   * exactly that rather than reaching a client as a 500 with a constraint name
   * in it.
   */
  async claim(input: {
    readonly offerId: string;
    readonly orderId: string;
    readonly masterId: string;
    readonly actorUserId: string;
    readonly now: Date;
  }): Promise<ClaimOutcome> {
    const { offerId, orderId, masterId, actorUserId, now } = input;

    try {
      return await this.db.transaction(async (tx) => {
        const [claimed] = await tx
          .update(orders)
          .set({
            status: 'ACCEPTED',
            masterId,
            priceMinor: sql`(
              select ${masterServices.priceMinor}
                from ${masterServices}
               where ${masterServices.masterId} = ${masterId}
                 and ${masterServices.serviceId} = ${orders.serviceId}
                 and ${masterServices.isActive}
            )`,
            acceptedAt: now,
          })
          .where(
            and(eq(orders.id, orderId), eq(orders.status, 'SEARCHING'), isNull(orders.masterId)),
          )
          .returning();

        if (claimed === undefined) {
          return { kind: 'lost' };
        }

        const [accepted] = await tx
          .update(orderOffers)
          .set({ status: 'accepted', respondedAt: now })
          .where(
            and(
              eq(orderOffers.id, offerId),
              eq(orderOffers.masterId, masterId),
              eq(orderOffers.status, 'offered'),
            ),
          )
          .returning();

        if (accepted === undefined) {
          // The offer was declined or swept between the pre-checks and here.
          // Unwinding is the only honest answer: the order must not end up
          // assigned through an offer that no longer says `offered`.
          //
          // Thrown rather than `tx.rollback()`, which raises Drizzle's own
          // `TransactionRollbackError` — a class whose `name` is the base
          // `'DrizzleError'` and whose identity is a private `entityKind`
          // symbol, so the `catch` below could not tell it from any other
          // Drizzle failure without reaching into an undocumented export
          // (`database-error.ts` explains why this codebase does not). Any
          // throw rolls the transaction back; only this one is ours to
          // recognise.
          throw new OfferNoLongerOfferedSignal();
        }

        await tx
          .update(orderOffers)
          .set({ status: 'lost', respondedAt: now })
          .where(
            and(
              eq(orderOffers.orderId, orderId),
              eq(orderOffers.status, 'offered'),
              ne(orderOffers.id, offerId),
            ),
          );

        await this.ordersRepository.recordTransition(
          orderId,
          'SEARCHING',
          'ACCEPTED',
          { kind: 'master', userId: actorUserId },
          tx,
        );

        return { kind: 'claimed', order: claimed };
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        return { kind: 'already_working' };
      }
      if (error instanceof OfferNoLongerOfferedSignal) {
        return { kind: 'offer_gone' };
      }
      throw error;
    }
  }
}

/**
 * Not an `AppError` and never seen outside this file: it exists only to unwind
 * the transaction above and be turned straight back into a `ClaimOutcome`.
 *
 * Private to the module, so `instanceof` is sound here in a way it is not
 * against a library's internal class — there is exactly one definition and it
 * is in this file.
 */
class OfferNoLongerOfferedSignal extends Error {
  constructor() {
    super('The offer stopped being offered during the claim.');
    this.name = 'OfferNoLongerOfferedSignal';
    Object.setPrototypeOf(this, OfferNoLongerOfferedSignal.prototype);
  }
}
