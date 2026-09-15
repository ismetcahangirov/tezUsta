---
name: database-migration
description: Use when changing the TezUsta database schema — Drizzle schema edits, generating and reviewing migrations, PostGIS spatial columns and indexes, and safe rollout. Triggers on "add table", "add column", "migration", "schema change", "index", or any edit under apps/api/src/infra/database.
---

# Change the database schema

PostgreSQL 17 + PostGIS 3.5 + Drizzle. Reference:
`docs/architecture/database-architecture.md`, `ADR-0003`.

## The rule that matters most

**`drizzle-kit generate` produces a draft, not a finished migration.**

It regularly emits `DROP COLUMN` + `ADD COLUMN` where a **rename** was intended.
Applied unreviewed, that silently destroys a column of production data.

**Read every generated migration line by line before committing it.**

## Procedure

`pnpm --filter api <binary>` runs a **script** named `<binary>` in that
workspace and fails with a missing-script error. Running a workspace's installed
binary needs `exec`:

```bash
# 1. Edit the schema in apps/api/src/infra/database/schema/
# 2. Generate the draft
pnpm --filter api exec drizzle-kit generate

# 3. READ IT. Look specifically for:
#    - DROP COLUMN that should be a rename
#    - DROP TABLE
#    - NOT NULL added without a default on a populated table
#    - a type change that truncates

# 4. Apply locally and test
pnpm --filter api exec drizzle-kit migrate
pnpm --filter api test
```

`apps/api` does not exist on disk yet — it lands with its Epic. Until it does,
these commands have nothing to run against.

## Conventions

| Rule         |                                                      |
| ------------ | ---------------------------------------------------- |
| Tables       | `snake_case`, plural                                 |
| Primary keys | `uuid` (v7 — time-ordered, indexes well)             |
| Timestamps   | **`timestamptz` always**, never naive                |
| Audit        | `created_at`, `updated_at` on every table            |
| Soft delete  | `deleted_at` where history must survive              |
| Money        | **integer minor units** (`bigint`). Never a float.   |
| FK delete    | **`ON DELETE RESTRICT`** by default, never `CASCADE` |

**Why not `CASCADE`:** a cascade that silently removes a customer's order history
during a support action is unrecoverable. Make deletion fail loudly.

**Why integer money:** binary floating point cannot represent 0.10. Store `1500`,
render `15.00 AZN`.

**`orders.price_minor` is nullable, and that is deliberate.** It is null while
the order is `SEARCHING` and is written in the accept transaction together with
`master_id` (`ADR-0013`). A `NOT NULL` constraint on it would be wrong, and so
would a default of `0` — the price does not exist until a master accepts.

## PostGIS

Native in Drizzle — verified against the shipped package, despite what the docs
page implies:

```ts
import { geometry, index } from 'drizzle-orm/pg-core';

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

`CREATE EXTENSION IF NOT EXISTS postgis;` belongs in the **first** migration.

### Spatial queries

```sql
-- ✅ uses the GiST index
WHERE ST_DWithin(position::geography, $1::geography, $radius)

-- ❌ computes for every row; no index
WHERE ST_Distance(position, $1) < $radius
```

Cast to `::geography` for true metres. **Never** load all masters and compute
distance in Node — that is a full table scan plus an in-process sort.

## Indexes

**Postgres does not index foreign keys automatically.** Add one for every FK.

A query added to a hot path without an index is an **incomplete change**. Verify:

```sql
EXPLAIN (ANALYZE, BUFFERS) <your query>;
```

A `Seq Scan` on a table that grows is a defect.

On a large table, add indexes `CONCURRENTLY` — a plain `CREATE INDEX` takes a
write lock.

## Constraints belong in the database

Application checks race; constraints do not.

```sql
-- a master holds at most one active order
CREATE UNIQUE INDEX orders_one_active_per_master
  ON orders (master_id)
  WHERE status IN ('ACCEPTED','MASTER_ON_THE_WAY','MASTER_ARRIVED','IN_PROGRESS');

CHECK (amount_minor >= 0)
```

## Safe rollout

Migrations run **before** the new code, and during a rolling deploy **both
versions are live simultaneously**. So every migration must be backward-compatible
with the currently-running code.

Destructive changes are **two releases**:

1. Release A — stop reading/writing the column; migration adds the new one.
2. Release B — migration drops the old column.

Adding a `NOT NULL` column to a populated table is also two steps: add nullable
with a backfill, then add the constraint.

## Never

- Apply a generated migration without reading it
- Edit a migration that has been applied anywhere shared
- Use `CASCADE` deletes by default
- Store money as `float`/`double precision`
- Store image bytes in Postgres (use object storage — `ADR-0005`)
- Add a hot-path query with no index

## Before finishing

```bash
pnpm verify
```

- [ ] Generated migration read line by line
- [ ] No unintended drop or truncation
- [ ] Every new FK indexed
- [ ] New hot-path queries `EXPLAIN`-checked
- [ ] Backward-compatible with the currently-deployed code
- [ ] Tested against a real Postgres+PostGIS container
