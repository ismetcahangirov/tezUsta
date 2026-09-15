# ADR-0018 — The spatial index is built on the `geography` cast

- **Status:** **Accepted**
- **Date:** 2026-09-15
- **Supersedes:** the index clause of
  [ADR-0003](ADR-0003-database-and-geo.md) — `index('master_locations_position_idx').using('gist', t.position)`.
  The decision itself (PostgreSQL 17 + PostGIS 3.5 + Drizzle, positions as
  `geometry(Point, 4326)`, nearby lookups by `ST_DWithin` against a GiST index)
  is unchanged. Only the expression the index is built on changes.

## Context

ADR-0003 chose PostGIS specifically so the nearby-masters query touches an
index instead of every row, and said so in as many words: "A GiST index answers
`ST_DWithin` directly." It then gave a snippet placing the index on the bare
column:

```ts
(t) => [index('master_locations_position_idx').using('gist', t.position)],
```

The canonical query in
[`database-architecture.md`](../architecture/database-architecture.md) § The
nearby-masters query casts to `geography`, because `geography` is what gives
true great-circle metres rather than degrees:

```sql
AND ST_DWithin(ml.position::geography, $1::geography, $3)
```

Those two do not fit together, and nothing in the toolchain says so. Postgres
does not warn, `EXPLAIN` has to be asked, and the table is small enough during
development that a sequential scan looks fine. The mismatch would have
surfaced in production, on the one query the product cannot function without.

`apps/api` was the first workspace able to test this against a real database
(EPIC 1, issue #22), which is why it surfaced now.

## Decision

**The GiST index is built on the expression the query actually evaluates,
`(position::geography)`, not on `position`.**

```ts
(t) => [
  index('master_locations_position_idx').using('gist', sql`(${t.position}::geography)`),
],
```

The column type stays `geometry('position', { type: 'point', mode: 'xy', srid: 4326 })`.

## Why

PostGIS registers a **separate operator class** for `geography`. A GiST index
over a `geometry` column supports geometry-typed operators only, so a
`geography`-cast predicate cannot use it and the planner falls back to a
sequential scan.

Measured on this stack — PostgreSQL 17.5, PostGIS 3.5, 50 000 points,
`EXPLAIN (ANALYZE, BUFFERS)`:

| Index                         | Plan              | Time       |
| ----------------------------- | ----------------- | ---------- |
| `gist(position)`              | **Seq Scan**      | **824 ms** |
| `gist((position::geography))` | Bitmap Index Scan | **2.0 ms** |

Roughly 400× on a table that is a small fraction of the size the master pool
is meant to reach, on a query that runs on the critical path of every order.
CLAUDE.md §12 calls an unindexed query on a hot path a defect; this is that
defect, written into an accepted ADR.

`apps/api/test/database.geometry.test.ts` pins the behaviour: it forces
`enable_seqscan = off` inside a transaction so a tiny table cannot pass by cost
accident, and asserts the index name appears in the plan.

## Alternatives considered

| Option                                                        | Why not                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store a `geography(Point, 4326)` column and index it plainly  | Works — measured, the index is used. But `drizzle-orm@0.45.2` ships **no `geography` column helper**; `pg-core/columns/postgis_extension/` contains `geometry.*` and nothing else. It would need a `customType`, for no measured gain. |
| Keep `gist(position)` and drop the cast, comparing in degrees | Wrong answers. A degree of longitude is ~85 km at Baku's latitude and ~111 km at the equator, so a "3000" radius would not be metres and would not be the same distance in two places.                                                 |
| Index both the column and the cast                            | The bare-column index serves no query we have. An unused index still costs every write, and `master_locations` is append-only under a location-update budget — it is the write-heaviest table in the system.                           |
| Leave ADR-0003 alone and fix only the architecture docs       | This is what issue #22 originally did. The ADR is what EPIC 6 reads when it creates `master_locations`, so the trap would stay armed exactly where it gets copied from.                                                                |

## Trade-offs accepted

- **An expression index is easier to break than a column index.** It only
  applies when the query's expression matches it. If a later query writes
  `ST_DWithin(position, ...)` without the cast, or casts to a different type,
  this index will not serve it and there will be no error — only a slower plan.
  The mitigation is the rule already in CLAUDE.md §12: read the query plan for
  a hot-path query, and treat a `Seq Scan` on a growing table as a defect.
- **The Drizzle form needs a `sql` template**, so it is slightly less readable
  than `using('gist', t.position)` and cannot be generated by `drizzle-kit`
  from the column definition alone.
- **`drizzle-kit generate` will not produce this index**, which reinforces the
  existing rule that a generated migration is a draft to be read line by line
  ([ADR-0003](ADR-0003-database-and-geo.md), CLAUDE.md §14).

## Consequences

- EPIC 6 creates `master_locations` with the index in the form above.
- [`database-architecture.md`](../architecture/database-architecture.md) and
  [`technology-stack.md`](../architecture/technology-stack.md) § 4.1 carry the
  corrected form and the measurement.
- **Drizzle's `geometry()` ignores its `srid` config.**
  `PgGeometryObject.getSQLType()` in the shipped package emits `geometry(point)`
  with no SRID typmod, whatever the config says. An SRID constraint on the
  column must be written into the migration by hand, or there will not be one.
  This is a separate artifact-versus-documentation gap found at the same time;
  it does not change this decision but it will bite whoever assumes the config
  value reached the database.
- Any future spatial index — a service-area polygon, a geofence — follows the
  same rule: index the expression the query evaluates.

## Revisit when

`drizzle-orm` ships a `geography` column helper. At that point a
`geography`-typed column with a plain GiST index is the simpler shape, and this
ADR's trade-off (an expression index that a mismatched query silently bypasses)
stops being necessary. Re-measure before switching — the measurement above is
the standard, not the reasoning.
