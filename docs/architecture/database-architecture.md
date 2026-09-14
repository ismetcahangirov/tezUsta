# Database architecture

PostgreSQL 17 + PostGIS 3.5, via Drizzle ORM. Rationale:
[ADR-0003](../decisions/ADR-0003-database-and-geo.md).

## Conventions

| Rule         | Detail                                                   |
| ------------ | -------------------------------------------------------- |
| Tables       | `snake_case`, plural — `order_status_history`            |
| Primary keys | `uuid` (v7 preferred — time-ordered, so it indexes well) |
| Timestamps   | `timestamptz`, always. Never a naive timestamp.          |
| Audit fields | `created_at`, `updated_at` on every table                |
| Soft delete  | `deleted_at timestamptz` where history must survive      |
| Money        | integer **minor units** (`bigint`). Never a float.       |
| Enums        | Postgres `enum` for closed sets (order status, roles)    |
| Booleans     | Named positively — `is_active`, not `is_not_disabled`    |

**Why `timestamptz` always:** a naive timestamp is ambiguous the moment a second
timezone touches the data, and reconstructing the intended instant afterwards is
guesswork.

**Why integer money:** binary floating point cannot represent 0.10 exactly.
Summing commission over thousands of orders in `double precision` produces
figures that do not reconcile. Store `1500` and render `15.00 AZN`.

## Entity model

The brief lists candidate tables. They are a **starting point for domain
analysis, not a schema to implement verbatim** — the final shape is designed in
EPIC 1 and EPIC 6.

```
users ─────┬──── customers ──── addresses
           │           │
           │           └──── orders ──┬── order_items
           │                    │     ├── order_status_history
           └──── masters ───────┘     ├── reviews
                   │                  └── payments (EPIC 12)
                   ├── master_services ──── services ──── service_categories
                   ├── master_locations
                   └── devices ──── notifications
```

### Decisions already settled

**`users` is separate from `customers` / `masters`.** One person may be both
(see [`../product/user-roles.md`](../product/user-roles.md)). A single `role`
column on `users` would force duplicate accounts and split one person's history.

**`order_status_history` is append-only.** It is the audit trail for a system
where money and access to someone's home are at stake. `orders.status` is the
current value; the history is the record of how it got there.

**`master_locations` is append-only and retention-bounded.** Precise location
history is sensitive personal data ([`../engineering/security.md`](../engineering/security.md)).
Keep the current position hot, age out the trail on a schedule. "Keep everything
forever" is a liability, not a feature.

**`devices` is separate from `users`.** Push tokens are per-device and expire;
one user has several. Storing a token on `users` breaks the moment they own two
phones.

### Not yet created

`payments`, `subscriptions`, `subscription_plans`, `commission_rules`,
`master_wallets`, `payouts` — deliberately absent until EPIC 12/14. Designing a
wallet before the cash-vs-card question is answered
([ADR-0007](../decisions/ADR-0007-payments.md)) would be designing for a guess.

## Integrity rules

Constraints belong in the database. Application-level checks race; database
constraints do not.

| Rule                                                      | Mechanism                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------------- |
| An order has at most one active assigned master           | Partial unique index on `(master_id) WHERE status IN (active statuses)` |
| A review requires a completed order between those parties | FK + a check, plus service-level validation                             |
| A master offers a service only from the catalogue         | FK `master_services.service_id → services.id`                           |
| An order's status is a known value                        | Postgres `enum`                                                         |
| Money is never negative where that is meaningless         | `CHECK (amount >= 0)`                                                   |
| Deleting a user does not orphan orders                    | `ON DELETE RESTRICT` + soft delete                                      |

**Use `ON DELETE RESTRICT` by default, not `CASCADE`.** A cascade that silently
removes a customer's order history during a support action is unrecoverable.
Make deletion fail loudly and handle it explicitly.

## Indexing

Every foreign key gets an index — Postgres does **not** create one automatically,
and the omission shows up as a slow join much later.

| Index                                         | Why                                       |
| --------------------------------------------- | ----------------------------------------- |
| GiST on `master_locations.position`           | The nearby-masters query. Non-negotiable. |
| `orders (status, created_at)`                 | Dispatch queue scans                      |
| `orders (customer_id, created_at DESC)`       | Customer order history                    |
| `orders (master_id, created_at DESC)`         | Master order history                      |
| `order_status_history (order_id, created_at)` | Audit reads                               |
| `master_services (service_id, master_id)`     | Matching filter                           |
| Unique on `users.phone`                       | Identity                                  |
| `devices (user_id) WHERE revoked_at IS NULL`  | Push fan-out                              |

**Rule: a query added to a hot path without an index is an incomplete change**
(CLAUDE.md §12). Check with `EXPLAIN (ANALYZE, BUFFERS)` — a `Seq Scan` on a
growing table is a defect.

## The nearby-masters query

This is the query the product depends on.

```sql
SELECT m.id,
       ST_Distance(ml.position::geography, $1::geography) AS distance_m
FROM masters m
JOIN master_services ms ON ms.master_id = m.id AND ms.service_id = $2
JOIN LATERAL (
  SELECT position
  FROM master_locations
  WHERE master_id = m.id
  ORDER BY recorded_at DESC
  LIMIT 1
) ml ON TRUE
WHERE m.verification_status = 'verified'
  AND m.is_available = TRUE
  AND ST_DWithin(ml.position::geography, $1::geography, $3)
ORDER BY distance_m
LIMIT 20;
```

Points:

- `ST_DWithin` uses the **GiST index**; `ST_Distance` in a `WHERE` clause would
  not.
- `::geography` gives true great-circle metres, not degrees.
- The `LATERAL` subquery takes each master's latest position without loading the
  whole history.
- Filters are applied before distance ordering.

**Forbidden:** loading all masters and computing distance in Node. That is a
full table scan plus an application-level sort, and it does not survive growth
(CLAUDE.md §12).

**Likely optimisation later:** keep current positions in Redis and use Postgres
as the durable record. Do that when measurement shows it is needed, not before.

## Migrations

Generated by `drizzle-kit`, **reviewed by hand, always.**

`drizzle-kit generate` produces a _draft_. It can emit a `DROP COLUMN` +
`ADD COLUMN` where a rename was intended — which silently destroys a column of
production data. **Never apply a generated migration unreviewed**
([ADR-0003](../decisions/ADR-0003-database-and-geo.md)).

Rules:

- Migrations are committed, forward-only, and never edited after being applied
  anywhere shared.
- `CREATE EXTENSION IF NOT EXISTS postgis;` is in the first migration.
- Destructive changes are two-step: deploy code that stops using the column,
  then drop it in a later release.
- Add indexes `CONCURRENTLY` on large tables — a plain `CREATE INDEX` takes a
  write lock.
- Every migration is tested against a disposable Postgres+PostGIS container
  before it reaches a shared environment.

## Transactions

- A service method that writes more than one table owns a transaction.
- Transactions are **short**. Never hold one across an HTTP call to a payment or
  maps provider — that ties a database connection to a third party's latency.
- The default isolation level is sufficient for the order flow because
  correctness comes from the conditional `UPDATE`
  ([`backend-architecture.md`](backend-architecture.md)), not from isolation.
- Never open a transaction in a controller.
