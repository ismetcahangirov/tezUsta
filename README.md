# TezUsta

On-demand marketplace for urgent and small household repair services — plumbing,
locks, electrical, air conditioning, appliances, assembly, painting, cleaning.

A customer describes a problem; TezUsta dispatches a nearby verified professional
("master") and both sides track the job to completion.

**Market:** Azerbaijan (starting in Baku) · **Currency:** AZN

> **Status: foundation.** The engineering environment, architecture, and roadmap
> exist. No business features are implemented yet. Work is driven by GitHub
> Epics and Sub-Issues — see [the roadmap](docs/project-management/roadmap.md).

---

## Start here

| If you are...                                     | Read                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| An engineer (human or agent) working in this repo | **[`CLAUDE.md`](CLAUDE.md)** — the operational rulebook                          |
| Looking for what we chose and why                 | [`docs/architecture/technology-stack.md`](docs/architecture/technology-stack.md) |
| Looking for what we decided and why               | [`docs/decisions/`](docs/decisions/)                                             |
| Trying to understand the product                  | [`docs/product/product-overview.md`](docs/product/product-overview.md)           |
| Planning what to build next                       | [`docs/project-management/roadmap.md`](docs/project-management/roadmap.md)       |

## Stack

| Layer         | Choice                                                       |
| ------------- | ------------------------------------------------------------ |
| Mobile        | Expo SDK 57 · React Native 0.86 · Expo Router · NativeWind 4 |
| Backend       | NestJS 12 on Fastify 5 · TypeScript 6                        |
| Database      | PostgreSQL 17 + **PostGIS** · Drizzle ORM                    |
| Cache / queue | Redis · BullMQ                                               |
| Realtime      | WebSocket + Redis pub/sub                                    |
| State         | Redux Toolkit (client) · RTK Query (server)                  |
| Monorepo      | pnpm workspaces · Turborepo                                  |

**Versions are pinned deliberately, and three are behind "latest" on purpose.**
TypeScript is held at 6.0.3 because `typescript-eslint` does not support 7;
Expo at 57 because 58 is a `preview` release; Tailwind at 3.4.17 because
NativeWind v4 requires the Tailwind 3 engine despite its peer range accepting 4.

Do not upgrade these without reading
[ADR-0002](docs/decisions/ADR-0002-toolchain-version-pinning.md).

## Repository layout

`✓` exists today; everything else is planned.

```
apps/
✓ mobile/            Expo app — customer and master in one binary
  api/               NestJS on Fastify                   (planned, EPIC 1)
  admin/             Web admin panel                     (planned, EPIC 13)
packages/
✓ typescript-config/ Shared tsconfig presets
✓ eslint-config/     Shared flat ESLint config
  types · validation · api-client · ui · config          (planned)
tools/project-graph/ dependency graph + architecture rule enforcement
docs/                product · architecture · engineering · decisions · project-management
.claude/             skills · agents · commands
```

A `packages/*` workspace is created when a second consumer exists, not before —
[ADR-0016](docs/decisions/ADR-0016-shared-package-timing.md). Until then the
code lives in its single consumer.

## Getting started

Requires **Node 24**, **pnpm 11**, and Docker.

```bash
pnpm install
cp .env.example .env      # fill in real values; never commit .env
pnpm verify               # the full PR gate — see below
pnpm dev                  # today: the Expo app
```

`apps/mobile` is scaffolded and runnable, with the design system and Storybook
in place. `apps/api` has landed (EPIC 1) with health endpoints, validated
configuration, and the database layer; no business feature exists yet in
either.

## Local development environment

`docker-compose.yml` at the repo root brings up Postgres (with PostGIS) and
Redis for local work against `apps/api`. The Postgres image
(`postgis/postgis:17-3.5`) must stay in step with the `postgres:` service in
[`.github/workflows/ci.yml`](.github/workflows/ci.yml) — CI and local dev run
the identical database.

```bash
cp .env.example .env      # fill in real values; never commit .env
docker compose up -d
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
docker compose up -d
```

Verify both services are healthy:

```bash
docker compose ps
docker compose exec postgres psql -U tezusta -d tezusta -c "SELECT PostGIS_Version();"
docker compose exec redis redis-cli ping   # expect PONG
```

`docker compose down` stops the containers and keeps the named volumes
(`tezusta_pgdata`, `tezusta_redisdata`), so data survives a restart.
`docker compose down -v` additionally destroys those volumes — use it only
when you want a clean database.

### Running database migrations

`apps/api`'s Drizzle migrations live in
[`apps/api/src/infra/database/migrations`](apps/api/src/infra/database/migrations)
(the first one runs `CREATE EXTENSION IF NOT EXISTS postgis;`) and are applied
by a dedicated script, never automatically at application boot: CLAUDE.md §12
requires the API to be horizontally scalable, and two instances migrating on
boot would race each other against the same database. Run it as its own step,
after building:

```bash
pnpm --filter api build
pnpm --filter api db:migrate
```

`db:migrate` runs the compiled `dist/infra/database/migrate.js` against
`DATABASE_URL` (via the same `apps/api/.env` / environment `ConfigModule`
reads for everything else — see
[`docs/architecture/backend-architecture.md`](docs/architecture/backend-architecture.md)
§ Configuration). Re-running it is a no-op: Drizzle records applied migrations
in `drizzle.__drizzle_migrations` and only executes what's new.

