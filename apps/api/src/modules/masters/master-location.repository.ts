import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';

import { uuidV7 } from '../../common/ids/uuid-v7';
import { APP_CONFIG } from '../../infra/config/config.tokens';
import type { AppConfig } from '../../infra/config/app-config.types';
import { DATABASE_CONNECTION } from '../../infra/database/database.tokens';
import type { Database, Transaction } from '../../infra/database/database.types';
import type { MasterLocationRow } from '../../infra/database/schema/master-locations';
import { masterLocations } from '../../infra/database/schema/master-locations';
import { orders } from '../../infra/database/schema/orders';
import { MASTER_ENGAGED_ORDER_STATUSES } from '../orders/orders.repository';

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
   * What this does NOT cover, and why it is still here: a master who stops
   * reporting keeps whatever is left of their last window until they report
   * again, because nothing runs on their behalf while they are gone.
   * {@link sweepExpiredTrails} (#105) is what closes that, and it is a floor
   * rather than a replacement — losing this per-write bound would make an
   * actively reporting master's trail depend on how recently the sweep ran.
   */
  /**
   * The order this master is engaged on, or `null` (issue #171) — answered on
   * every report so a backgrounded app learns its job has ended.
   *
   * The same lookup, over the same status list, as
   * `OrdersRepository#findEngagedOrderIdForMaster`, and for the same reason
   * cheap: the `WHERE` is implied by `orders_one_active_per_master`'s
   * predicate, so it is one index probe. Asked here rather than through
   * `OrdersRepository` because `OrdersModule` already imports this module,
   * and the reverse import would be a cycle.
   */
  async findEngagedOrderId(masterId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(eq(orders.masterId, masterId), inArray(orders.status, MASTER_ENGAGED_ORDER_STATUSES)),
      )
      .limit(1);

    return row?.id ?? null;
  }

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
   * Deletes up to `limit` rows older than the retention window, **whoever
   * they belong to** (#105).
   *
   * The floor under {@link record}'s prune, not a replacement for it. That
   * prune bounds the trail of a master who is reporting; this one bounds the
   * trail of a master who is not. A master who deletes their profile, is
   * suspended, or simply leaves keeps whatever was left of their last window
   * indefinitely otherwise, because nothing runs on their behalf while they
   * are gone — and `docs/engineering/security.md` treats a precise position as
   * PII that does not degrade, for which "we will delete it when they come
   * back" is not a retention policy.
   *
   * **"Always keep a master's latest row" is deliberately NOT a rule here**,
   * and the issue asks for that to be decided rather than assumed. Keeping it
   * would leave every departed master one precise, permanent position — which
   * is the exact residue this sweep exists to remove, reduced to a single row
   * rather than removed. The live master is protected by arithmetic instead: a
   * master who has reported inside the window has their newest row inside the
   * window, so this DELETE cannot reach it. A master whose newest row is
   * *older* than the window is, by the only definition this table has, not
   * reporting.
   *
   * **Bounded, and its own transaction per batch.** A single unbounded DELETE
   * would hold locks across every master's rows while competing with the
   * reporting path it exists to relieve; the caller loops
   * (`MaintenanceService.inBatches`) and each call commits on its own, so a
   * long backlog is drained in slices rather than in one statement.
   *
   * **Safe on every replica at once** without a lock, because there is only
   * ever one sweep: the recurring job is a BullMQ scheduler keyed by name, and
   * each iteration is a single queued job exactly one worker in the fleet
   * runs (`RecurringWorkService`). Two of them racing anyway would still be
   * harmless — `DELETE` of a row another transaction already deleted simply
   * matches nothing.
   *
   * Reads `master_locations_retention_idx`, added for this query and only
   * after `EXPLAIN` said so — the measurement is in
   * `schema/master-locations.ts`.
   */
  async sweepExpiredTrails(limit: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      const cutoff = await this.publishRetentionCutoff(tx);

      /**
       * `id in (select id … limit)` rather than a bare `delete … limit`,
       * which Postgres does not have. The inner select is what the bound is
       * applied to, and it runs on the retention index; the outer delete then
       * finds each row by primary key.
       *
       * No `order by`: the sweep has no use for the oldest rows first — every
       * matching row is going — and sorting a batch would add a cost for an
       * ordering nothing reads.
       */
      const deleted = await tx.execute(sql`
        delete from master_locations
         where id in (
           select id
             from master_locations
            where recorded_at < ${cutoff}::timestamptz
            limit ${limit}
         )
      `);

      return deleted.rowCount ?? 0;
    });
  }

  /**
   * Deletes this master's rows older than the retention window.
   *
   * {@link publishRetentionCutoff} is what makes the DELETE legal at all, and
   * why the value it returns is the one filtered on rather than a second
   * expression that agrees today.
   *
   * The `now()` inside that cutoff is transaction time, and the row just
   * inserted carries the same one, so the newest position can never be the row
   * this deletes — the "keep the current position hot" half of the retention
   * rule holds by construction rather than by a `LIMIT` somebody has to
   * maintain.
   *
   * Runs on `master_locations_master_recent_idx`, which the nearby-masters
   * query needs anyway: leading on `master_id` with `recorded_at` descending
   * makes this a range delete rather than a scan of the master's whole trail.
   */
  private async pruneTrail(masterId: string, tx: Transaction): Promise<void> {
    const cutoff = await this.publishRetentionCutoff(tx);

    await tx
      .delete(masterLocations)
      .where(
        and(
          eq(masterLocations.masterId, masterId),
          lt(masterLocations.recordedAt, sql`${cutoff}::timestamptz`),
        ),
      );
  }

  /**
   * Publishes the retention cutoff for the rest of this transaction, and
   * returns the exact text it published.
   *
   * **This is what makes any DELETE on this table legal at all**, and it is
   * shared by the two that exist so neither can drift from the other. The
   * table's append-only trigger raises on every UPDATE and on every DELETE of
   * a row at or after `tezusta.location_retention` — see
   * `0015_master_locations.sql` for why the exception is a cutoff rather than
   * an on/off flag. `set_config(..., true)` is the `SET LOCAL` form, so the
   * permission never outlives the transaction and no pooled connection carries
   * it into the next request; an admin console, a stray script or a later
   * migration still hits the same wall `order_status_history` puts up, and so
   * does the caller the moment it aims at a row the window still covers.
   *
   * **One evaluation, used twice.** The cutoff is computed, published and read
   * back in a single statement, and the caller's DELETE then filters on the
   * text that came back rather than re-deriving it — so the value the trigger
   * tests each row against and the value the `WHERE` clause selects on are the
   * same string, not two expressions that agree today.
   *
   * Takes a {@link Transaction} rather than a `DatabaseExecutor`: outside a
   * transaction the `SET LOCAL` would apply to nothing and the DELETE would
   * raise, so the illegal state is not representable.
   */
  private async publishRetentionCutoff(tx: Transaction): Promise<string> {
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

    return cutoff;
  }

  /**
   * Masters available **now**, counted by grid cell (EPIC 13, issue #246) —
   * the supply half of the operational dashboard.
   *
   * "Available" is dispatch's own definition minus the job-specific terms:
   * active, not deleted, switched on, and a position inside the freshness
   * window. Each master counts once, in the cell of their latest position,
   * served by `master_locations_master_recent_idx`. Only counts leave this
   * method — never a position (ADR-0043 § 7; location is PII).
   */
  async countAvailableByCell(input: {
    readonly maxPositionAgeSeconds: number;
    readonly cellDegrees: number;
    readonly topAreas: number;
  }): Promise<{ total: number; cells: { lat: number; lng: number; count: number }[] }> {
    const { maxPositionAgeSeconds, cellDegrees, topAreas } = input;
    const latest = sql`
      select distinct on (ml.master_id) ml.master_id, ml.position
        from master_locations ml
        join masters m on m.id = ml.master_id
       where ml.recorded_at > now() - make_interval(secs => ${maxPositionAgeSeconds}::int)
         and m.deleted_at is null
         and m.verification_status = 'active'
         and m.is_available
       order by ml.master_id, ml.recorded_at desc, ml.id desc`;

    const cells = (
      await this.db.execute<{ lat: number; lng: number; count: number }>(sql`
        with latest as (${latest})
        select (ST_Y(ST_SnapToGrid(position, ${cellDegrees})) + ${cellDegrees}::float8 / 2)::float8 as lat,
               (ST_X(ST_SnapToGrid(position, ${cellDegrees})) + ${cellDegrees}::float8 / 2)::float8 as lng,
               count(*)::int as count
          from latest
         group by 1, 2
         order by count desc, 1, 2
         limit ${topAreas}`)
    ).rows;
    const total =
      (
        await this.db.execute<{ total: number }>(
          sql`with latest as (${latest}) select count(*)::int as total from latest`,
        )
      ).rows[0]?.total ?? 0;
    return { total, cells };
  }
}
