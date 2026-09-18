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
| Display text | Localized: `jsonb` keyed by locale, `az` required        |

**Why `timestamptz` always:** a naive timestamp is ambiguous the moment a second
timezone touches the data, and reconstructing the intended instant afterwards is
guesswork.

**Why localized display text is `jsonb`:** which languages TezUsta ships at
launch is an open owner decision (CLAUDE.md §1). A `name text` column, or a
column per language, encodes an answer to that question in the schema, so
answering it later costs a migration and an API change
([ADR-0019](../decisions/ADR-0019-localized-catalogue-names.md)). A map keyed
by locale makes a new language a row edit. `az` is required by a CHECK
constraint, because it is the fallback every read resolves to and a row without
it renders as a blank line in the app with no error anywhere to explain it.

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

### Created so far

EPIC 2 (issue #25) created the first four tables: `users` and `user_roles` for
identity, `sessions` and `refresh_tokens` for the device-session model
([`authentication.md`](authentication.md) § At rest). Issue #29 added a fifth,
`otp_challenges` — the credential a session is opened against.

EPIC 3 (issue #31) added the sixth and seventh: `service_categories` and
`services`, the catalogue an order will reference. Both carry `is_active`
rather than a delete path, because an order placed last month points at a
service and a `DELETE` would either orphan that history or cascade it away.
`services.base_price_minor` is a **reference** figure, not the price of an
order — see § Decisions already settled below — and the pricing shape it
belongs to is a database CHECK, not a convention: an `inspection` service with
a price and a `fixed` service without one are both unrepresentable.

EPIC 4 (issue #34) added the eighth, `customers` — the first **role profile**,
hanging off an account rather than replacing it. It repeats nothing from
`users`: the phone number stays on the account, because a person holding both
roles has one number and two profiles, and a copy on each would be two rows to
keep in step. The unique index on `user_id` is deliberately **not** partial,
unlike `users_phone_e164_live_unique`: a phone number can be reassigned to a
different person, so a dead row must not block a new account, whereas a user id
cannot be — the same account coming back is the same person, and the only
sensible answer to "create my profile again" is the profile they already had,
with its history still attached. Soft delete is therefore a revivable state
rather than a tombstone.

EPIC 4 (issue #35) added the ninth, `addresses`, and with it **the first
PostGIS geometry in the schema**. Three things about it are deliberate:

- The structured columns — building, **entrance (`giriş`)**, floor, apartment,
  landmark note — are a product requirement, not a nicety
  ([`location-services.md`](location-services.md) § Azerbaijani addresses). They
  are `text` rather than integers because an entrance is "2" but also "B".
- **The SRID is written into the migration by hand.** `drizzle-kit generate`
  emits `geometry(point)` — `PgGeometryObject.getSQLType()` in
  `drizzle-orm@0.45.2` ignores the `srid` config entirely, exactly as
  [ADR-0018](../decisions/ADR-0018-spatial-index-on-the-geography-cast.md)
  records — so `0005_customer_addresses.sql` says `geometry(Point,4326)`. The
  typmod then rejects the `point(x y)` literal Drizzle's own driver mapper
  produces (Postgres reads it as SRID 0), which is why the repository writes the
  column through `ST_SetSRID(ST_MakePoint(lng, lat), 4326)`. Reads are
  unaffected.
- **There is no GiST index on it**, and that follows ADR-0018 rather than
  ignoring it: the rule is to index the expression a query evaluates, and no
  query evaluates a distance against `addresses`. Matching ranks masters using
  `master_locations`; an address is only ever fetched by its owner. The index
  arrives with the query that needs it.

"One default address per customer" is a partial unique index on
`(customer_id) WHERE is_default AND deleted_at IS NULL`, not an application
check — two requests each promoting a different address in the same millisecond
is precisely the case a check loses. The index gives "at most one"; the other
half, that a customer with addresses always has _at least_ one, is not
expressible as a constraint and lives in the service: the first address is
promoted on creation, and deleting the default promotes the oldest survivor.

Issue #36 added the tenth, `geocode_cache`, which is **infrastructure rather
than domain** — it appears in no entity diagram because it describes nobody. It
holds a normalised address key, a point, a place id and an expiry, and no address
text: what a shared cache may keep is set by Google's licence rather than by us
([ADR-0022](../decisions/ADR-0022-geocode-cache-stores-coordinates-only.md)). Two
details are worth knowing before touching it. There is no partial index for "the
expired rows" because Postgres requires an index predicate to be immutable and
`now()` is not; and the `geocode_cache_licence_ttl` CHECK is anchored to
`updated_at` rather than `created_at`, because the thirty days run from when a
value was cached and a refresh caches it again.

EPIC 5 (issue #37) added the eleventh and twelfth, `masters` and
`master_services` — the second role profile, and the first table in the schema
whose rows carry a price a **master** owns rather than the platform
([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)). Four things are
deliberate:

- `masters.verification_status` is the five-value review enum from
  [ADR-0023](../decisions/ADR-0023-master-verification-policy.md), and `deleted`
  is **not** one of them. user-roles.md lists deletion among the account states,
  but `deleted_at` already carries it, and a fact stored twice is a fact that
  can disagree with itself — the first symptom being a soft-deleted master who
  is still dispatchable.
- `suspended_at` is tied to that status by a CHECK
  (`(status = 'suspended') = (suspended_at is not null)`). The direction that
  bites is the reinstatement that forgets to clear the date, leaving behind the
  exact value a later query reads as "still suspended".
- The rating aggregate is **sum and count, not an average**. An average cannot
  be updated incrementally without drifting, because each rewrite rounds and the
  rounding compounds; sum and count are exact integers and the division happens
  once, at read time. A CHECK keeps the pair describable by a real set of
  reviews (`rating_sum <= rating_count * 5`).
- `master_services` has **no surrogate id**: the pair is the identity of the
  row, so `(master_id, service_id)` is the primary key, and that one choice
  supplies the uniqueness constraint and the index on the `master_id` foreign
  key at once. The matching filter reads the other way round — "who offers this
  service?" — which the primary key cannot serve, so a second, partial index on
  `(service_id, master_id) WHERE is_active` is created now rather than after a
  performance incident. `test/master-services.schema.test.ts` proves the planner
  uses it against four thousand masters, without `enable_seqscan = off`, which
  would have produced a green test on a missing index.

The fixed/inspection pricing pairing is enforced in `MastersService` rather than
by a CHECK, and that is the one invariant here the database does not hold. The
pricing shape lives on `services`, so no single-table constraint can see both
sides; duplicating `pricing_kind` into `master_services` would buy a CHECK at
the cost of a copy that drifts the first time an admin changes a service.

Issue #38 added the thirteenth and fourteenth, `master_documents` and
`master_verification_history` — the trust gate's evidence and its audit trail.
Three things about them are deliberate:

- **The bytes are never in the database.** The row holds a server-generated
  storage key; the file lives in object storage and is reached only through a
  short-lived presigned GET ([ADR-0005](../decisions/ADR-0005-object-storage.md),
  [ADR-0024](../decisions/ADR-0024-presigned-upload-mechanism.md)). Identity
  documents in a column would put the most sensitive data TezUsta holds into
  every backup and every replica of it.
- **A row exists before any bytes do.** `awaiting_upload` is the server's
  record that one key was issued to one master for one document, and it is what
  makes a presigned URL single-use — S3 offers no such guarantee, and AWS
  documents that a presigned URL works repeatedly until it expires. Confirming
  is a conditional transition out of that status, so exactly one of two
  concurrent confirms wins. Two partial unique indexes bound the rest: at most
  one outstanding presign per document type, and at most one live document per
  type.
- **`master_verification_history` is append-only, enforced by a trigger.**
  `0008_master_verification.sql` installs a function that raises on UPDATE and
  DELETE, plus a second trigger for TRUNCATE, which bypasses row-level triggers.
  An audit trail the application merely promises not to rewrite has integrity
  that depends on every future query being careful, and a trust decision with no
  reliable record of who made it is indistinguishable from an attacker's.

`master_verification_history.actor_kind` names `admin` before `admin_users`
exists. Admin accounts are a separate table with their own credential path
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)) and arrive with
review in issue #39, which adds `actor_admin_id` beside `actor_user_id`.
Naming the kind now is what keeps that a column addition rather than a
reinterpretation of every row already written.

Issue #39 added the fifteenth, sixteenth and seventeenth: `admin_users`,
`admin_sessions` and `admin_audit_log` — the account store ADR-0014 assigned to
EPIC 2 and EPIC 2 never shipped. Four things are deliberate:

- **An admin is a row in a different table, not a role on `users`.** The
  `user_role` enum has no `admin` value and never will; a person who is both
  holds two unrelated rows. That is what makes "an admin session never grants
  customer or master capability" a property of the schema rather than a rule
  to remember.
- **There is no password, TOTP or permission column.** Credential issuance and
  the granular permission model are EPIC 13, and a `password_hash` written now
  would fix a hashing scheme for a flow nobody has written (CLAUDE.md §20).
  What the schema does guarantee today is admin-flow.md's actual requirement —
  that it "must not assume a single `is_admin` boolean" — and it does not.
- **`admin_sessions` is not `sessions`.** Different lifetime (8 hours against
  30 days), an idle timeout the consumer path does not have, and no refresh
  table, because nothing issues an admin login yet. A shared table would be one
  shared query away from a consumer refresh token opening an admin session.
- **`admin_audit_log` is append-only by trigger**, like
  `master_verification_history`. Its `action` is text with a format CHECK
  rather than an enum: the set of administrative verbs grows with every admin
  feature, and a migration per verb pushes people towards reusing an existing
  one, which is how an audit trail quietly stops describing what happened.
  `target_id` carries **no** foreign key on purpose — the log has to outlive
  its target, and a reference that forbade deleting a row would turn the audit
  trail into a reason not to keep records.

The same migration adds the reviewer columns that hang off these tables:
`master_documents.reviewed_by_admin_id` / `reviewed_at`, with a CHECK that a
reviewed document names its reviewer and an unreviewed one names nobody; and
`master_verification_history.actor_admin_id`, so the actor CHECK now reads "a
master-initiated change names the master, an admin-initiated one names the
admin". Two nullable foreign keys rather than one polymorphic `actor_id`,
because a single column could only be an unconstrained `uuid` — and then "which
admin suspended this master" would be a join against a table the id might not
even be in.

Everything else in the diagram above is still domain analysis, not a schema.

**`otp_challenges` lives in Postgres, while the OTP rate-limit counters live in
Redis**, and the split is deliberate: a counter may be lost (an evicted key
costs an attacker one window), whereas a redeemed code may never be lost or
redeemed twice. Consumption is one conditional `UPDATE ... WHERE consumed_at IS
NULL ... RETURNING *`, the same shape `refresh_tokens` uses, so exactly one of
two concurrent verifications wins.

**At most one code per number is redeemable, enforced by the database** — a
partial unique index on `phone_e164 WHERE consumed_at IS NULL AND
invalidated_at IS NULL`. ADR-0008 requires a new code to invalidate the
previous one; the application does that explicitly, and the index is what keeps
it true when two requests for one number overlap. The predicate cannot mention
`expires_at`, because an index predicate must be IMMUTABLE and `now()` is not,
so an expired row still occupies the slot and the supersede statement clears it
on liveness rather than on expiry.

**The table has no foreign key to `users`, on purpose.** A number is not proven
to belong to anybody until a code is verified, so creating the account at
request time would make the OTP request endpoint both an account-creation
vector aimed at any number in Azerbaijan and a user-enumeration oracle.

**Role is a set, in `user_roles`** — one row per role a user holds, with
`(user_id, role)` as the primary key. That table, not the later existence of a
`customers` or `masters` profile row, is the authority an authorization decision
reads: the guards have to answer "may this actor act as a master?" before EPIC 5
exists to answer it from a profile. When those profile tables arrive, creating a
profile and inserting the matching grant is one transaction.

**`users.phone_e164` is unique among LIVE accounts only** — a partial unique
index `WHERE deleted_at IS NULL`, not a plain `UNIQUE`. Users are soft-deleted,
so the row survives forever; a plain constraint would leave the next subscriber
of a reassigned number permanently unable to sign up, with no support action
short of editing the database. ADR-0008's guarantee is about accounts that can
actually be signed into.

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

| Index                                            | Why                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| GiST on `(master_locations.position::geography)` | The nearby-masters query. Non-negotiable — and it must be built on the **cast**, not the bare column. |
| `orders (status, created_at)`                    | Dispatch queue scans                                                                                  |
| `orders (customer_id, created_at DESC)`          | Customer order history                                                                                |
| `orders (master_id, created_at DESC)`            | Master order history                                                                                  |
| `order_status_history (order_id, created_at)`    | Audit reads                                                                                           |
| `master_services (service_id, master_id)`        | Matching filter                                                                                       |
| Unique on `users.phone`                          | Identity                                                                                              |
| `devices (user_id) WHERE revoked_at IS NULL`     | Push fan-out                                                                                          |

**Rule: a query added to a hot path without an index is an incomplete change**
(CLAUDE.md §12). Check with `EXPLAIN (ANALYZE, BUFFERS)` — a `Seq Scan` on a
growing table is a defect.

## The nearby-masters query

This is the query the product depends on, and the canonical form of the
**eligibility predicate**. Every term is load-bearing, and "online" is two of
them rather than one:

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
- **The index must be built on `(position::geography)`, not on `position`.**
  PostGIS registers a separate operator class for `geography`, so a GiST index
  over the bare `geometry` column cannot serve the `::geography` cast this
  query performs — Postgres falls back to a sequential scan and gives no
  warning that it did. Measured on PostgreSQL 17.5 + PostGIS 3.5 with 50 000
  rows: `gist(position)` produced a **Seq Scan at 824 ms**, while
  `gist((position::geography))` produced a Bitmap Index Scan at **2.0 ms**.
  Confirm with `EXPLAIN (ANALYZE, BUFFERS)` when `master_locations` is created
  in EPIC 6; a `Seq Scan` there is the defect this note exists to prevent.
  Drizzle expresses it as
  ``index('...').using('gist', sql`(${t.position}::geography)`)`` — see
  [`technology-stack.md`](technology-stack.md) § 4.1.
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
