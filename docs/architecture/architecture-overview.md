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
│  auth · users · orders · matching           │
│  locations · services · reviews             │
│  notifications · uploads · payments · admin │
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

## Boundaries — enforced, not suggested

These are checked by `pnpm graph:validate` in CI (see
[ADR-0006](../decisions/ADR-0006-project-graph-tooling.md)):

| Boundary                                 | Rule                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| `apps/mobile` ⇏ `apps/api`               | The client talks over HTTP/WS only. Contracts go through `packages/types`. |
| `apps/api` ⇏ `apps/mobile`, `apps/admin` | The backend never depends on a client.                                     |
| `packages/*` ⇏ `apps/*`                  | Shared packages are leaves.                                                |
| No circular dependencies                 | Anywhere.                                                                  |
| Production code ⇏ devDependencies        | They are absent in the deployed image.                                     |

A boundary that is documented but unenforced is a boundary that will be crossed.

## System invariants

These hold everywhere. Violating one is a bug regardless of what a ticket says.

1. **An order has exactly one assigned master at a time.** Enforced by a database
   constraint plus a guarded transition — never by application-level checking
   alone.
2. **Order status changes only through valid state-machine transitions.** There
   is no code path that writes an arbitrary status.
3. **Every status change is recorded** in `order_status_history` with actor,
   timestamp, and reason.
4. **Authorization is server-side, per request.** A client-side role check is a
   UX affordance.
5. **All input crossing the API boundary is validated with Zod**, before it
   reaches a service.
6. **Money is integer minor units.** Never a float, never derived from a client.
7. **Redis holds no permanent business data.** Anything that must survive a
   Redis restart is in Postgres.
8. **Geo queries use the PostGIS GiST index.** Never a full-table distance scan.
9. **The API is horizontally scalable.** No in-process state that two instances
   would disagree about.
10. **Prices come from the backend.**

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
