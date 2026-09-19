# ADR-0025 — Time-driven work runs on BullMQ delayed jobs, with the worker in-process

- **Status:** **Accepted** (worker topology revisited when a second deployment unit exists)
- **Date:** 2026-09-19

## Context

Every feature in this repository so far happens **because somebody asked for
it**. A request arrives, a handler runs, a response goes back. Dispatch is the
first thing that must happen with nobody making a request:
[ADR-0009](ADR-0009-dispatch-model.md) widens the search radius every 30
seconds and gives up at 3 minutes, and
[ADR-0015](ADR-0015-order-lifecycle-states.md) requires that an order nobody
ever reads still reaches `NO_MASTER_FOUND`. Both are clocks, and neither has a
caller.

There was no mechanism at all: no BullMQ, no `@nestjs/schedule`, no cron, no
worker process. `setTimeout` is not a candidate — CLAUDE.md §12 forbids
in-process state two replicas would disagree about, and a rolling deploy would
silently strand every in-flight `SEARCHING` order with no error anywhere.

Two documents had already committed to an answer without anyone executing it.
[`technology-stack.md`](../architecture/technology-stack.md) pinned `bullmq`
and justified `ioredis` as "BullMQ's expected driver";
[`backend-architecture.md`](../architecture/backend-architecture.md)
§ Background jobs already assigned `notifications`, `sms`, `payments` and
`maintenance` queues to it for EPIC 8/10/12. So the real question was not
"which mechanism" so much as "does the committed one actually work on this
stack, and what exactly does wiring it cost".

## Decision

**Deferred work runs on BullMQ delayed jobs against Redis.**

1. `bullmq@6.3.7` and `@nestjs/bullmq@12.0.0`, exact pins in `apps/api`.
2. One queue, `dispatch`. The other four queues
   [`backend-architecture.md`](../architecture/backend-architecture.md) names
   arrive with their Epics, not now.
3. **A second, dedicated `ioredis` connection** for BullMQ, with
   `maxRetriesPerRequest: null`. `REDIS_CLIENT` is untouched.
4. **The worker runs in the API process**, gated by `QUEUE_WORKER_MODE`.
5. Every BullMQ key is written under a configurable `QUEUE_PREFIX`.
6. Feature modules never see a `Queue`. They schedule through
   `DeferredWorkService` and register handlers in
   `DeferredJobHandlerRegistry`; `infra/queue` knows nothing about dispatch.

Jobs are **one-shot delayed jobs**, not repeatable jobs and not Job
Schedulers. A dispatch deadline belongs to one order and fires once; a
recurring schedule is the wrong abstraction for it, and legacy repeatable jobs
are removed in BullMQ 6 anyway.

## Why

### The second Redis connection is mandatory, and this was executed

The claim that a `Worker` refuses a connection carrying `maxRetriesPerRequest`
had been read out of the source but never run. It was run, against the local
Redis, on `bullmq@6.3.7` + `ioredis@6.0.0`:

| Construction                                                              | Result                                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `new Queue(..., { connection })`, `maxRetriesPerRequest: 1`               | **constructed OK**                                                          |
| `new Worker(..., { connection })`, `maxRetriesPerRequest: 1`              | **threw** — `BullMQ: Your redis options maxRetriesPerRequest must be null.` |
| `new Worker(..., { connection })`, `maxRetriesPerRequest: null`           | constructed OK                                                              |
| `new Worker(..., { connection: { host, port } })` (options, not a client) | constructed OK                                                              |

The finding is confirmed, and the shipped source says why: `worker.js` asks
`utils/create-backend.js#createBlockingConnection` for a dedicated blocking
connection, which calls `.duplicate()` on the client it was given — carrying
`maxRetriesPerRequest` onto the duplicate — and `redis-connection.js`'s
`checkBlockingOptions` throws on a blocking connection whose value is set. A
`Queue` never builds a blocking connection, so the same check never fires for
it.