### Running the mobile app against the local API

`apps/mobile` reads exactly one variable to decide where the API is —
`EXPO_PUBLIC_API_URL` (`apps/mobile/src/api/base-query.ts`). There is no
hardcoded URL anywhere in the app, so pointing it somewhere else is a config
change, never a code change. Metro **inlines** `EXPO_PUBLIC_*` at bundle time,
so changing it requires restarting the dev server, not just reloading the app.

Bring the API up first — it must be reachable, not merely built:

```bash
docker compose up -d
pnpm --filter api build
pnpm --filter api db:migrate
pnpm --filter api db:seed     # so the catalogue has something to render
pnpm --filter api dev
curl http://localhost:3000/health/ready
```

Then put the right host in `apps/mobile/.env` (gitignored; Expo loads it from
the app directory, not the repo root). **The right host depends on where the app
runs, and this is the single most common reason a first attempt fails:**

| Where the app runs               | `EXPO_PUBLIC_API_URL`       | Why                                                                                                                                                                                                                     |
| -------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (`pnpm --filter mobile web`) | `http://localhost:3000`     | Same machine, ordinary browser origin.                                                                                                                                                                                  |
| Android emulator                 | `http://10.0.2.2:3000`      | `localhost` inside the AVD is the **emulator itself**. `10.0.2.2` is the standard alias for the host machine.                                                                                                           |
| iOS simulator                    | `http://localhost:3000`     | The simulator shares the host's network stack.                                                                                                                                                                          |
| Physical device                  | `http://<your LAN IP>:3000` | The phone is a different machine. `API_HOST=0.0.0.0` (the default) is what makes the API reachable off `127.0.0.1`; the device must be on the same network, and a host firewall prompt usually has to be accepted once. |

```bash
echo 'EXPO_PUBLIC_API_URL=http://10.0.2.2:3000' > apps/mobile/.env
pnpm --filter mobile android      # or: web / ios
```

The customer home screen renders the catalogue from `GET /services` and
`GET /service-categories`. Data on that screen came over the network — the app
ships no hardcoded catalogue, which `src/service-catalogue/no-hardcoded-catalogue.test.ts`
asserts.

To see the failure path, stop the API (Ctrl-C in its terminal) and pull to
refresh: the screen shows an error state with a retry button rather than
hanging or crashing. Bring the API back and retry succeeds.

Android blocks cleartext HTTP by default on modern API levels. Nothing in this
repository weakens that: development runs inside Expo Go (or a debug dev
client), which permits cleartext for local work, and a **release** build keeps
the platform default. If a future release build has to reach an `http://`
endpoint, that is a network-security-config change with its own ADR, not a flag
flipped here.

## Commands

```bash
pnpm verify          # format:check + lint + typecheck + test + build + graph:validate
pnpm test            # every workspace test suite
pnpm lint            # root tooling, packages/*, and each app's own config
pnpm typecheck       # every workspace that contains TypeScript
pnpm build           # a no-op until a workspace defines a build script
pnpm format          # apply Prettier

pnpm graph           # regenerate the project dependency graph
pnpm graph:check     # regenerate and fail if the committed graph moved
pnpm graph:validate  # enforce architecture boundaries (CI gate)

node tools/project-graph/query.mjs <file>              # blast radius of a change
node tools/project-graph/query.mjs --untested apps/api # files with no test
```

## The project graph

Answers _"what breaks if I change this?"_ without reading the whole repository —
and enforces architectural boundaries as CI-failing rules: no circular
dependencies, no devDependency imported from production code, no undeclared
(phantom) dependency, no deprecated Node core module, `apps/mobile` may not
import `apps/api`, `apps/api` may not import a client app, and `packages/*` may
not import `apps/*`.

The output is deterministic — no timestamp, every collection sorted — so CI can
tell a stale committed graph from a current one.

See [`tools/project-graph/`](tools/project-graph/).

## Contributing

1. Read [`CLAUDE.md`](CLAUDE.md).
2. Every change starts from a GitHub Issue.
3. Branch from a fresh `main` — never commit to `main` directly.
4. `pnpm verify` must pass before opening a PR.
5. Conventional Commits.

Details: [`docs/engineering/git-workflow.md`](docs/engineering/git-workflow.md)
and [`docs/engineering/github-workflow.md`](docs/engineering/github-workflow.md).

## Security

This repository is **public**. Never commit secrets, and never open a public
issue for a vulnerability — an issue is a disclosure. Contact the repository
owner directly.

See [`docs/engineering/security.md`](docs/engineering/security.md).

## Open decisions

These are blocked on the project owner and are **not** decided by engineering:
the SMS provider, the object storage provider, whether TezUsta holds customer
funds, the payment provider, the commission rate and price guardrails, master
verification criteria, cancellation policy, hosting, account recovery when a
phone number is lost, languages at launch, whether in-app chat ships at launch,
and the owner-supplied artwork.

The sign-in method, admin sign-in, dispatch model, pricing ownership, the price
freeze point, the order lifecycle, payment methods, maps provider, the design
system, and the component workshop are **decided** — see
[`docs/decisions/`](docs/decisions/). `CLAUDE.md` carries the authoritative list
of both.

Tracked in [`docs/decisions/`](docs/decisions/) and
[`docs/project-management/roadmap.md`](docs/project-management/roadmap.md).
