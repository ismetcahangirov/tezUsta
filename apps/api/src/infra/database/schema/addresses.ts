import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  geometry,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { customers } from './customers';

/**
 * Where the work happens.
 *
 * **The structured columns are a product requirement, not a nicety**
 * (`docs/architecture/location-services.md` § Azerbaijani addresses). A
 * coordinate is frequently not enough to find a door in Baku, and a master who
 * arrives with only a pin spends the saved geocoding call on a phone call
 * instead. `entrance` — `giriş`, the separate stairwell of a Soviet-era block —
 * is the field that most often decides whether the last hundred metres take
 * one minute or ten.
 *
 * They are `text`, not integers, because that is what they are here: an
 * entrance is "2" but also "B", an apartment is "48" but also "48A". A numeric
 * column would force the customer to leave the field blank, which is the
 * failure this table exists to prevent.
 */
export const addresses = pgTable(
  'addresses',
  {
    id: uuid('id').primaryKey(),

    /**
     * The **customer profile**, not the user. An address belongs to the role
     * that orders work; the same person acting as a master has no addresses,
     * and the day EPIC 5 gives masters a service area it will be its own
     * column on its own table.
     */
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),

    label: text('label'),
    formattedAddress: text('formatted_address').notNull(),
    building: text('building'),
    entrance: text('entrance'),
    floor: text('floor'),
    apartment: text('apartment'),
    landmarkNote: text('landmark_note'),

    /**
     * WGS 84, and the SRID is **written into the migration by hand**.
     *
     * Drizzle's `geometry()` ignores its own `srid` config — the shipped
     * `PgGeometry.getSQLType()` in `drizzle-orm@0.45.2` returns the literal
     * string `geometry(point)` whatever this object says
     * ([ADR-0018](docs/decisions/ADR-0018-spatial-index-on-the-geography-cast.md)).
     * The generated DDL is therefore edited to `geometry(Point,4326)` so the
     * database, not a convention, is what guarantees every row is in the same
     * reference system.
     *
     * That has a consequence on the write path: `mapToDriverValue` emits
     * `point(x y)`, which Postgres reads as SRID 0 and the typmod then
     * rejects. So inserts and updates write this column through an explicit
     * `ST_SetSRID(ST_MakePoint(lng, lat), 4326)` — see
     * `AddressesRepository.positionValue`. Reads still go through Drizzle's
     * mapper, whose `parseEWKB` skips the SRID field Postgres now returns.
     *
     * **There is deliberately no GiST index here.** ADR-0018's rule is to
     * index the expression a query evaluates, and no query evaluates a
     * distance against this table: matching ranks masters by proximity using
     * `master_locations`, and an address is only ever fetched by its owner. A
     * spatial index would cost a write on every saved address to answer a
     * question nobody asks. Add it with the query that needs it, not before.
     */
    position: geometry('position', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),

    isDefault: boolean('is_default').notNull().default(false),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    /**
     * Soft delete. An order references the address it was placed for, and a
     * customer tidying their address list must not rewrite the history of work
     * already done there.
     */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    /**
     * The foreign key's index. Postgres does not create one automatically
     * (`docs/architecture/database-architecture.md`), and this is the only
     * shape anything reads this table in: "the live addresses of one customer,
     * default first". Carrying `is_default` and `created_at` means the list
     * endpoint's ordering comes out of the index rather than out of a sort.
     */
    index('addresses_customer_live_idx')
      .on(table.customerId, table.isDefault.desc(), table.createdAt.desc())
      .where(sql`${table.deletedAt} is null`),

    /**
     * **One default per customer, decided by the database.**
     *
     * A partial unique index is what makes "at most one" impossible to
     * violate — including by two requests that each promote a different
     * address in the same millisecond, which is the case an application-level
     * check loses (`docs/architecture/database-architecture.md`: "Constraints
     * belong in the database. Application-level checks race; database
     * constraints do not").
     *
     * The other half — that a customer with addresses always has *at least*
     * one default — is not expressible as an index and lives in
     * `AddressesService`: the first address is promoted on creation, and
     * deleting the default promotes the oldest survivor.
     *
     * `deleted_at is null` belongs in the predicate because a soft-deleted row
     * keeps whatever `is_default` it had; without it, a customer could not
     * promote a replacement for the address they just deleted.
     */
    uniqueIndex('addresses_one_default_per_customer')
      .on(table.customerId)
      .where(sql`${table.isDefault} and ${table.deletedAt} is null`),

    /**
     * The same bounds the Zod schema applies, restated where a seed script or
     * an admin tool cannot bypass them. `btrim` so a field of spaces is the
     * empty field it actually is, and `length` counts characters rather than
     * bytes so an Azerbaijani name is not shorter for containing a diacritic.
     */
    check(
      'addresses_text_lengths',
      sql`length(btrim(${table.formattedAddress})) between 1 and 300
        and (${table.label} is null or length(btrim(${table.label})) between 1 and 40)
        and (${table.building} is null or length(btrim(${table.building})) between 1 and 40)
        and (${table.entrance} is null or length(btrim(${table.entrance})) between 1 and 40)
        and (${table.floor} is null or length(btrim(${table.floor})) between 1 and 40)
        and (${table.apartment} is null or length(btrim(${table.apartment})) between 1 and 40)
        and (${table.landmarkNote} is null or length(btrim(${table.landmarkNote})) between 1 and 300)`,
    ),

    /**
     * A point on Earth, checked in the database because the write path is raw
     * SQL rather than a Drizzle value — the one place where a bug could put a
     * longitude in the latitude slot and nothing else would notice. In Baku
     * (≈40.4 N, 49.9 E) both numbers are in range for each other, so this
     * catches only the out-of-range case; the ordering is pinned by a
     * round-trip test asserting `ST_X` is the longitude.
     */
    check(
      'addresses_position_on_earth',
      sql`ST_X(${table.position}) between -180 and 180 and ST_Y(${table.position}) between -90 and 90`,
    ),
  ],
);

export const addressesRelations = relations(addresses, ({ one }) => ({
  customer: one(customers, { fields: [addresses.customerId], references: [customers.id] }),
}));

export type AddressRow = typeof addresses.$inferSelect;
export type NewAddressRow = typeof addresses.$inferInsert;