The fourth row is the interesting one: hand BullMQ plain **options** instead of
a client and the same path only warns and silently overrides the value. The
throw is specific to being handed a live client, which is what `@nestjs/bullmq`
is given here.

The constraint is not pedantry. BullMQ's fetch is a blocking `BZPOPMIN` that
sits on the socket for seconds; a client that abandons a command after one
retry would abandon it. And `REDIS_CLIENT`'s `maxRetriesPerRequest: 1` is
equally load-bearing in the other direction —
[`redis.module.ts`](../../apps/api/src/infra/redis/redis.module.ts) explains at
length that `/health/ready` must never queue behind a command. The two clients
want opposite things, so there are two clients. Budget: **three Redis
connections per API replica** — the shared one, the BullMQ one, and the
blocking duplicate BullMQ makes for itself.

`apps/api/src/infra/redis/bullmq-connection.test.ts` pins all four rows, so if
a future BullMQ relaxes this, the second connection stops being justified
loudly instead of quietly.

### Versions, checked against the registry rather than the issue body

| Package          | Pinned   | Evidence (registry, 2026-09-19)                                                                                                         |
| ---------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bullmq`         | `6.3.7`  | `engines: { node: ">=14.17.0" }`; peers `pg >=8.0.0`, `redis >=5.0.0`, `ioredis >=5.0.0`, `bullmq-otel >=2.0.0` — all four **optional** |
| `@nestjs/bullmq` | `12.0.0` | peers `bullmq ^3 \|\| ^4 \|\| ^5 \|\| ^6`, `@nestjs/core` and `@nestjs/common` `^10 \|\| ^11 \|\| ^12`                                  |

Against what this repository actually pins — node `>=24` (running 24.19.0),
`ioredis@6.0.0`, `pg@8.23.0`, `@nestjs/*@12.0.1` — every range is satisfied,
and `@nestjs/bullmq` accepts Nest 12 by a **named major**, not by a loose
range that happens to admit it.

**`6.3.7` rather than `6.3.8`, and deliberately not by adding an exemption.**
`6.3.8` was published 2026-09-18T21:46Z, inside pnpm 11's 24-hour
`minimumReleaseAge` window at the time of writing, so it will not install.
`pnpm-workspace.yaml` calls `minimumReleaseAgeExclude` load-bearing rather than
decoration; the right response to a too-new patch is to take the older one, not
to exempt it. `6.3.7` (2026-09-18T07:00Z) has byte-identical `engines` and
`peerDependencies` — checked, not assumed.

### The residual risk: BullMQ tests against ioredis 5, this repo runs 6

`bullmq@6.3.7`'s peer range is `ioredis >=5.0.0`, but its own devDependency is
`ioredis@5.11.1`. That is the same shape as the NativeWind/Tailwind trap
CLAUDE.md §3 warns about: a range that _accepts_ a major the maintainer does
not test against.

It is **de-risked, not eliminated**. The hazard in ioredis 6 is RESP3 reply
shapes, and BullMQ's correctness rests on Lua scripts whose replies it parses
positionally. `ioredis@6.0.0`'s own defaults set `replyMapping: "legacy"`
(`built/redis/RedisOptions.js`), so every reply shape is what ioredis 5
produced. `@nestjs/bullmq@12.0.0` also devDepends on `ioredis@6.0.0` and
`bullmq@6.3.1`, so this exact pairing is at least exercised upstream.

**The named fallback, if a reply-shape bug ever appears:** set `protocol: 2` on
the BullMQ connection in
[`bullmq-connection.provider.ts`](../../apps/api/src/infra/redis/bullmq-connection.provider.ts).
That is one line, it is local to the queue's client, and it leaves
`REDIS_CLIENT` alone.

### `QueueScheduler` does not exist, whatever the guide says

Published BullMQ material still tells you to construct a `QueueScheduler`
alongside a `Worker` so delayed jobs get promoted. There is no such export in
the shipped package — `dist/cjs/classes/` has no `queue-scheduler.js`, and
`index.js` exports none. Workers promote the delayed set themselves in v6.
CLAUDE.md §9's rule applies: the artifact wins over the document.

### The prefix exists for the same reason `RATE_LIMIT_KEY_SECRET` does

Redis is shared. Two checkouts, or a CI job and a developer's `pnpm test`,
point at one container. With a constant key prefix, one run's worker consumes
the other run's delayed jobs — a failure that reads as a flaky test and is
actually cross-talk. `QUEUE_PREFIX` namespaces the key space the way the
rate limiter's pepper namespaces its counters; `test/setup-env.ts` gives each
test process its own.

## Alternatives considered

| Option                                                                        | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`@nestjs/schedule`** (a cron/interval sweep over `SEARCHING` orders)        | Every replica runs every tick. Three replicas means three sweeps of the same rows on the same schedule, and the only defence is a distributed lock — which is a queue, built worse. CLAUDE.md §12 states the rule directly: no in-process state two instances would disagree about, and the API must be horizontally scalable. It also converts a per-order deadline into a polling interval, so a 30-second radius step becomes "somewhere between 30 and 30 + the sweep period".                                                                                                                           |
| **A hand-built Postgres queue** (`FOR UPDATE SKIP LOCKED`)                    | Genuinely correct, and attractive while Postgres is the only datastore that matters. It is rejected on **count of mechanisms, not on correctness**: `backend-architecture.md` has already committed `notifications`, `sms`, `payments` and `maintenance` to BullMQ for EPIC 8/10/12, so building this would mean maintaining two queueing systems from EPIC 10 onwards — two retry policies, two dead-letter stories, two shutdown paths, two things to reason about at 3am. It would also put the poll loop on the primary database, which is the one resource the order flow cannot afford to contend for. |
| **BullMQ's own PostgreSQL backend** (`bullmq/postgres`)                       | Considered seriously — it would collapse Redis and Postgres into one datastore. **Deferred, not refused.** BullMQ 6.0.0 shipped it on 2026-07-30, roughly seven weeks before this ADR, and it is still taking connection-lifecycle fixes. The Redis backend is the path BullMQ has shipped since 2015. Taking a seven-week-old storage backend for the mechanism that decides whether an order ever leaves `SEARCHING` is not a trade this Epic needs to make. Revisit when it has a year of releases behind it.                                                                                             |
| **Repeatable jobs / Job Schedulers**                                          | The wrong abstraction. A dispatch deadline belongs to one order and fires once; a repeatable job is a recurring schedule. Legacy repeatable jobs are removed in v6 and the Job Scheduler API is reshaped, so building on either would also be building on a moving surface for no gain.                                                                                                                                                                                                                                                                                                                      |
| **A second BullMQ connection avoided by handing BullMQ connection _options_** | It works — the fourth row of the table above — but it makes BullMQ open its own clients with defaults this repository has deliberately overridden (notably the retry strategy that must never return `null`; see `redis.module.ts`). The connection count is identical. An explicit client we configure is strictly more legible than options we hope BullMQ applies the way we would.                                                                                                                                                                                                                       |
| **Reusing `REDIS_CLIENT` with `maxRetriesPerRequest` removed**                | Would mean relaxing the one option `/health/ready` depends on for every other consumer of that client — cache, presence, rate limiting. Trading a probe guarantee for one fewer socket is not a trade.                                                                                                                                                                                                                                                                                                                                                                                                       |

## Trade-offs accepted

- **The worker runs in the API process, which contradicts
  [`backend-architecture.md`](../architecture/backend-architecture.md)
  § Background jobs** ("BullMQ, in a separate worker process"). A slow or
  runaway job competes with HTTP handlers for the event loop and for the same
  Postgres pool; a deploy restarts producers and consumers together; the two
  cannot be scaled apart. That is accepted for now because there is no second
  deployment unit and no hosting provider — CLAUDE.md §1 still lists
  hosting as open — and inventing a deployment topology to satisfy a
  document would be inventing a decision nobody has made. The doc has been
  corrected to describe what ships and to point here.
  **`QUEUE_WORKER_MODE` is the half of the extraction that exists today:**
  set it to `off` and a replica produces jobs and consumes none.
  `QUEUE_WORKER_CONCURRENCY` bounds the contention meanwhile and is documented
  to stay well under `DATABASE_POOL_MAX`.
- **Three Redis connections per replica** instead of one. Small, and the price
  of a blocking fetch that is not allowed to starve the readiness probe.
- **A major-version pairing the vendor does not test** (`ioredis@6` under a
  `>=5.0.0` peer), mitigated as described above and with a named one-line
  fallback rather than a hope.
- **A second datastore is now on the critical path of an order's lifecycle.**
  Redis was previously only ever holding things that were legitimately
  ephemeral — presence, cache, rate-limit counters —
  and `technology-stack.md` says so: "Redis holds no permanent business data."
  That still holds literally (the order and its statuses live in Postgres), but
  a lost Redis now means lost _deadlines_, and an order whose give-up job
  vanished sits in `SEARCHING` until something re-drives it. Reconciliation of
  orphaned `SEARCHING` orders belongs to the dispatch engine (#103) and is
  named here so it is not discovered later.
- **`@nestjs/bullmq` is an ESM-only package** (`"type": "module"`) consumed
  from a CommonJS build. Node 24's `require(esm)` handles it and `tsc`
  accepts it under `module: nodenext`; both were executed, not assumed. It is
  still one more thing that could break on a toolchain move.

## Consequences

- `apps/api/src/infra/queue/` exists: a `dispatch` queue, an in-process worker,
  a producer (`DeferredWorkService`) and a handler registry. It contains **no
  dispatch logic** — #103 registers what the job names mean, the same way a
  feature module registers a readiness check without `HealthModule` changing.
- `apps/api/src/infra/redis/` gains a second, clearly-labelled connection.
  `REDIS_CLIENT` is byte-for-byte unchanged.
- `/health/ready` reports a `queue` check. It fails fast rather than parking a
  command in ioredis's offline queue, because this connection cannot fail a
  command by retry count.
- Shutdown drains in `QueueModule.onModuleDestroy` — worker, then queue, then
  the connection — because Nest runs every `onModuleDestroy` before any
  `onApplicationShutdown`, and that ordering is the only thing guaranteeing the
  connection outlives the job in flight. A SIGTERM mid-tick finishes the tick.
- Five new environment variables: `QUEUE_PREFIX`, `QUEUE_WORKER_MODE`,
  `QUEUE_WORKER_CONCURRENCY`, `QUEUE_JOB_ATTEMPTS`, `QUEUE_JOB_BACKOFF_MS`.
- Every deferred job must be **idempotent** and must carry ids rather than
  objects — the rule
  [`backend-architecture.md`](../architecture/backend-architecture.md) already
  states, now with something to enforce it against.

## Revisit when

- **A second deployment unit exists** — i.e. the hosting decision (CLAUDE.md §1,
  EPIC 17) is made, or queue work starts measurably competing with request
  latency. That is the trigger for the separate worker process
  `backend-architecture.md` originally described: a new bootstrap file that
  imports `QueueModule` and the feature modules whose handlers it serves, plus
  `QUEUE_WORKER_MODE=off` on the API. Nothing in `infra/queue` changes.
- **BullMQ's PostgreSQL backend has a year of releases behind it.** Collapsing
  to one datastore removes the "a lost Redis is a lost deadline" trade-off
  above, and this ADR's alternatives table is the argument to re-run, not to
  re-litigate.
- **A reply-shape bug appears under `ioredis@6`.** Apply `protocol: 2` first;
  only then consider pinning `ioredis` back.
- **BullMQ stops throwing on `maxRetriesPerRequest`.**
  `bullmq-connection.test.ts` is what will notice, and the second connection
  becomes removable rather than mandatory.
