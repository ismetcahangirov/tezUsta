# Architecture overview

## System shape

```
┌─────────────────────────────────────────────┐
│  apps/mobile — Expo (customer + master)     │
└───────────────┬─────────────────┬───────────┘
                │ REST (HTTPS)    │ WebSocket
                ▼                 ▼
┌─────────────────────────────────────────────┐
│  apps/api — NestJS on Fastify               │
│                                             │
│  auth · users · customers · masters         │
│  orders · matching · locations · services   │
│  reviews · notifications · uploads · admin  │
└──┬──────────┬──────────┬──────────┬─────────┘
   │          │          │          │
   ▼          ▼          ▼          ▼
┌────────┐ ┌───────┐ ┌────────┐ ┌──────────┐
│Postgres│ │ Redis │ │ BullMQ │ │ S3-compat│
│+PostGIS│ │cache  │ │workers │ │ storage  │
│        │ │presence│        │ │ (photos) │
│        │ │pub/sub │        │ │          │
└────────┘ └───────┘ └────────┘ └──────────┘
                │
                ▼
        ┌──────────────┐
        │ apps/admin   │  (web, EPIC 13)
        └──────────────┘
```

**This is the target shape, not the current tree.** Today the repository holds
`apps/mobile`, `packages/eslint-config` and `packages/typescript-config`;
`apps/api` and `apps/admin` arrive with their Epics. There is deliberately no
`payments` module in the list — `payments`, `subscriptions` and `wallets` stay
absent until EPIC 12 ([`backend-architecture.md`](backend-architecture.md) §
Module layout).

## Boundaries — enforced, not suggested

These are checked by `pnpm graph:validate` in CI (see
[ADR-0006](../decisions/ADR-0006-project-graph-tooling.md)):

| Rule                          | What it forbids                                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `no-circular`                 | A dependency cycle anywhere. Cycles make modules impossible to reason about or test in isolation.                                |
| `not-to-dev-dep`              | Production code importing a devDependency — it is absent in the deployed image.                                                  |
| `no-non-package-json`         | A phantom dependency: used in code, undeclared in `package.json`. `nodeLinker: hoisted` makes this easy to introduce and silent. |
| `no-deprecated-core`          | `punycode`, `domain`, `sys`, `constants` — Node core modules slated for removal.                                                 |
| `mobile-not-into-api`         | `apps/mobile` importing `apps/api`. The client talks over HTTP/WS only; contracts are shared, never duplicated — see below.      |
| `api-not-into-client`         | `apps/api` importing `apps/mobile` or `apps/admin`. The backend never depends on a client.                                       |
| `shared-packages-stay-shared` | `packages/*` importing `apps/*`. Shared packages are leaves; the inverse edge makes them unusable elsewhere.                     |

`no-orphans` also runs, at `warn`: an unimported module is usually dead code
left by a refactor, but routes, stories and CLI entry points are legitimately
unimported and are excluded by path.

**Contracts are shared, not duplicated — but they do not live in a package
yet.** Domain types and API contracts live in `apps/api/src/**/*.types.ts` and
move to `packages/types` when `apps/mobile` consumes them directly, because a
package buys nothing until it has a second consumer
([ADR-0016](../decisions/ADR-0016-shared-package-timing.md)).

A boundary that is documented but unenforced is a boundary that will be crossed.

## System invariants

These hold everywhere. Violating one is a bug regardless of what a ticket says.

1. **An order has at most one assigned master at a time.** Guaranteed by
   `orders.master_id` being a single nullable column, filled by a conditional
   `UPDATE` guarded on `master_id IS NULL` — never by application-level checking
   alone. The converse — **a master holds at most one active order** — is the
   one the partial unique index on `(master_id)` enforces. The two are different
   statements with different mechanisms
   ([`database-architecture.md`](database-architecture.md) § Integrity rules).
