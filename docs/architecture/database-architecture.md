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

**`master_services` carries a price.** The master sets the price and the platform
takes a commission ([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)).
`services.base_price` is a reference figure; the authoritative price for an order
comes from that master's row.

**Orders freeze their own money values.** `orders.price_minor` is copied **at
accept**, from the accepting master's `master_services` row, and
`orders.commission_rate` at completion — never joined live from
`master_services` or `commission_rules`. A live join would silently rewrite a
finished order's figures every time a master changed their price or the platform
changed its rate, and the first symptom would be a payout dispute with no way to
prove what the numbers had been.

**`orders.price_minor` is nullable, and is null while `SEARCHING`.** Before
accept there is no single price — there is a set of candidate masters whose
prices differ ([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)).
`price_minor` and `master_id` are written together in the accept transaction and
cleared together on re-dispatch. **A `NOT NULL` constraint on `price_minor`
would be wrong**: it would make the `SEARCHING` state unrepresentable, which is
the state most orders spend their first seconds in. Every read of the column
must handle null.

**`orders.redispatch_count`** (integer, default 0) counts how many times the
order returned to `SEARCHING` after an assigned master cancelled. It is capped
by `MAX_ORDER_REDISPATCHES`; at the cap the order becomes `NO_MASTER_FOUND`
rather than searching again
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)).

### Not yet created

`payments`, `subscriptions`, `subscription_plans`, `commission_rules`,
`master_wallets`, `payouts` — absent until EPIC 12/14.

**Note on scope:** now that **both cash and card** are supported
([ADR-0007](../decisions/ADR-0007-payments.md)), a cash order's money never passes
through the platform, so commission becomes a debt the master owes. That implies
`master_wallets` and `commission_rules` are likely needed **with EPIC 12**, not
deferred to EPIC 14. Confirm the scope when EPIC 12 is scheduled — but still do
not create them before then.

## Integrity rules

Constraints belong in the database. Application-level checks race; database
constraints do not.

| Rule                                                      | Mechanism                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A master holds at most one active order                   | Partial unique index on `(master_id) WHERE status IN (active statuses)`                                 |
| An order has at most one assigned master                  | `orders.master_id` is a single nullable column; the accept is a guarded `UPDATE` on `master_id IS NULL` |
| A review requires a completed order between those parties | FK + a check, plus service-level validation                                                             |
| A master offers a service only from the catalogue         | FK `master_services.service_id → services.id`                                                           |
| An order's status is a known value                        | Postgres `enum`                                                                                         |
| Money is never negative where that is meaningless         | `CHECK (amount >= 0)`                                                                                   |
| Deleting a user does not orphan orders                    | `ON DELETE RESTRICT` + soft delete                                                                      |

**The first two rows are converses, and it is easy to state the wrong one.** A
unique index keyed on `(master_id)` can only constrain how many rows share a
master — that is "one master, one active order". It says nothing about how many
masters an order has; that is guaranteed by `master_id` being a single column,
and by the conditional `UPDATE` that fills it
([`backend-architecture.md`](backend-architecture.md) § Concurrent accept).

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

This is the query the product depends on. It answers a **five-part eligibility
predicate**, and every part is load-bearing:

| Eligibility term                              | Where it is evaluated                      |
| --------------------------------------------- | ------------------------------------------ |
| Verified                                      | Postgres — `masters.verification_status`   |
| Online — _intent_                             | Postgres — `masters.is_available`          |
| Online — _liveness_                           | **Redis** — the heartbeat TTL key          |
| Offers this service, and is within the radius | Postgres — `master_services` + PostGIS     |
| Owes no more than `MAX_COMMISSION_DEBT_MINOR` | Postgres — `masters.commission_debt_minor` |

**Postgres alone cannot answer this.** `is_available` records that a master
_toggled_ themselves online; it survives the app being force-quit, the phone
running out of battery, and the process being killed by Android. Liveness is a
TTL heartbeat in Redis, and it expires on its own
([`realtime-architecture.md`](realtime-architecture.md) § Presence). A query
that checks only `is_available` offers work to a phone that is switched off, and
the order sits unaccepted until the dispatch window expires.

So the query runs in **two stages**: PostGIS produces the geographic candidate
set, and the live set from Redis intersects it.

```sql
-- Stage 1: the geographic + business candidate set.
-- $4 is the array of master ids currently holding a live heartbeat in Redis.
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
  AND m.is_available = TRUE                             -- intent
  AND m.id = ANY($4::uuid[])                            -- liveness, from Redis
  AND m.commission_debt_minor <= $5                     -- ADR-0007 debt gate
  AND ST_DWithin(ml.position::geography, $1::geography, $3)
ORDER BY distance_m
LIMIT 20;
```

Passing the live ids in keeps the intersection inside one round trip. Filtering
the result set in Node afterwards is equally correct and is the right shape when
the live set is large — what is **not** acceptable is shipping either stage
alone.

Points:

- `ST_DWithin` uses the **GiST index**; `ST_Distance` in a `WHERE` clause would
  not. The GiST index is non-negotiable regardless of how the liveness set is
  applied.
- `::geography` gives true great-circle metres, not degrees.
- The `LATERAL` subquery takes each master's latest position without loading the
  whole history.
- Filters are applied before distance ordering.
- **The commission-debt gate is required from EPIC 7, not EPIC 12.**
  [ADR-0007](../decisions/ADR-0007-payments.md) says a master carrying too much
  cash-commission debt may not take new work, and the only place that can be
  enforced is the predicate that decides who is offered the order.
  `commission_debt_minor` reads `0` until EPIC 12 populates it, so the term
  costs nothing to ship early — and adding it later means auditing every call
  site that already went to production without it.

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
