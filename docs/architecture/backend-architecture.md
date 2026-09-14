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
never assigned directly; it moves through validated transitions.

```
                 DRAFT
                   │ submit
                   ▼
               SEARCHING ──────────────┐
                   │ accept            │ no master / customer cancels
                   ▼                   │
               ACCEPTED ───────────────┤
                   │ depart            │
                   ▼                   │
          MASTER_ON_THE_WAY ───────────┤
                   │ arrive            │
                   ▼                   │
            MASTER_ARRIVED ────────────┤
                   │ start             │
                   ▼                   │
             IN_PROGRESS               │  (cancellation is no longer
                   │ complete          │   free past this point —
                   ▼                   │   policy OPEN)
              COMPLETED                │
                   │                   ▼
                   ▼               CANCELLED
           PAYMENT_PENDING
                   │ settle
                   ▼
                 PAID
                   │ dispute
                   ▼
               DISPUTED
```

### Implementation rules

1. **Transitions live in one table**, not scattered through services:

   ```ts
   const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
     DRAFT: ['SEARCHING', 'CANCELLED'],
     SEARCHING: ['ACCEPTED', 'CANCELLED'],
     ACCEPTED: ['MASTER_ON_THE_WAY', 'CANCELLED'],
     MASTER_ON_THE_WAY: ['MASTER_ARRIVED', 'CANCELLED'],
     MASTER_ARRIVED: ['IN_PROGRESS', 'CANCELLED'],
     IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
     COMPLETED: ['PAYMENT_PENDING', 'PAID', 'DISPUTED'],
     PAYMENT_PENDING: ['PAID', 'DISPUTED'],
     PAID: ['DISPUTED'],
     DISPUTED: [],
     CANCELLED: [],
   } as const;
   ```

2. **An invalid transition is rejected**, with a specific error, not silently
   ignored.
3. **Only the actor entitled to a transition may perform it.** The assigned
   master starts work; the customer does not.
4. **Every transition writes `order_status_history`** — from, to, actor, reason,
   timestamp.
5. **Every transition is tested, including the invalid ones.** A state machine
   tested only on its happy path is not tested (CLAUDE.md §13).

## Concurrent accept — exactly one winner

Several masters may see the same order. Exactly one must win.

**This cannot be solved by reading then writing.** Two requests both read
`SEARCHING`, both consider themselves valid, both write. The check must be
atomic with the write:

```ts
const [claimed] = await db
  .update(orders)
  .set({ status: 'ACCEPTED', masterId, acceptedAt: new Date() })
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

Supporting guarantees:

- A **partial unique index** ensures a master holds at most one active order.
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

- Codes are a `const` union shared via `packages/types`, so the client switches
  on a value the compiler knows.
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

Schemas live in `packages/validation` so the client validates the same shapes —
one definition, no drift.

**Client-side validation is UX. Server-side validation is the control.**

## API conventions

```
GET    /services
GET    /services/:id

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

## Background jobs

BullMQ, in a separate worker process.

| Queue           | Work                              |
| --------------- | --------------------------------- |
| `notifications` | Push delivery                     |
| `sms`           | OTP and transactional SMS         |
| `payments`      | Reconciliation, retries (EPIC 12) |
| `maintenance`   | Cleanup, location retention       |

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
