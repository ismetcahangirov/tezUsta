import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import { searchingSinceOf } from './searching-since';

/** One master a wave wants to reach, and how far away they were when it ran. */
export interface OfferCandidate {
  readonly masterId: string;
  /** Metres. Rounded here because `order_offers.distance_m` is an integer. */
  readonly distanceM: number;
}

/** Everything one broadcast round writes down. */
export interface BroadcastCommand {
  readonly orderId: string;
  /**
   * The search this round belongs to — when the order entered `SEARCHING`.
   * Part of the guard, not merely of the job id: see
   * {@link OrderOffersRepository.broadcast}.
   */
  readonly searchingSince: Date;
  /** 1-based, and taken from the clock rather than from the job payload. */
  readonly round: number;
  readonly radiusM: number;
  readonly expiresAt: Date;
  readonly candidates: readonly OfferCandidate[];
}

type OfferedRow = { readonly master_id: string };

/**
 * The **write** side of `order_offers` — what the dispatch engine does to the
 * table (issue #103). Reading a master's own feed, declining and accepting are
 * issue #101's, and live elsewhere.
 *
 * Drizzle queries only, no policy: which masters a round reaches is
 * `NearbyMastersService`'s answer and when a round happens is
 * `dispatch-schedule.ts`'s. What this file owns is that a round's intent
 * survives contact with a table that several replicas are writing to at once.
 */
