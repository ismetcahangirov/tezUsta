# Backend architecture

NestJS 12 on the Fastify adapter. See
[`technology-stack.md`](technology-stack.md) §3 for why.

## Module layout

```
apps/api/src/
├── main.ts
├── app.module.ts
├── common/
│   ├── guards/          auth, roles, ownership
│   ├── interceptors/    response envelope, logging
│   ├── filters/         uniform error mapping
│   ├── pipes/           Zod validation pipe
│   └── errors/          AppError + error codes
├── infra/
│   ├── database/        Drizzle client, schema, migrations
│   ├── redis/
│   └── queue/           BullMQ registration
└── modules/
    ├── auth/            tokens, sessions, OTP
    ├── users/           identity
    ├── customers/       customer profile, addresses
    ├── masters/         master profile, verification, services
    ├── services/        catalogue
    ├── orders/          lifecycle, state machine
    ├── matching/        nearby masters, dispatch
    ├── locations/       position ingest, presence
    ├── reviews/
    ├── notifications/   push, queue producers
    ├── uploads/         presigned URLs
    └── admin/
```

**Create a module when it is needed, not in advance.** `payments`,
`subscriptions`, and `wallets` are deliberately absent until their Epic.

### Module rules

- A module owns its data. Cross-module reads go through the owning module's
  service, not by importing another module's repository.
- Controllers: HTTP shape only. No business logic.
- Services: business logic, and they own the transaction boundary.
- Repositories: Drizzle queries only.
- Circular module dependencies are a CI failure (`no-circular`).

## Order state machine

**The single most important invariant in the system.** An order's status is
never assigned directly; it moves through validated transitions. The complete
status set and the only legal edges are fixed by
[ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md).

```
                          DRAFT ─────────────────────────┐
                            │ submit                     │
                            ▼                            │
   ┌──────────────────►  SEARCHING ────────────────────► ┤
   │                       │   │                         │
   │   NO_MASTER_FOUND ◄───┘   │ accept                  │
   │   (dispatch window        │                         │
   │    expired, or the        │                         │
   │    re-dispatch cap)       ▼                         │
   ├───────────────────── ACCEPTED ────────────────────► ┤
   │  re-dispatch              │ depart                  │
   │                           ▼                         │
   ├──────────────── MASTER_ON_THE_WAY ────────────────► ┤
   │                           │ arrive                  │
   │                           ▼                         │
   └────────────────── MASTER_ARRIVED ─────────────────► ┤
                               │ start                   │
                               ▼                         │
                         IN_PROGRESS ─────────────────►  ┤
                               │ complete                ▼
                               ▼                     CANCELLED
                ┌──────── COMPLETED ─────────┐
                │ dispute      │ invoice     │ cash — paid in person,
                │              ▼             │ so there is no
                ├─────── PAYMENT_PENDING     │ pending window
                │              │ settle      │
                │              ▼             │
                ├───────────  PAID  ◄────────┘
                ▼
             DISPUTED
                │
          ┌─────┴─────┐
          ▼           ▼
      RESOLVED    REFUNDED
```

The `COMPLETED → PAID` edge is not a shortcut: **a cash order is paid in person
at the moment the work ends**, so there is never a window in which the platform
is waiting for a settlement. `PAYMENT_PENDING` exists only for the card path,
where the charge is asynchronous
([ADR-0007](../decisions/ADR-0007-payments.md)).

### Implementation rules

1. **Transitions live in one table**, not scattered through services:

   ```ts
   const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
     DRAFT: ['SEARCHING', 'CANCELLED'],
     SEARCHING: ['ACCEPTED', 'NO_MASTER_FOUND', 'CANCELLED'],
     ACCEPTED: ['MASTER_ON_THE_WAY', 'SEARCHING', 'CANCELLED'],
     MASTER_ON_THE_WAY: ['MASTER_ARRIVED', 'SEARCHING', 'CANCELLED'],
     MASTER_ARRIVED: ['IN_PROGRESS', 'SEARCHING', 'CANCELLED'],
     IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
     COMPLETED: ['PAYMENT_PENDING', 'PAID', 'DISPUTED'],
     PAYMENT_PENDING: ['PAID', 'DISPUTED'],
     PAID: ['DISPUTED'],
     DISPUTED: ['RESOLVED', 'REFUNDED'],
     RESOLVED: [],
     REFUNDED: [],
     NO_MASTER_FOUND: [],
     CANCELLED: [],
   } as const;
   ```

   **The diagram above and this table are the same thing.** If they ever
   disagree, the table is the implementation and the diagram is the bug.

2. **An invalid transition is rejected**, with a specific error, not silently
   ignored.
3. **Only the actor entitled to a transition may perform it.** The assigned
   master starts work; the customer does not.
4. **Every transition writes `order_status_history`** — from, to, actor, reason,
   timestamp.
5. **Every transition is tested, including the invalid ones.** A state machine
   tested only on its happy path is not tested (CLAUDE.md §13).
6. **`NO_MASTER_FOUND` is not `CANCELLED`.** An order nobody accepted is a
   supply signal; a cancellation is a quality signal about a person. Collapsing
   the two corrupts the cancellation rate that master ranking and admin
   intervention both read.
