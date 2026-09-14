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
| State         | TanStack Query (server) · Zustand (client)                   |
| Monorepo      | pnpm workspaces · Turborepo                                  |

**Versions are pinned deliberately, and three are behind "latest" on purpose.**
TypeScript is held at 6.0.3 because `typescript-eslint` does not support 7;
Expo at 57 because 58 is a `preview` release; Tailwind at 3.4.17 because
NativeWind v4 requires the Tailwind 3 engine despite its peer range accepting 4.

Do not upgrade these without reading
[ADR-0002](docs/decisions/ADR-0002-toolchain-version-pinning.md).

## Repository layout

```
apps/                mobile · api · admin          (scaffolded in EPIC 1)
packages/            types · validation · api-client · ui · config
                     typescript-config · eslint-config
tools/project-graph/ dependency graph + architecture rule enforcement
docs/                product · architecture · engineering · decisions · project-management
.claude/             skills · agents · commands
```

## Getting started

Requires **Node 24**, **pnpm 11**, and Docker.

```bash
pnpm install
cp .env.example .env      # fill in real values; never commit .env
pnpm verify               # format + lint + typecheck + test + graph:validate
```

`apps/*` are scaffolded in EPIC 1; until then `pnpm dev` has nothing to run.

## Commands

```bash
pnpm verify          # the full gate that must pass before a PR
pnpm test            # all tests
pnpm lint            # all workspaces
pnpm typecheck       # all workspaces
pnpm build           # all workspaces
pnpm format          # apply Prettier

pnpm graph           # regenerate the project dependency graph
pnpm graph:validate  # enforce architecture boundaries (CI gate)

node tools/project-graph/query.mjs <file>              # blast radius of a change
node tools/project-graph/query.mjs --untested apps/api # files with no test
```

## The project graph

Answers _"what breaks if I change this?"_ without reading the whole repository —
and enforces architectural boundaries as CI-failing rules (`apps/mobile` may not
import `apps/api`, `packages/*` may not import `apps/*`, no circular
dependencies).

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
master verification criteria, cancellation policy, account recovery when a phone
number is lost, and the storage, payment, and SMS providers.

The design system, dispatch model, pricing ownership, payment methods, and maps
provider are now **decided** — see [`docs/decisions/`](docs/decisions/).

Tracked in [`docs/decisions/`](docs/decisions/) and
[`docs/project-management/roadmap.md`](docs/project-management/roadmap.md).
