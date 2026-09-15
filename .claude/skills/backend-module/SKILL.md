---
name: backend-module
description: Use when creating or modifying a NestJS module in apps/api — controllers, services, repositories, guards, validation, error handling, and the concurrency patterns TezUsta's order flow depends on. Triggers on "add endpoint", "new module", "API route", "backend feature", or work under apps/api.
---

# Build a backend module

NestJS 12 on Fastify. Design reference:
`docs/architecture/backend-architecture.md`.

## Layout

```
apps/api/src/modules/<name>/
├── <name>.module.ts
├── <name>.controller.ts      # HTTP shape only
├── <name>.service.ts         # business logic + transaction boundary
├── <name>.repository.ts      # Drizzle queries only
├── dto/                      # Zod schemas — see "Validation" below
├── <name>.service.test.ts
└── <name>.integration.test.ts
```

**`apps/api` does not exist on disk yet.** This skill describes the module it
gets when it lands; check before assuming a path is there.

**Create a module when it is needed.** `payments`, `subscriptions`, and
`wallets` do not exist until their Epic.

## Layer discipline

| Layer      | May contain                                     | Must not contain                        |
| ---------- | ----------------------------------------------- | --------------------------------------- |
| Controller | Route, validation pipe, guard, response mapping | Business logic, database access         |
| Service    | Business rules, transactions, orchestration     | HTTP concepts (`Request`, status codes) |
| Repository | Drizzle queries                                 | Business rules                          |

A service that imports `Request` cannot be reused from a WebSocket gateway or a
queue worker. Keep it clean.

**Cross-module reads go through the owning module's service**, never by
importing another module's repository. Circular module dependencies fail CI.

## Validation — every boundary

Schemas live in the module, as `*.schema.ts`, and move to `packages/validation`
when a client workspace actually reuses them — packages are created on the second
consumer, not before (`docs/decisions/ADR-0016-shared-package-timing.md`). Write
the schema as if it were already shared: no Nest or Fastify type crosses it, so
the move is a file move.

```ts
// apps/api/src/modules/orders/dto/create-order.schema.ts
export const createOrderSchema = z
  .object({
    serviceId: z.string().uuid(),
    addressId: z.string().uuid(),
    description: z.string().min(10).max(2000),
    photoKeys: z.array(z.string()).max(5).default([]),
  })
  .strict(); // .strict() rejects unknown fields — mass-assignment protection
```

- Bound every string, array, and number. An unbounded text field is a DoS vector.
- Validate path and query params, not just bodies.
- Validate WebSocket payloads identically — a socket message is untrusted input.

## Authorization — the part that is actually security

Three checks, in order. Only the last is usually forgotten:

```ts
// 1. Authenticated?          — guard
// 2. Right role?             — guard, re-checked against the DB, not the token claim
// 3. Entitled to THIS row?   — in the service

const order = await this.repo.findById(id);
if (!order) throw new NotFoundError();
if (!canView(actor, order)) throw new NotFoundError(); // 404, not 403
```

**Return 404, not 403, for "not yours."** A 403 on someone else's order id
confirms the order exists — the endpoint becomes an enumeration oracle.

**A role claim in a token is a cache, not an authority.** A token issued before a
master was suspended still says `role: master`. Re-read current status from the
database on every authorization decision.

**The `admin` role exists from EPIC 2, its credentials do not.** Admin accounts
live in a separate `admin_users` table on a separate credential path — no phone
OTP, no overlap with `users`
(`docs/decisions/ADR-0014-admin-authentication.md`). So an admin-only endpoint is
written, guarded and tested against a fixture admin now, while no production
admin credential is issued until EPIC 13. An admin session never grants customer
or master capability, and **every admin action is audited — including a read of
personal data.**

## Concurrency — the guarded transition

This pattern is the reason the order flow is correct. Use it for any
"claim exactly one" operation.