7. **`DISPUTED` is not terminal.** An admin closes it as `RESOLVED` (no money
   moved) or `REFUNDED` (money moved back), both with a mandatory reason.

### Re-dispatch — `ACCEPTED` / `MASTER_ON_THE_WAY` / `MASTER_ARRIVED` → `SEARCHING`

Triggered only by the **assigned master** cancelling, or by an admin releasing a
stuck order. The customer never triggers it — a customer cancels to `CANCELLED`.
In one transaction, re-dispatch:

1. Clears `master_id` **and** `price_minor`
   ([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)).
2. Increments `orders.redispatch_count`.
3. Excludes the cancelling master from the next broadcast for this order.
4. Writes `order_status_history` with the actor and the reason.

`redispatch_count` is capped by `MAX_ORDER_REDISPATCHES` (configuration, not a
literal). At the cap the order goes to `NO_MASTER_FOUND` instead of searching
again, so an order cannot ping-pong indefinitely.

**Clearing `master_id` is load-bearing, not tidiness.** The accept guard below
is a conditional update on `master_id IS NULL`; if re-dispatch left the previous
master on the row, the second round would have no winner at all.

Re-dispatch is deliberately absent from `IN_PROGRESS`: once work has started, a
different master cannot pick the job up from an unknown state.

### Admin override bypasses the actor check, never the edge table

An admin may perform a transition **the table permits** even though they are
neither the customer nor the assigned master. An admin may **not** perform a
transition the table does not contain, and there is no code path that lets them.
Every override writes `order_status_history` with actor, reason and timestamp.

If an operational situation needs an edge that does not exist, the answer is a
new ADR, not a special case in a service.

## Concurrent accept — exactly one winner

Several masters may see the same order. Exactly one must win.

**This cannot be solved by reading then writing.** Two requests both read
`SEARCHING`, both consider themselves valid, both write. The check must be
atomic with the write:

```ts
const [claimed] = await db
  .update(orders)
  .set({
    status: 'ACCEPTED',
    masterId,
    // The price is frozen here, from THIS master's stored price — ADR-0013.
    priceMinor: acceptingMasterPriceMinor,
    acceptedAt: new Date(),
  })
  .where(
    and(
      eq(orders.id, orderId),
      eq(orders.status, 'SEARCHING'), // the guard, evaluated by the database
      isNull(orders.masterId),
    ),
  )
  .returning();

if (!claimed) throw new OrderAlreadyTakenError();
```

The `WHERE` clause is the lock. The loser gets zero rows back and is told
immediately and cleanly — not with a generic 500.

**The price is written in this statement, not a second one.** Until accept there
is no single price — there is a set of candidate masters whose prices differ, so
`orders.price_minor` is null while the order is `SEARCHING`
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)). Writing the winner
and the amount in one conditional update means the race and the price are
decided by the same atomic operation, with no interleaving window between them.
The commission basis is that frozen price.

Supporting guarantees:

- A **partial unique index** ensures a master holds at most one active order.
- The accept handler re-checks the **dispatch eligibility predicate**
  ([`database-architecture.md`](database-architecture.md) § The nearby-masters
  query) before the guarded update. Being on the broadcast is not entitlement:
  a master may have gone offline, lost verification, or crossed
  `MAX_COMMISSION_DEBT_MINOR` between the offer and the tap.
- A Redis lock may reduce contention, but **it is an optimisation, not the
  correctness mechanism.** Correctness lives in the database. A Redis lock can
  expire mid-operation; a conditional `UPDATE` cannot.

This must be tested with genuinely concurrent requests, not sequential ones.

## Error model

One error shape, everywhere:

```jsonc
{
  "error": {
    "code": "ORDER_ALREADY_TAKEN", // stable, machine-readable
    "message": "This order is no longer available.", // safe for a user
    "details": { "orderId": "..." }, // optional, never sensitive
    "requestId": "01J...", // correlates with server logs
  },
}
```

Rules:

- Codes are a `const` union, so the client switches on a value the compiler
  knows. The union lives in `apps/api/src/**/*.types.ts` today and moves to
  `packages/types` when `apps/mobile` consumes it directly — one definition
  either way, never two
  ([ADR-0016](../decisions/ADR-0016-shared-package-timing.md)).
- **Stack traces, SQL, driver errors, and infrastructure details never reach a
  client.** The filter maps unknown errors to a generic 500 and logs the detail
  server-side with the `requestId`.
- Validation failures return 422 with per-field detail.
- An unexpected error is logged with full context and returned with none.

| Status | Meaning                                            |
| ------ | -------------------------------------------------- |
| 400    | Malformed request                                  |
| 401    | Missing/invalid authentication                     |
| 403    | Authenticated but not permitted                    |
| 404    | Not found, **or** not visible to this caller       |
| 409    | Conflict (invalid state transition, already taken) |
| 422    | Validation failed                                  |
| 429    | Rate limited                                       |
| 500    | Unexpected — details logged, never returned        |

404 doubles as "not yours" deliberately: a 403 on someone else's order id
confirms that the order exists.

## Validation

