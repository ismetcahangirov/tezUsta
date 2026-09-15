# System design

Runtime topology, scaling, and operations. Component-level design lives in the
sibling documents.

## Environments

| Environment    | Purpose                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| **local**      | Docker Compose: Postgres+PostGIS, Redis. API and mobile run on the host. |
| **staging**    | Production-shaped, non-production data. Where migrations are rehearsed.  |
| **production** | Real users.                                                              |

Staging must run the **same** Postgres and PostGIS versions as production. A
migration rehearsed against a different version has not been rehearsed.

**Staging uses non-production credentials for every third party.** A staging
environment holding live SMS or payment credentials spends real money and can
touch real customers ([ADR-0008](../decisions/ADR-0008-otp-delivery.md)).

## Topology

```
                      ┌──────────────────┐
      clients ───────►│  Load balancer   │  TLS termination
                      └────────┬─────────┘
                               ▼
                 ┌─────────────────────────┐
                 │   api × N  (stateless)  │
                 │   HTTP + WebSocket      │
                 └──┬───────────────────┬──┘
                    ▼                   ▼
        ┌──────────────────┐   ┌────────────────┐
        │ Postgres primary │   │     Redis      │
        │   + PostGIS      │   │ cache/presence │
        │   + replica      │   │ pub/sub, locks │
        └──────────────────┘   └────────┬───────┘
                    ▲                   ▼
                    │          ┌────────────────┐
                    └──────────│ BullMQ workers │
                               └────────────────┘
                                        │
                               ┌────────────────┐
                               │  S3-compatible │
                               └────────────────┘
```

## Scaling model

**API instances are stateless.** Any instance can serve any request, including a
WebSocket upgrade. That property is what makes horizontal scaling and
zero-downtime deploys possible, and it is why WebSocket fan-out goes through
Redis pub/sub rather than sticky sessions
([`realtime-architecture.md`](realtime-architecture.md)).

**Anything that would break statelessness is a design error** — in-memory
session state, an in-process rate-limit counter, a local job queue, a cached
value two instances would disagree about.

### Scaling order, as load grows

1. Add API instances (cheap, immediate).
2. Move reads to a Postgres replica — but keep the nearby-masters query and all
   order writes on the primary. Replica lag would show a master an order that is
   already taken.
3. Cache current master positions in Redis, with Postgres as the durable record.
4. Scale queue workers separately from the API.
5. Only then consider extracting a module into its own service
   ([`architecture-overview.md`](architecture-overview.md)).

**Do not start at step 5.**

### Expected bottlenecks

| Bottleneck           | Why                                              | First response                                                 |
| -------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| Nearby-masters query | Runs on every order; joins and spatial filtering | GiST index (present from day one), then a Redis position cache |
| Location ingest      | Highest-frequency write in the system            | Distance filtering on-device, batching, append-only writes     |
| WebSocket fan-out    | Grows with concurrent users                      | Redis pub/sub; keep payloads to ids                            |
| Push notifications   | Bursty                                           | Queued, never inline in a request                              |

## Local development

```bash
docker compose up -d     # Postgres+PostGIS, Redis
pnpm install
pnpm dev
```

The compose file arrives with `apps/api`; until then `pnpm install && pnpm dev`
is the whole loop, because nothing in the tree talks to a database yet.

Requirements:

- **One command** brings up dependencies. A setup that needs a person to install
  PostGIS by hand will be wrong on someone's machine.
- The local Postgres image must include PostGIS.
- Seed data creates a usable catalogue, a verified master, and a customer — so
  the app is explorable without manual database work.
- `.env` is copied from `.env.example`; the process **fails at startup** on a
  missing variable ([`backend-architecture.md`](backend-architecture.md)).

## CI

`.github/workflows/ci.yml` runs on every push and pull request:

```
install → format:check → lint → typecheck → test → build → graph:validate → graph:check
```

`pnpm verify` runs the same chain up to `graph:validate` locally, so a green
`verify` is a genuine prediction of CI rather than a partial one.

- **`graph:validate` is a required gate**, not advisory. It is what makes the
  architecture boundaries real ([ADR-0006](../decisions/ADR-0006-project-graph-tooling.md)).
- **`graph:check` regenerates the graph and fails on a non-empty diff.** A
  committed graph that no longer matches the tree is worse than no graph, because
  it answers "what breaks if I change this?" with stale confidence. The generator
  emits no timestamp, so the diff is empty unless the dependency structure
  actually moved.
- **`pnpm build` is a no-op today.** No workspace defines a `build` script yet —
  Expo builds through EAS, not through Turborepo — so the step passes trivially
  and becomes a real gate when `apps/api` lands. It stays in the chain so that
  the first workspace with a build is covered on the day it is added, rather than
  needing CI edited at the same time.
- Integration tests run against a real Postgres+PostGIS service container. Mocking
  the database would not test the spatial queries, which is where the risk is.
- CI never has production credentials.

## Deployment

- Migrations run **before** the new code, and must be backward-compatible with
  the currently-running version — during a rolling deploy both versions are live
  simultaneously.
- Destructive schema changes are two-step across releases: stop using the column,
  release, then drop it.
- Health endpoints: `/health/live` (process up) and `/health/ready` (dependencies
  reachable). The load balancer uses readiness so an instance that cannot reach
  Postgres is removed rather than serving errors.
- Deploys are rolling, with the old version draining. WebSocket clients reconnect
  with backoff and jitter.

## Observability

Minimum viable, from the first deploy — not added after the first incident:

| Signal               | Requirement                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Structured logs**  | JSON, with a `requestId` correlating client, API, and worker                                                                     |
| **Metrics**          | Request rate/latency/errors; queue depth; WebSocket connections; nearby-query latency                                            |
| **Business metrics** | Orders created vs filled, time-to-accept, cancellation rate — these detect a broken marketplace faster than any technical metric |
| **Errors**           | Aggregated with context and the `requestId`                                                                                      |
| **Alerts**           | Queue depth growing, dead-letter jobs, error-rate spike, unfilled-order rate                                                     |

**Never log** tokens, OTP codes, full phone numbers, precise coordinates, or
payment details ([`../engineering/security.md`](../engineering/security.md)).

## Backup and recovery

- Automated Postgres backups with point-in-time recovery.
- **Restores are tested.** An untested backup is a belief, not a backup.
- Redis needs no backup by design — it holds nothing that must survive
  (`architecture-overview.md`, invariant 7). Losing Redis costs presence and
  cache, both of which rebuild.
- Object storage is versioned or replicated; order photos are dispute evidence.
