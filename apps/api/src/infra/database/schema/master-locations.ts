import { relations, sql } from 'drizzle-orm';
import { check, geometry, index, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { masters } from './masters';

/**
 * Where a master is, and where they have been for the last little while.
 *
 * This is the table the product's defining query reads
 * ([ADR-0003](docs/decisions/ADR-0003-database-and-geo.md)): "verified,
 * available masters who offer service X, within N metres of this coordinate".
 * Everything below exists to make that query correct, fast, and no more
 * revealing than it has to be.
 *
 * **It is also the most sensitive table in the schema.** A precise position
 * history is personal data of the kind that does not degrade — knowing where
 * somebody was last Tuesday at 19:40 stays as sensitive as it was that
 * evening (`docs/engineering/security.md` § PII and privacy). Two properties
 * follow from that and are enforced here rather than promised:
 *
 * - **Append-only.** A trail that can be edited is not evidence, and one that
 *   can be quietly deleted row by row is not an audit trail either. An UPDATE
 *   or an ordinary DELETE raises, by trigger, the same way
 *   `order_status_history` and `master_verification_history` do.
 * - **Retention-bounded, from two directions.**
 *   `docs/architecture/database-architecture.md` is blunt that "keep
 *   everything forever is a liability, not a feature". The write path prunes
 *   the reporting master's own trail inside the transaction that appends to it
 *   (`MasterLocationRepository.record`), which is what caps an *active*
 *   master's history no matter how long they work. The elapsed-time sweep
 *   (`MasterLocationRepository.sweepExpiredTrails`, #105) is the floor under
 *   the master who stopped reporting and never came back — nothing runs on
 *   their behalf while they are gone, so without it they keep whatever was
 *   left of their last window indefinitely.
 */
export const masterLocations = pgTable(
  'master_locations',
  {
    /**
     * A surrogate key, where `(master_id, recorded_at)` might look like the
     * natural one. Two reports from the same phone inside the same clock tick
     * are an ordinary consequence of a retry, not a bug to reject with a
     * constraint violation the app cannot act on — and the retention prune
     * needs to name one row without depending on a timestamp being unique.
     */
    id: uuid('id').primaryKey(),

    /**
     * `onDelete: 'restrict'`, like every other reference to a master. Masters
     * are soft-deleted, so a hard delete reaching this row is a mistake, and a
     * failed write is a better answer to a mistake than a cascade that silently
     * erases the trail an order's dispute may depend on.
     */
    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id, { onDelete: 'restrict' }),

    /**
     * WGS 84, with the SRID **written into the migration by hand** — the same
     * situation, and the same remedy, as `addresses.position`.
     * `PgGeometryObject.getSQLType()` in `drizzle-orm@0.45.2` emits the literal
     * `geometry(point)` and ignores the `srid` here entirely
     * ([ADR-0018](docs/decisions/ADR-0018-spatial-index-on-the-geography-cast.md)),
     * so the typmod is corrected in `0015_master_locations.sql`.
     *
     * Writes go through `ST_SetSRID(ST_MakePoint(lng, lat), 4326)` rather than
     * through Drizzle's own value mapper, whose `point(x y)` literal Postgres
     * reads as SRID 0 and the typmod then rejects. Reads are unaffected.
     */
    position: geometry('position', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),

    /**
     * **Server time, not the phone's.** A device clock is settable, often
     * wrong, and on a mid-range Android drifts by minutes; ordering a trail by
     * a value the reporter chooses means the newest row is whichever handset
     * is most confidently mistaken. `recorded_at` is when the API wrote it
     * down, which is the only timestamp two masters' rows can be compared on.
     */
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * **The index the product depends on, and it is on the cast expression.**
     *
     * Non-negotiable per
     * [ADR-0018](docs/decisions/ADR-0018-spatial-index-on-the-geography-cast.md):
     * PostGIS registers a separate operator class for `geography`, so a GiST
     * index over the bare `geometry` column cannot serve the
     * `ST_DWithin(position::geography, …)` the nearby-masters query performs.
     * Postgres does not warn — it simply falls back to a sequential scan.
     * Measured on this stack with 50 000 points: `gist(position)` gave a Seq
     * Scan at 824 ms, `gist((position::geography))` a Bitmap Index Scan at
     * 2.0 ms.
     *
     * `drizzle-kit` cannot generate this form, so the migration carries it by
     * hand and `master-location.e2e.test.ts` asserts the plan actually names
     * this index with `enable_seqscan` forced off — a small table must not be
     * able to pass by cost accident.
     */
    index('master_locations_position_idx').using('gist', sql`(${table.position}::geography)`),

    /**
     * "This master's latest row", which is the `JOIN LATERAL … ORDER BY
     * recorded_at DESC LIMIT 1` in `docs/architecture/database-architecture.md`
     * § The nearby-masters query — run once per candidate master, so a sort of
     * that master's whole trail each time is a cost multiplied by the candidate
     * count on the dispatch path.
     *
     * Descending on `recorded_at` so the LIMIT 1 is the index's first entry
     * rather than its last. It is also the index the retention prune deletes
     * through, and the foreign key's index, which Postgres does not create on
     * its own.
     *
     * **`id` is the third column, and the descending columns are written as
     * `sql` rather than `.desc()`** — both for the same reason, and both
     * measured (#191). `.desc()` builds `DESC NULLS LAST`, which cannot serve
     * the LATERAL's `order by recorded_at desc, id desc`; and an index without
     * `id` serves only the leading key, leaving an `Incremental Sort` for the
     * tiebreaker the query added so that two rows written in one transaction
     * resolve the same way on every run. Either way the LATERAL sorts, once
     * per candidate master, on the dispatch path.
     */
    index('master_locations_master_recent_idx').on(
      table.masterId,
      sql`${table.recordedAt} desc`,
      sql`${table.id} desc`,
    ),

    /**
     * "Every row past the retention cutoff, whoever it belongs to" — the
     * elapsed-time sweep (#105), and the one question the index above cannot
     * answer.
     *
     * `master_locations_master_recent_idx` leads with `master_id`, so a
     * predicate naming only `recorded_at` cannot range-scan it and Postgres
     * falls back to reading the table. **Measured** on this stack rather than
     * assumed (CLAUDE.md §12), 240 960 rows, 5 000 reporting masters inside a
     * 60-minute window plus 20 dormant ones behind it:
     *
     * | Sweep batch of 1 000 | Plan                  | Buffers | Time     |
     * | -------------------- | --------------------- | ------- | -------- |
     * | without this index   | Seq Scan              | 2 975   | 19.1 ms  |
     * | with this index      | Bitmap Index Scan     | 17      | 0.33 ms  |
     * | nothing to sweep, without | Parallel Seq Scan | 2 975   | 20.2 ms  |
     * | nothing to sweep, with    | Bitmap Index Scan | 14      | 0.06 ms  |
     *
     * The bottom two rows are the ones that decided it. In steady state the
     * write-path prune has already retired everything an active master owns,
     * so the sweep's normal outcome is *finding nothing* — and without this
     * index that outcome costs a full scan of the hottest table in the schema,
     * every interval, forever.
     *
     * The write cost is the cheapest a btree has: `recorded_at` defaults to
     * `now()`, so every insert appends at the index's right edge rather than
     * splitting a page in the middle.
     */
    index('master_locations_retention_idx').on(table.recordedAt),

    /**
     * A point on Earth, checked in the database because the write path is raw
     * SQL rather than a Drizzle value — mirroring `addresses_position_on_earth`
     * exactly. It catches the out-of-range case only: in Baku (≈40.4 N,
     * ≈49.9 E) a swapped pair is inside both ranges, and the ordering is
     * pinned instead by a round-trip test asserting `ST_X` is the longitude.
     */
    check(
      'master_locations_position_on_earth',
      sql`ST_X(${table.position}) between -180 and 180 and ST_Y(${table.position}) between -90 and 90`,
    ),
  ],
);

export const masterLocationsRelations = relations(masterLocations, ({ one }) => ({
  master: one(masters, { fields: [masterLocations.masterId], references: [masters.id] }),
}));

export type MasterLocationRow = typeof masterLocations.$inferSelect;
export type NewMasterLocationRow = typeof masterLocations.$inferInsert;
