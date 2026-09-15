# ADR-0003 — PostgreSQL + PostGIS + Drizzle ORM

- **Status:** Accepted
- **Superseded in part by:** [ADR-0018](ADR-0018-spatial-index-on-the-geography-cast.md) —
  the index clause below, `index('master_locations_position_idx').using('gist', t.position)`.
  Measured: that form produces a sequential scan for the `geography`-cast
  `ST_DWithin` this ADR exists to accelerate. The decision itself — PostgreSQL
  - PostGIS + Drizzle, `geometry(Point, 4326)`, `ST_DWithin` against a GiST
    index — is unchanged.
- **Date:** 2026-09-14
- **Supersedes:** —
- **Superseded by:** —

## Context

TezUsta's defining query runs on every order:

> Find verified, currently-available masters who offer service X, within N metres
> of this coordinate, ordered by distance.

This query determines whether the product works. It runs on the critical path of
order creation, it must stay fast as the master pool grows, and it must be
correct. Everything else in the data layer is ordinary marketplace CRUD.

We need to choose a database, a spatial strategy, and an ORM.

## Decision

**PostgreSQL 17 + PostGIS 3.5, accessed through Drizzle ORM 0.45.2.**

Master positions are stored as a PostGIS `geometry(Point, 4326)` column with a
**GiST index**. Nearby lookups use `ST_DWithin` against that index.

```ts
export const masterLocations = pgTable(
  'master_locations',
  {
    masterId: uuid('master_id')
      .notNull()
      .references(() => masters.id),
    position: geometry('position', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('master_locations_position_idx').using('gist', t.position)],
);
```

`CREATE EXTENSION IF NOT EXISTS postgis;` belongs in the first migration.

## Why PostgreSQL

One database that does relational integrity, transactions, and geospatial
indexing well. An order's lifecycle has hard consistency requirements — a master
must not be assigned to two active orders — which is a job for transactions and
constraints, not eventual consistency.

## Why PostGIS rather than hand-rolled distance

The alternative is a bounding-box prefilter plus Haversine in application code.
Rejected for two reasons:

1. **It does not use an index.** Filtering `lat BETWEEN ... AND lng BETWEEN ...`
   can use a B-tree, but the result is a coarse box that still loads far too many
   rows, and the final distance sort happens in Node over the whole candidate
   set. A GiST index answers `ST_DWithin` directly.
2. **It is subtly wrong.** Degrees of longitude shrink with latitude, so a naive
   box is not a circle. Bugs of this shape produce a dispatch radius that is
   quietly wrong rather than obviously broken.

PostGIS costs one extension and gives correct great-circle distance with an
index. There is no version of this trade-off where hand-rolling wins.

**CLAUDE.md §12 states the rule that follows from this: never compute distance
by loading all masters and sorting in Node.**

## Why Drizzle ORM

SQL-first. The spatial query above is genuinely a SQL query, and Drizzle lets
raw SQL compose into the typed query builder rather than fighting an abstraction
that wants to hide SQL. It also ships no separate query engine binary, which
keeps the API container small and its startup fast.

### PostGIS support is native — verified against the package, not the docs

The Drizzle documentation page for Postgres column types reads as though PostGIS
requires a custom type. **That reading is wrong**, and acting on it would have
produced a worse schema. Inspecting the published tarball settles it:

```
drizzle-orm@0.45.2 → pg-core/columns/postgis_extension/geometry.d.ts

export interface PgGeometryConfig<T extends 'tuple' | 'xy'> {
  mode?: T;
  type?: 'point' | (string & {});
  srid?: number;
}
export declare function geometry(name, config?): ...
```

`pg-core/indexes` supports `gist`. Both halves of the requirement are first-class.

This episode is the origin of the rule in CLAUDE.md §9: **when a document and
the shipped artifact disagree, the artifact wins.**

## Alternatives considered

| Option                                | Why not                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Prisma**                            | Better DX for plain CRUD, but historically awkward with PostGIS and raw spatial SQL, and it adds a query engine to the runtime. The one query that matters most would be the one fought hardest. |
| **TypeORM**                           | Mature and PostGIS-capable, but weaker typing and a migration story that has caused real production pain.                                                                                        |
| **Kysely**                            | Philosophically very close to Drizzle. Drizzle wins on schema-as-code and integrated migration tooling.                                                                                          |
| **MongoDB + geospatial index**        | Has `2dsphere`, but the order lifecycle needs transactional integrity and foreign keys that a document store makes harder.                                                                       |
| **Postgres `cube` + `earthdistance`** | Lighter than PostGIS, but less accurate, less capable, and no better supported by Drizzle.                                                                                                       |
| **Redis GEO commands**                | Fast, but Redis holds no permanent business data in this architecture (CLAUDE.md §11). Usable later as a cache in front of Postgres, not as the source of truth.                                 |

## Trade-offs accepted

- **Drizzle is pre-1.0.** Its API still changes between minors. Mitigated by
  pinning an exact version and reviewing the changelog before any bump.
- **Generated migrations must be reviewed by hand.** `drizzle-kit generate`
  produces a draft, not a finished artifact. It can emit a destructive column
  drop where a rename was intended. **Never apply a generated migration
  unreviewed.**
- **PostGIS raises the operational bar.** The managed Postgres provider must
  support the extension — confirm this before choosing a host.
- **Drizzle's `geometry` type is less discoverable than a documented feature
  should be.** Noted here so the next person does not repeat the investigation.

## Consequences

- Schema is TypeScript, versioned in the repository; migrations are generated
  from it and reviewed as code.
- The nearby-masters query has an index from day one, not after a performance
  incident.
- Any managed Postgres candidate must be checked for PostGIS support.
- Location history is append-only, which makes it both an audit trail and a
  retention question — see `docs/engineering/security.md` on location as PII.

## Revisit when

- Drizzle reaches 1.0 (evaluate the migration path).
- The master pool grows large enough that a single Postgres instance is a
  bottleneck — at which point the answer is read replicas and a Redis presence
  cache, not a different database.
