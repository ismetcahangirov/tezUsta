import { Inject, Injectable } from '@nestjs/common';
import type { ArrivalPromiseSource, OrderStatus } from '@tezusta/types';
import { sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';

/** The statuses in which an arrival promise may still be written (ADR-0055 § 12). */
const PROMISABLE_STATUSES = sql`('ACCEPTED'::order_status, 'MASTER_ON_THE_WAY'::order_status)`;

/** `accepted_at` as epoch milliseconds, computed by Postgres (see `searching-since.ts`). */
const ACCEPTED_AT_MS = sql`(extract(epoch from date_trunc('milliseconds', o.accepted_at)) * 1000)::bigint`;

/** What the job needs to decide whether, and from where, to promise. */
export interface ArrivalPromiseTarget {
  readonly status: OrderStatus;
  readonly masterId: string | null;
  readonly acceptedAtMs: number | null;
  readonly hasPromise: boolean;
  readonly addressId: string;
}

/** One accept with no promise yet, for the backstop sweep. */
export interface MissingArrivalPromise {
  readonly orderId: string;
  readonly masterId: string;
  readonly acceptedAtMs: number;
}

/**
 * The arrival promise's reads and its one write (#396, ADR-0055 § 8–11).
 *
 * **Correctness lives in {@link write}'s `WHERE`, not in the read before it**,
 * the rule the dispatch engine follows. A replayed job, a job that runs after
 * a re-dispatch and a job racing the sweep each write at most one promise,
 * for the master and the accept it was computed for.
 *
 * `accepted_at` is compared as epoch milliseconds on both sides, for the
 * reason `searching-since.ts` gives: a `timestamptz` read into a JavaScript
 * `Date` and bound back in never equals itself below the millisecond.
 */
@Injectable()
export class ArrivalPromiseRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  async findTarget(orderId: string): Promise<ArrivalPromiseTarget | undefined> {
    const result = await this.db.execute<{
      status: OrderStatus;
      master_id: string | null;
      accepted_at_ms: string | null;
      has_promise: boolean;
      address_id: string;
    }>(sql`
      select o.status,
             o.master_id::text as master_id,
             ${ACCEPTED_AT_MS} as accepted_at_ms,
             o.promised_arrival_at is not null as has_promise,
             o.address_id::text as address_id
        from orders o
       where o.id = ${orderId}::uuid
    `);

    const row = result.rows[0];
    if (row === undefined) {
      return undefined;
    }
    return {
      status: row.status,
      masterId: row.master_id,
      acceptedAtMs: row.accepted_at_ms === null ? null : Number(row.accepted_at_ms),
      hasPromise: row.has_promise,
      addressId: row.address_id,
    };
  }

  /**
   * The straight-line distance the accepting master was shown when offered
   * the job (`order_offers.distance_m`): the estimate's distance when the
   * master has no fresh position (ADR-0055 § 10).
   */
  async acceptedOfferDistanceM(orderId: string, masterId: string): Promise<number | undefined> {
    const result = await this.db.execute<{ distance_m: number }>(sql`
      select oo.distance_m
        from order_offers oo
       where oo.order_id = ${orderId}::uuid
         and oo.master_id = ${masterId}::uuid
         and oo.status = 'accepted'
    `);

    const row = result.rows[0];
    return row === undefined ? undefined : Number(row.distance_m);
  }

  /**
   * Writes the promise if, and only if, the order is still this master's,
   * from this accept, still on its way, and has none yet. Answers whether it
   * wrote.
   */
  async write(input: {
    orderId: string;
    masterId: string;
    acceptedAtMs: number;
    promisedArrivalAt: Date;
    source: ArrivalPromiseSource;
  }): Promise<boolean> {
    const result = await this.db.execute(sql`
      update orders o
         set promised_arrival_at = ${input.promisedArrivalAt}::timestamptz,
             arrival_promise_source = ${input.source}::arrival_promise_source,
             updated_at = now()
       where o.id = ${input.orderId}::uuid
         and o.master_id = ${input.masterId}::uuid
         and ${ACCEPTED_AT_MS} = ${input.acceptedAtMs}::bigint
         and o.promised_arrival_at is null
         and o.status in ${PROMISABLE_STATUSES}
      returning o.id
    `);

    return result.rows.length === 1;
  }

  /**
   * Accepts older than `acceptedBefore` that still have no promise: the ones
   * whose job was never scheduled, or died. Oldest first, bounded.
   *
   * Narrowed by `orders_status_created_idx` on its leading column: the
   * promisable statuses are a small, live minority of the table.
   */
  async listMissing(input: {
    acceptedBefore: Date;
    limit: number;
  }): Promise<MissingArrivalPromise[]> {
    const result = await this.db.execute<{
      id: string;
      master_id: string;
      accepted_at_ms: string;
    }>(sql`
      select o.id::text as id,
             o.master_id::text as master_id,
             ${ACCEPTED_AT_MS} as accepted_at_ms
        from orders o
       where o.status in ${PROMISABLE_STATUSES}
         and o.promised_arrival_at is null
         and o.accepted_at < ${input.acceptedBefore}::timestamptz
       order by o.accepted_at asc
       limit ${input.limit}
    `);

    return result.rows.map((row) => ({
      orderId: row.id,
      masterId: row.master_id,
      acceptedAtMs: Number(row.accepted_at_ms),
    }));
  }
}
