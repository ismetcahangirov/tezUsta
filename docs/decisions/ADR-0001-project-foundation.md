# ADR-0001 — Project foundation: monorepo, package manager, task runner

- **Status:** Accepted
- **Date:** 2026-09-14
- **Supersedes:** —
- **Superseded by:** —

## Context

TezUsta ships at least three deployable artifacts: an Expo mobile app serving
both customers and masters, a NestJS API, and (later) a web admin panel. They
share domain types, validation schemas, and an API client.

We must decide how the code is organised before any of it exists, because the
choice is expensive to reverse once three repositories have diverged.

## Decision

**A single monorepo, using pnpm workspaces for linking and Turborepo for task
orchestration.**

```
apps/       mobile, api, admin
packages/   types, validation, api-client, ui, config, typescript-config, eslint-config
tools/      project-graph
```

`pnpm-workspace.yaml` sets `nodeLinker: hoisted`, because React Native's Metro
bundler and native module autolinking do not reliably traverse pnpm's default
symlinked store.

**Shared packages are created when a second consumer appears, not in advance.**
`packages/typescript-config` and `packages/eslint-config` exist now because both
apps will need them immediately. `packages/ui` and `packages/api-client` are
listed in the architecture but deliberately not created yet.

## Why

The API contract is the single highest-churn interface in this system. In split
repositories, a change to an order's shape is a version bump, a publish, and a
coordinated upgrade — so in practice the types drift and the mismatch is found
at runtime by a user. In a monorepo the mobile app fails to typecheck in the same
pull request that changed the API. That single property justifies the structure.

Turborepo was chosen over Nx because it is a task runner and nothing more. It
caches and orders tasks; it does not own the repository layout, generate code, or
require a plugin per framework. For a repository of this size that is the right
amount of tool. The project-graph capability that would otherwise argue for Nx is
provided by dependency-cruiser (see [ADR-0006](ADR-0006-project-graph-tooling.md))
at a far smaller commitment.

## Alternatives considered

| Option                          | Why not                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate repositories per app   | API/client contract drift, detected at runtime instead of at typecheck. Cross-cutting changes need coordinated PRs across repos.                                     |
| Nx monorepo                     | More capable (affected-task detection, generators, first-class graph) but substantially more opinionated. Adopting it means adopting its Expo and Nest plugin model. |
| npm or Yarn workspaces          | pnpm is faster, strict about phantom dependencies, and far more disk-efficient.                                                                                      |
| Single application, no packages | Would work briefly, then force a rewrite once the admin panel needs the same types.                                                                                  |

## Trade-offs accepted

- **`nodeLinker: hoisted` weakens pnpm's phantom-dependency protection.** A
  workspace can import a package it never declared. Mitigated by the
  dependency-cruiser rule `no-non-package-json`, which fails CI on exactly that.
- **CI runs more than it strictly needs to** until Turborepo's remote cache or
  affected-only filtering is configured. Acceptable at current size.
- **One repository means one set of permissions.** Fine while the team is small;
  revisit if external contractors need scoped access.

## Consequences

- All cross-cutting changes land as one reviewable pull request.
- `pnpm verify` at the root is the single gate for the whole repository.
- Adding an app means adding a directory, not provisioning a repository.
- Architectural boundaries are not implicit — they are enforced by rules in
  `.dependency-cruiser.cjs`.

## Revisit when

- The repository exceeds roughly ten workspaces, or
- CI wall-clock becomes a bottleneck that affected-only execution would fix, or
- A workspace needs an access-control boundary the repository cannot express.
