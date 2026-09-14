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
├── dto/                      # Zod schemas (re-exported from packages/validation)
├── <name>.service.test.ts
└── <name>.integration.test.ts
```

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

```ts
// packages/validation — shared with the client so shapes cannot drift
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

## Concurrency — the guarded transition

This pattern is the reason the order flow is correct. Use it for any
"claim exactly one" operation.

```ts
const [claimed] = await db
  .update(orders)
  .set({ status: 'ACCEPTED', masterId, acceptedAt: new Date() })
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

Transitions live in **one** table, not scattered across services:

```ts
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {/* ... */};

assertTransition(order.status, next); // throws on invalid
await this.repo.recordHistory(order.id, order.status, next, actor, reason);
```

Every transition writes `order_status_history`. Every transition — **valid and
invalid** — is tested.

## Errors

```ts
throw new AppError('ORDER_ALREADY_TAKEN', 'This order is no longer available.', 409);
```

- Stable machine-readable code, shared via `packages/types`.
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