2. **Order status changes only through valid state-machine transitions.** There
   is no code path that writes an arbitrary status, and an admin override
   bypasses the actor check, never the edge table
   ([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)).
3. **Every status change is recorded** in `order_status_history` with actor,
   timestamp, and reason.
4. **Authorization is server-side, per request.** A client-side role check is a
   UX affordance.
5. **All input crossing the API boundary is validated with Zod**, before it
   reaches a service.
6. **Money is integer minor units.** Never a float, never derived from a client.
7. **Redis holds no permanent business data.** Anything that must survive a
   Redis restart is in Postgres.
8. **Geo queries use the PostGIS GiST index.** Never a full-table distance scan,
   and never a second spatial scheme beside it. Dispatch eligibility intersects
   that result with Redis liveness — Postgres holds intent, Redis holds
   aliveness, and offering work needs both.
9. **The API is horizontally scalable.** No in-process state that two instances
   would disagree about.
10. **Prices come from the backend**, and an order's price is **frozen at
    accept** from the accepting master's stored price — null until then, because
    until then there is no single price
    ([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)).

## Why one API, not microservices

**Decision:** a single modular monolith.

TezUsta's core transaction — create order, find masters, assign exactly one,
advance status — is tightly coupled and needs transactional consistency. Splitting
that across services turns a database transaction into a distributed saga with
compensating actions, for a system that has no scale problem yet and no team
boundaries to mirror.

NestJS modules give the internal boundaries. If a module later needs independent
scaling, a well-bounded module is exactly what extracts cleanly. Starting
distributed and consolidating later is much harder than the reverse.

**Revisit when:** a module has genuinely different scaling characteristics, or
team structure makes a shared deployment the bottleneck.

## Request path

```
Request
  → Fastify
  → Guard         (authenticate; verify role against DB, not just the token claim)
  → Pipe          (Zod validation — reject before any business logic runs)
  → Controller    (HTTP shape only; no business logic)
  → Service       (business logic; owns the transaction boundary)
  → Repository    (Drizzle; parameterised queries only)
  → Postgres
  → Interceptor   (uniform response envelope)
  → Filter        (uniform error shape; nothing internal leaks)
```

Controllers contain no business logic. Services contain no HTTP concepts. This
keeps services unit-testable without a server and reusable from a WebSocket
gateway or a queue worker.

## Where the hard problems live

| Problem                                      | Where it is solved                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| Two masters accept the same order            | [`backend-architecture.md`](backend-architecture.md) — guarded transition               |
| Finding nearby masters fast                  | [`database-architecture.md`](database-architecture.md) — PostGIS GiST + `ST_DWithin`    |
| Location without draining the battery        | [`realtime-architecture.md`](realtime-architecture.md) — update budget                  |
| Events reaching a client on another instance | [`realtime-architecture.md`](realtime-architecture.md) — Redis pub/sub adapter          |
| Stolen refresh token                         | [`authentication.md`](authentication.md) — rotation with reuse detection                |
| Untrusted image uploads                      | [ADR-0005](../decisions/ADR-0005-object-storage.md) — presigned + magic-byte validation |

## Deployment topology

```
              ┌──────────────┐
   clients →  │ Load balancer│ (TLS termination, sticky-free)
              └──────┬───────┘
                     ▼
          ┌──────────────────────┐
          │  api × N (stateless) │
          └───┬──────────────┬───┘
              ▼              ▼
     ┌────────────────┐  ┌────────┐
     │ Postgres       │  │ Redis  │
     │ + read replica │  │        │
     └────────────────┘  └────────┘
              ▲
     ┌────────┴────────┐
     │ BullMQ workers  │ (separate process, scaled independently)
     └─────────────────┘
```

API instances are stateless and interchangeable. WebSocket fan-out goes through
Redis pub/sub, so no sticky sessions are needed. Queue workers run as a separate
deployment so a burst of notifications cannot starve HTTP request handling.

Details: [`system-design.md`](system-design.md).
