import { Inject, Injectable } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { AppConfig } from '../../infra/config/app-config.types';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, DatabaseExecutor } from '../../infra/database/database.types';
import type { MasterLocationRow } from '../../infra/database/schema/master-locations';
import { masterLocations } from '../../infra/database/schema/master-locations';

/**
 * `ST_SetSRID(ST_MakePoint(lng, lat), 4326)` — the write path for `position`,
 * and the reason it is hand-written SQL rather than a Drizzle value.
 *
 * Identical to `AddressesRepository.positionValue`, and identical for the
 * identical reason: `drizzle-orm@0.45.2`'s `PgGeometryObject.mapToDriverValue`
 * emits `point(x y)`, which Postgres reads as SRID 0, and the
 * `geometry(Point,4326)` typmod the migration writes by hand rejects it
 * outright (ADR-0018). It is duplicated rather than shared because the two
 * live in different modules and the shared home for it is `packages/validation`
 * when a third consumer makes that package real (ADR-0016) — not a helper
 * imported across a module boundary in the meantime.
 *
 * **Longitude first.** `ST_MakePoint` takes x then y, and x is longitude. A
 * swap passes every bound check in Baku, so the ordering is pinned by a
 * round-trip test asserting `ST_X` returns the longitude.
 */
function positionValue(latitude: number, longitude: number) {
  return sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)`;
}

/**
 * Drizzle queries over `master_locations`, and nothing else — no business
 * rules, no HTTP (`docs/architecture/backend-architecture.md` § Module rules).
 *
 * Eligibility (is this master verified, did they turn themselves on) is
 * decided before anything here runs. What this file owns is the two properties
 * the table itself promises: every write appends, and every write also
 * forgets.
 */
@Injectable()
export class MasterLocationRepository {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: Database,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Records one position, and prunes that master's expired trail in the same
   * transaction.
   *
   * **The prune rides on the write because there is nowhere else to put it.**
   * `docs/architecture/database-architecture.md` requires this table to be
   * retention-bounded, and this repository has no scheduler — no BullMQ, no
   * `@nestjs/schedule` — so a nightly sweep would be a rule with nothing to
   * run it. Doing it here needs no new infrastructure, costs one indexed
   * DELETE on a write path that is already a write, and has the property that
   * matters most: the trail of a master who is actively reporting can never
   * grow past the retention window, no matter how long they work.
   *
   * It is deliberately **this master's rows only**. A sweep of the whole table
   * on every report would put one master's request in contention with every
   * other master's, which is the shape that looks fine in development and
   * locks up a dispatch fleet.
   *
   * One transaction, not two statements, so a crash between them cannot leave
   * the row written and the trail unpruned — and so the `SET LOCAL` below has
   * a scope to belong to.
   *
   * What this does NOT cover, stated rather than implied: a master who stops
   * reporting keeps whatever is left of their last window until they report
   * again, because nothing runs on their behalf while they are gone. That is a
   * bounded residue rather than an unbounded history, and closing it needs the
   * scheduler this Epic does not introduce.
   */
  async record(input: {
    masterId: string;
    latitude: number;
    longitude: number;
  }): Promise<MasterLocationRow> {
    return this.db.transaction(async (tx) => {
      const [recorded] = await tx
        .insert(masterLocations)
        .values({
          id: uuidV7(),
          masterId: input.masterId,
          position: positionValue(input.latitude, input.longitude),
        })
        .returning();

      if (recorded === undefined) {
        // Unreachable: an INSERT ... RETURNING of one row returns one row, and
        // a constraint violation throws instead. Present so the narrowing is
        // explicit rather than an assertion.
        throw new Error('Insert into master_locations returned no row.');
      }

      await this.pruneTrail(input.masterId, tx);
      return recorded;
    });
  }

  /**
   * Deletes this master's rows older than the retention window.
   *
   * **Publishing the cutoff is what makes the DELETE legal at all.** The
   * table's append-only trigger raises on every UPDATE and on every DELETE of a
   * row at or after `tezusta.location_retention` — see
   * `0015_master_locations.sql` for why the exception exists and why it is a
   * cutoff rather than an on/off flag. `set_config(..., true)` is the `SET
   * LOCAL` form, so the permission never outlives the transaction and no pooled
   * connection carries it into the next request; an admin console, a stray
   * script or a later migration still hits the same wall `order_status_history`
   * puts up, and so does this transaction the moment it aims at a row the
   * window still covers.
   *
   * **One evaluation, used twice.** The cutoff is computed, published and read
   * back in a single statement, and the DELETE then filters on the text that
   * came back rather than re-deriving it — so the value the trigger tests each
   * row against and the value the `WHERE` clause selects on are the same
   * string, not two expressions that agree today.
   *
   * The `now()` inside it is transaction time, and the row just inserted
   * carries the same one, so the newest position can never be the row this
   * deletes — the "keep the current position hot" half of the retention rule
   * holds by construction rather than by a `LIMIT` somebody has to maintain.
   *
   * Runs on `master_locations_master_recent_idx`, which the nearby-masters
   * query needs anyway: leading on `master_id` with `recorded_at` descending
   * makes this a range delete rather than a scan of the master's whole trail.
   */
  private async pruneTrail(masterId: string, tx: DatabaseExecutor): Promise<void> {
    const applied = await tx.execute<{ cutoff: string }>(
      sql`select set_config(
            'tezusta.location_retention',
            (now() - make_interval(mins => ${this.config.masterLocation.trailMinutes}::int))::text,
            true
          ) as cutoff`,
    );
    const cutoff = applied.rows[0]?.cutoff;

    if (cutoff === undefined) {
      // Unreachable: `set_config` returns the value it set, and a one-row
      // SELECT returns one row. Present so the narrowing is explicit — and so
      // a DELETE can never run with a cutoff nobody published.
      throw new Error('set_config did not return the retention cutoff.');
    }

    await tx
      .delete(masterLocations)
      .where(
        and(
          eq(masterLocations.masterId, masterId),
          lt(masterLocations.recordedAt, sql`${cutoff}::timestamptz`),
        ),
      );
  }
}