Zod at every boundary, via a global pipe. Nothing reaches a service unvalidated.

Schemas live in `apps/api/src/**/*.schema.ts`, written as if they were already a
package: no Nest, HTTP or Drizzle type crosses into them. They move to
`packages/validation` the moment a client reuses them, which is what keeps the
shapes one definition rather than two that drift
([ADR-0016](../decisions/ADR-0016-shared-package-timing.md)).

**Client-side validation is UX. Server-side validation is the control.**

## API conventions

```
GET    /services
GET    /services/:id
GET    /services/categories

POST   /orders
GET    /orders/:id
PATCH  /orders/:id
POST   /orders/:id/cancel
POST   /orders/:id/start
POST   /orders/:id/complete

GET    /masters/nearby
POST   /masters/orders/:id/accept

POST   /reviews
GET    /users/me
```

- **State transitions are `POST /resource/:id/verb`, not `PATCH status`.** A
  transition is an operation with rules, not a field assignment. Exposing
  `PATCH { status }` invites clients to assume any value is settable.
- Plural collection nouns; `snake_case` never appears in JSON — API is
  `camelCase`, database is `snake_case`.
- List endpoints are paginated by cursor from the start. Offset pagination
  breaks under concurrent inserts, which is exactly this workload.
- **Mutating endpoints accept an idempotency key.** Mobile networks retry; order
  creation must not produce duplicates.

The final surface follows from the domain model. The list above is a convention
example, not a specification to implement verbatim.

### The catalogue reads are (almost all of) the public business endpoints

`GET /services`, `GET /services/:id`, `GET /services/categories` and
`GET /services/:id/price-range` carry `@Public()`, and they are the only
routes outside the health probes that do
([ADR-0020](../decisions/ADR-0020-public-cached-service-catalogue.md)). A
customer has to be able to see what TezUsta does before handing over a phone
number, and a menu of services with reference prices is what the product
advertises publicly anyway. **This sets no precedent for anything scoped to a
user** — an address, a master's position, an order — all of which stay behind
the guard.

The first three are also the only cached reads. `CacheService`
(`apps/api/src/infra/cache/`) is a read-through Redis cache with a sixty-second
TTL, and their responses carry `Cache-Control: public, max-age=60` with
`Vary: Accept-Language` — the body is translated, and a shared cache without
`Vary` would hand an Azerbaijani response to a caller who asked for English.
Only the first page of a listing is cached, and a 404 never is: a cache key
built from a client-supplied cursor or id is a key an anonymous caller can mint
without limit.

**`GET /services/:id/price-range` (issue #84) is the exception on both
counts**, and deliberately so: [ADR-0013](../decisions/ADR-0013-price-freeze-point.md)
requires it to be computed live on every call, so it carries no
`Cache-Control` and is never read through Redis. That also removes the
catalogue's "first page answered from cache" mitigation against an
unauthenticated caller, so this route carries the one thing the other three
do not — a `@RateLimit` policy (`price-range`), identified by user id where a
caller is signed in and by IP otherwise
(`apps/api/src/infra/rate-limit/rate-limit.config.ts`).

## Background jobs

BullMQ on Redis, **with the worker running inside the API process**
([ADR-0025](../decisions/ADR-0025-deferred-work-on-bullmq.md)).

This page previously said "in a separate worker process". There is no second
deployment unit and no hosting provider yet (CLAUDE.md §1), and inventing a
deployment topology to satisfy a document is not a decision anyone has made.
ADR-0025 records the deviation, what it costs, and the trigger for reversing
it. The extraction is deliberately additive rather than a redesign: a second
bootstrap file that imports `QueueModule` and the feature modules whose
handlers it must serve, plus `QUEUE_WORKER_MODE=off` on the API so a replica
produces jobs and consumes none.

| Queue           | Work                                           | Exists  |
| --------------- | ---------------------------------------------- | ------- |
| `dispatch`      | Radius widening and give-up deadlines (EPIC 7) | ✓       |
| `notifications` | Push delivery                                  | EPIC 10 |
| `sms`           | OTP and transactional SMS                      | EPIC 2  |
| `payments`      | Reconciliation, retries                        | EPIC 12 |
| `maintenance`   | Cleanup, location retention                    | —       |

Only `dispatch` is registered today. A queue with no producer and no consumer
is one more key space to reason about and one more worker to drain on
shutdown, so each arrives with its Epic — ADR-0016's habit, applied to queues.

- A feature module never touches a `Queue`. It schedules through
  `DeferredWorkService` and registers a handler in
  `DeferredJobHandlerRegistry`, the same way it registers a readiness check —
  so `infra/queue` fans out into `modules/` and never back.
- Every job is **idempotent** — it will be retried.
- Retries use exponential backoff with a cap.
- Failed jobs land in a dead-letter queue and are alerted on, not dropped.
- Jobs carry ids, never whole objects — the object may have changed by the time
  the job runs.

## Configuration

Environment variables are parsed and validated **once at startup** with Zod. A
missing or malformed variable fails the process immediately.

A server that boots with a missing secret and fails on the first request that
needs it has turned a deployment error into a production incident.

No `process.env` access outside the config module.