@Injectable()
export class OrderOffersRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Offers this order to every candidate that may legitimately receive it, in
   * **one statement**, and answers with the masters actually reached.
   *
   * Three guarantees are carried by the SQL rather than by this process, which
   * is what makes the engine safe to run on two replicas at once and safe to
   * deliver the same tick twice (CLAUDE.md §12, ADR-0009):
   *
   * 1. **The order must still be searching, on this search.** The `EXISTS` is
   *    evaluated by the database in the same statement as the insert, and it
   *    carries `FOR SHARE`.
   *
   *    **The lock is the guarantee; the subquery alone is not.** Under `READ
   *    COMMITTED` a subquery in `INSERT ... SELECT` is evaluated against the
   *    statement's snapshot, and EvalPlanQual re-checking reaches only the
   *    *target* rows of an `UPDATE` — so an unlocked `EXISTS` reads a
   *    `SEARCHING` an accept has already replaced, and mints `offered` rows on
   *    an `ACCEPTED` order. Measured on this project's Postgres 17.5, with a
   *    concurrent uncommitted accept held open: the unlocked form did not wait
   *    and wrote a row; with `FOR SHARE` the statement waited for the accept to
   *    commit, re-checked the new row version, and wrote none.
   *
   *    The share lock lives for this one statement, and it is taken on `orders`
   *    before anything in `order_offers` — the same order the accept path takes
   *    them in, so the two serialise rather than deadlock.
   *
   *    The **generation** is in the guard as well as the status, for the reason
   *    `searching-since.ts` gives: once EPIC 8 can re-dispatch, an order can be
   *    `SEARCHING` on a *different* clock, and a tick from the search that was
   *    replaced would otherwise write its old round's radius into the new one.
   *    `DispatchService` checks the same fact in application code first; this is
   *    what closes the window between that read and this write.
   *
   * 2. **One row per `(order_id, master_id)`, ever.** The unique index makes a
   *    second row impossible; `ON CONFLICT DO UPDATE` is how a widening round
   *    re-offers, exactly as `order-offers.ts` describes. Two replicas running
   *    the same round therefore produce one set of offers rather than two.
   *
   * 3. **`declined` is forever. Losing a race is not.** The `WHERE` on the
   *    conflict branch is ADR-0009's rule and the whole of it: a row is
   *    re-offered when it is `expired`, when it is `offered` with its window
   *    already run out, or when it is `lost`.
   *
   *    **`lost` belongs on that list, and leaving it off was a permanent
   *    exclusion nobody decided.** A `lost` row is a master who tapped accept
   *    and was milliseconds late (`order-offers.ts`); they refused nothing.
   *    ADR-0009's parameter table makes exactly one re-offer rule — "re-offer
   *    an order a master declined: no" — and says nothing about a lost tap.
   *    With `lost` excluded, EPIC 8's `ACCEPTED -> SEARCHING` re-dispatch
   *    reached **nobody**: the accept path marks every other live offer `lost`,
   *    so a first search that broadcast to twenty masters left nineteen `lost`
   *    and one `accepted`, and the re-dispatch's waves upserted against exactly
   *    those rows, wrote nothing, and walked the order to `NO_MASTER_FOUND`
   *    having reached no one.
   *
   *    `declined` and `accepted` are still never touched, and both are
   *    deliberate. `declined` is ADR-0009's rule. `accepted` is the master the
   *    re-dispatch is taking the job away from, and `backend-architecture.md`
   *    § Re-dispatch requires precisely that they be excluded from the next
   *    broadcast — their row is what keeps them out of it.
   *
   *    That same predicate is what makes a duplicate tick harmless: the offers
   *    it would write are still live, so it updates nothing and reports nobody.
   *
   * `returning master_id` therefore reports **who was really offered this
   * round**, not who the round wanted to reach — which is what the caller
   * logs, and what a test asserts against.
   */
  async broadcast(command: BroadcastCommand): Promise<string[]> {
    const { orderId, searchingSince, round, radiusM, expiresAt, candidates } = command;

    if (candidates.length === 0) {
      return [];
    }

    const values = sql.join(
      candidates.map(
        (candidate) =>
          sql`(${uuidV7()}::uuid, ${candidate.masterId}::uuid, ${Math.max(
            0,
            Math.round(candidate.distanceM),
          )}::int)`,
      ),
      sql`, `,
    );

    const result = await this.db.execute<OfferedRow>(sql`
      insert into order_offers
        (id, order_id, master_id, round, radius_m, distance_m, status, expires_at)
      select c.id,
             ${orderId}::uuid,
             c.master_id,
             ${round}::int,
             ${radiusM}::int,
             c.distance_m,
             'offered',
             ${expiresAt}::timestamptz
        from (values ${values}) as c (id, master_id, distance_m)
       where exists (
               select 1
                 from orders o
                where o.id = ${orderId}::uuid
                  and o.status = 'SEARCHING'
                  and ${searchingSinceOf(sql`o.id`)} = ${searchingSince.getTime()}::bigint
                  for share
             )
          on conflict (order_id, master_id) do update
         set status = 'offered',
             round = excluded.round,
             radius_m = excluded.radius_m,
             distance_m = excluded.distance_m,
             expires_at = excluded.expires_at,
             responded_at = null
       where order_offers.status in ('expired', 'lost')
          or (order_offers.status = 'offered' and order_offers.expires_at <= now())
       returning master_id
    `);

    return result.rows.map((row) => row.master_id);
  }

  /**
   * Closes out every still-`offered` row on an order whose search has ended.
   *
   * Expiry is a **column**, not a job (issue #103): readers filter on
   * `expires_at`, so nothing is broken by a row that is merely past its window.
   * This exists so a terminal order does not leave rows claiming `offered` in
   * the master's own history — the feed would hide them, an audit read would
   * not.
   *
   * Never touches `declined`, `accepted` or `lost`: those are answers somebody
   * gave, and overwriting one would erase the record ADR-0009 needs to explain
   * why a master was or was not reached again.
   *
   * `executor` is how the caller makes this part of the transaction that ended
   * the search — `OrdersRepository.claimNoMasterFound` passes its own, so a
   * terminal order and a live offer on it are never both readable.
   */
  async expireLiveOffers(orderId: string, executor: DatabaseExecutor = this.db): Promise<number> {
    const result = await executor.execute(sql`
      update order_offers
         set status = 'expired'
       where order_id = ${orderId}::uuid
         and status = 'offered'
    `);

    return result.rowCount ?? 0;
  }
}
