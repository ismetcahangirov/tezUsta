import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Forward-geocoding results, keyed by the normalised address text.
 *
 * **This table is the single largest lever on the Google Maps bill**
 * (`docs/architecture/location-services.md`). The same Baku addresses recur
 * constantly — one apartment block generates the same lookup from every
 * neighbour who installs the app — so without it the invoice grows with traffic
 * rather than with distinct addresses.
 *
 * **It stores coordinates and a place id, and deliberately nothing else.** That
 * is a licence boundary, not a schema preference. Google's Maps Service
 * Specific Terms §6.3.1 permit caching "latitude (lat) and longitude (lng)
 * values from the Geocoding API for up to 30 consecutive calendar days"; §6.3.2
 * permits keeping `formatted_address` and the structured components
 * indefinitely, but only "solely to support the direct, End User facing
 * functionality" and only where the cached data is "logically isolated to the
 * specific End User it is associated with and must not be used across multiple
 * End Users". A shared table read by every customer is exactly what that
 * excludes, so the prose stays out of it.
 *
 * The same clause is why **reverse geocoding has no cache at all**: its output
 * *is* the prose. A customer's reverse lookup is instead written straight into
 * their own `addresses` row, which is the per-end-user use §6.3.2 describes.
 */
export const geocodeCache = pgTable(
  'geocode_cache',
  {
    /**
     * The output of `normaliseAddress`, not the text the customer typed.
     * `"28 May küç., 5"` and `"28 may küç 5"` are one door and must be one row
     * — a cache keyed on raw input misses on a trailing space, which is to say
     * it misses most of the time.
     */
    normalisedAddress: text('normalised_address').primaryKey(),

    latitude: doublePrecision('latitude').notNull(),
    longitude: doublePrecision('longitude').notNull(),

    /**
     * Cacheable indefinitely and across users, unlike the coordinates beside
     * it — the terms treat a place id as an identifier rather than as content.
     * Null when the provider has no such concept.
     */
    placeId: text('place_id'),

    /**
     * When this row must stop being served. Bounded by `GEOCODE_CACHE_TTL_DAYS`,
     * which the environment schema caps at 30 because §6.3.1 does.
     *
     * A read treats an expired row as a miss rather than deleting it, so the
     * refresh is one UPSERT on the path that was already calling the provider.
     * Bounding the table is a separate, periodic delete — a job that has not
     * been written yet, and the one loose end this table leaves.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    /**
     * For the sweep that deletes expired rows, and only for that. Lookups go
     * through the primary key, which already indexes the only other access
     * path this table has.
     *
     * Note there is no partial index predicated on `now()`: Postgres requires
     * an index predicate to be immutable, and `now()` is not — a partial index
     * is simply not available for "the expired ones", however natural it reads.
     */
    index('geocode_cache_expires_at_idx').on(table.expiresAt),

    /**
     * A point on Earth. The values come from an external service, which is
     * exactly the kind of input that should not be trusted into a column other
     * code will later hand to PostGIS.
     */
    check(
      'geocode_cache_point_on_earth',
      sql`${table.latitude} between -90 and 90 and ${table.longitude} between -180 and 180`,
    ),

    /**
     * No row may outlive the licence. The environment schema caps the
     * configured TTL at 30 days; this catches the other way in — a row written
     * by a script, a fixture, or a future code path that forgot.
     *
     * Anchored to `updated_at`, not `created_at`, and that is the load-bearing
     * detail. §6.3.1 permits caching a value for thirty days *from when it was
     * cached*, and a refresh caches it again: a row first written in January
     * and re-fetched in March is thirty days old, not sixty. Anchoring to
     * `created_at` would instead make every long-lived key fail its own check
     * on the first refresh past the window — a constraint violation on the
     * happy path. `GeocodeCacheRepository.put` writes `updated_at` explicitly
     * on both branches of the upsert so this always compares against the write
     * that actually happened.
     */
    check(
      'geocode_cache_licence_ttl',
      sql`${table.expiresAt} <= ${table.updatedAt} + interval '30 days'`,
    ),
  ],
);

export type GeocodeCacheRow = typeof geocodeCache.$inferSelect;
export type NewGeocodeCacheRow = typeof geocodeCache.$inferInsert;
