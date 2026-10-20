import { Inject, Injectable } from '@nestjs/common';
import type { OrderSearchCell } from '@tezusta/types';
import { sql } from 'drizzle-orm';

import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database } from '../../infra/database/database.types';
import { coarsenSearchCells } from './search-cells';

/** One search of one order: the generation every reached-master question is scoped to. */
export interface SearchGeneration {
  readonly orderId: string;
  /** When the order last entered `SEARCHING` (`searching-since.ts`). */
  readonly searchingSince: Date;
}

/**
 * What the customer's search radar reads (issue #397,
 * [ADR-0055](docs/decisions/ADR-0055-search-radar-and-arrival-promise.md)
 * § 2–3), and the count dispatch puts in each wave's frame.
 *
 * **"Reached by this search" is `offered_at >= searching_since`**, on the one
 * column that records when a row was last offered. A row lives for the whole
 * order across re-dispatches, so anything keyed on `created_at` or
 * `expires_at` would let a previous search's masters into this one's picture.
 *
 * **No raw coordinate leaves this class.** {@link reachedCells} reads the
 * positions and returns cell centres; the points themselves exist only inside
 * that method's body, and nothing here logs.
 *
 * Reads committed rows only and takes no lock, so a radar read never waits on,
 * or holds up, the wave writing the offers it counts.
 */
@Injectable()
export class OrderSearchRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly db: Database) {}

  /**
   * Masters this search has offered the order to, in any status — a decliner
   * did see it, and the radar shows reach, not interest (ADR-0055 § 2).
   *
   * One order's rows through the leading column of
   * `order_offers_order_master_unique`.
   */
  async countReached(generation: SearchGeneration): Promise<number> {
    const result = await this.db.execute<{ reached: string }>(sql`
      select count(*)::text as reached
        from order_offers oo
       where oo.order_id = ${generation.orderId}::uuid
         and oo.offered_at >= ${generation.searchingSince}::timestamptz
    `);

    return Number(result.rows[0]?.reached ?? 0);
  }

  /**
   * The cells holding a reached master, coarsened, nearest `origin` first.
   *
   * A master is drawn only from a **fresh** latest position (the eligibility
   * age) and only while they are **still available**, live and verified. The
   * age limit outlasts a whole search, so without the availability term a
   * master who went offline mid-search would stay on its picture, and going
   * offline is how a master stops sharing where they are.
   *
   * One statement: the order's offers, each master's newest
   * `master_locations` row through `master_locations_master_recent_idx`
   * (`lateral … limit 1`, the nearby-masters query's own shape), filtered by
   * age afterwards — the latest row or nothing, never an older fresh-enough
   * one.
   */
  async reachedCells(
    generation: SearchGeneration,
    origin: { readonly latitude: number; readonly longitude: number },
    maxPositionAgeSeconds: number,
  ): Promise<OrderSearchCell[]> {
    const result = await this.db.execute<{ latitude: number; longitude: number }>(sql`
      select ST_Y(latest.position) as latitude,
             ST_X(latest.position) as longitude
        from order_offers oo
        join masters m on m.id = oo.master_id
       cross join lateral (
               select ml.position, ml.recorded_at
                 from master_locations ml
                where ml.master_id = oo.master_id
                order by ml.recorded_at desc, ml.id desc
                limit 1
             ) latest
       where oo.order_id = ${generation.orderId}::uuid
         and oo.offered_at >= ${generation.searchingSince}::timestamptz
         and m.deleted_at is null
         and m.verification_status = 'active'
         and m.is_available
         and latest.recorded_at >= now() - make_interval(secs => ${maxPositionAgeSeconds})
    `);

    return coarsenSearchCells(
      result.rows.map((row) => ({
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
      })),
      origin,
    );
  }
}