```ts
const [claimed] = await db
  .update(orders)
  // priceMinor is frozen HERE, from the accepting master's stored price, in the
  // same statement as masterId — ADR-0013. It is null while SEARCHING, and the
  // two columns are written together and cleared together.
  .set({ status: 'ACCEPTED', masterId, priceMinor, acceptedAt: new Date() })
  .where(
    and(
      eq(orders.id, orderId),
      eq(orders.status, 'SEARCHING'), // the guard — evaluated BY the database
      isNull(orders.masterId),
    ),
  )
  .returning();

if (!claimed) throw new OrderAlreadyTakenError();
```

**Do not read, check, then write.** Two requests both read `SEARCHING`, both
consider themselves valid, and both write. The check must be atomic with the
write, which means it belongs in the `WHERE` clause.

A Redis lock may reduce contention but is **never** the correctness mechanism —
it can expire mid-operation; a conditional `UPDATE` cannot.

## State transitions

Transitions live in **one** table, not scattered across services. The complete
status set and the only legal edges are
`docs/decisions/ADR-0015-order-lifecycle-states.md` — fourteen statuses, not the
handful a service happens to use:

```ts
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {/* ADR-0015 */};

assertTransition(order.status, next); // throws on invalid
await this.repo.recordHistory(order.id, order.status, next, actor, reason);
```

Every transition writes `order_status_history`. Every transition — **valid and
invalid** — is tested.

Three rules the table alone does not tell you:

- **Re-dispatch** returns `ACCEPTED` / `MASTER_ON_THE_WAY` / `MASTER_ARRIVED` to
  `SEARCHING` when the assigned master cancels. In one transaction: clear
  `master_id` **and** `price_minor`, increment `redispatch_count`, exclude the
  cancelling master from the next broadcast, write history. Clearing `master_id`
  is what keeps the accept guard above correct on the second round. At
  `MAX_ORDER_REDISPATCHES` the order goes to `NO_MASTER_FOUND`, not back out.
- **`NO_MASTER_FOUND` is not `CANCELLED`.** Nobody cancelled; supply ran out.
  Collapsing the two corrupts the cancellation-rate metric.
- **An admin override bypasses the actor check, never the edge table.** An admin
  may make a transition the table permits while being neither the customer nor
  the assigned master, with a mandatory reason recorded. An admin may **not**
  make a transition the table does not contain. If an edge is genuinely missing,
  the answer is a new ADR, not a special case in a service.

## Errors

```ts
throw new AppError('ORDER_ALREADY_TAKEN', 'This order is no longer available.', 409);
```

- Stable machine-readable code, declared once in `apps/api/src/**/*.types.ts`
  and destined for `packages/types` when `apps/mobile` consumes it (ADR-0016).
- Message is safe to show a user.
- **Stack traces, SQL, and driver errors never reach a client** — the global
  filter maps unknown errors to a generic 500 and logs the detail with the
  `requestId`.

## Endpoint conventions

```
POST /orders/:id/accept      ✅ a transition is an operation with rules
PATCH /orders/:id {status}   ❌ invites clients to assume any value is settable
```

- Cursor pagination on every list endpoint, from the start.
- Mutating endpoints accept an **idempotency key** — mobile networks retry.
- JSON is `camelCase`; the database is `snake_case`.

## Background work

Anything slow goes to BullMQ, never inline in a request. Jobs are **idempotent**
and carry **ids, not objects** — the object may have changed by the time the job
runs.

## Before finishing

```bash
pnpm verify
node tools/project-graph/query.mjs apps/api/src/modules/<name>/<name>.service.ts
```

- [ ] Validation on every input
- [ ] Authorization including the **ownership** check
- [ ] Negative-path tests (401, 403→404, invalid transition)
- [ ] Concurrency test if anything is claimed
- [ ] Every new FK and hot-path query has an index (`EXPLAIN ANALYZE`)
- [ ] Nothing sensitive logged
