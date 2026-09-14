# ADR-0006 — Project graph tooling: dependency-cruiser

- **Status:** Accepted
- **Date:** 2026-09-14
- **Supersedes:** —
- **Superseded by:** —

## Context

CLAUDE.md §14 and §19 require that an agent be able to answer, before editing
any file:

- What imports this? (blast radius)
- What does it depend on?
- Which tests cover it?
- Which modules are affected?

Answering those by reading the repository is slow and unreliable, and it gets
worse as the codebase grows. We need a machine-readable dependency graph.

Separately, we have architectural boundaries that must not be crossed —
`apps/mobile` must never import `apps/api`, `packages/*` must never import
`apps/*`. A boundary nobody enforces is a suggestion.

## Decision

**dependency-cruiser 18.3.0**, wired into `tools/project-graph/`:

| Command                                                  | Purpose                                              |
| -------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm graph`                                             | Regenerate `output/{graph.json,index.json,GRAPH.md}` |
| `pnpm graph:validate`                                    | Fail CI on any architecture rule violation           |
| `node tools/project-graph/query.mjs <file>`              | Blast-radius report for one file                     |
| `node tools/project-graph/query.mjs --untested <prefix>` | Files with no covering test                          |

`output/` is committed so a fresh session can read the graph without installing
first.

## Why

**It does both jobs.** dependency-cruiser emits a machine-readable graph _and_
enforces boundaries as rules that fail CI. Every alternative does only the first.
A graph that is never enforced decays into a picture nobody looks at.

**Decisive compatibility fact.** Checked against registry metadata on 2026-09-14:

```
madge@8.0.0                peer:    typescript ^5.4.4
dependency-cruiser@18.3.0  peer:    (none)
                           engines: node ^22||^24||>=26
```

Madge's TypeScript peer conflicts directly with this repository's TypeScript 6
pin ([ADR-0002](ADR-0002-toolchain-version-pinning.md)). dependency-cruiser
declares no TypeScript peer at all — it parses with its own acorn-based
pipeline — and its Node range matches our Node 24.

This is not a preference. Madge is disqualified by a hard constraint.

## Alternatives considered

| Option                                      | Why not                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Madge**                                   | Peer-locks `typescript@^5.4.4`, incompatible with our TypeScript 6 pin. Also visualisation-only: it finds circular dependencies but cannot express "mobile must not import api". |
| **Nx graph**                                | Excellent, but only available by adopting Nx as the build system — rejected in [ADR-0001](ADR-0001-project-foundation.md). Far too large a commitment for one capability.        |
| **Custom TypeScript compiler API analysis** | Maximum flexibility, but it means owning a parser, a resolver, and a monorepo-aware module map. That is a project, not a tool choice.                                            |
| **ESLint `import/no-restricted-paths`**     | Can enforce boundaries, but produces no graph and no blast-radius query. Complementary at best, not a substitute.                                                                |

## What the graph adds on top of dependency-cruiser

Raw dependency-cruiser output is verbose and shaped for reporting, not for
answering questions. `generate.mjs` post-processes it into `index.json`, a
condensed per-file index:

```json
{
  "apps/api/src/modules/orders/orders.service.ts": {
    "workspace": "apps/api",
    "module": "apps/api/src/modules/orders",
    "isTest": false,
    "dependsOn": ["..."],
    "dependedOnBy": ["..."],
    "coveredByTests": ["..."],
    "orphan": false
  }
}
```

`coveredByTests` is derived by intersecting reverse dependencies with the test
file pattern. It is a **proxy for coverage, not a coverage report**: it shows
which test files import a module, not which lines they exercise. Use it to find
files with _no_ test at all; use the actual coverage report for anything finer.

## Rules currently enforced

Defined in `.dependency-cruiser.cjs`:

| Rule                          | Severity | Why                                                                                                                       |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `no-circular`                 | error    | Circular dependencies cannot be reasoned about or tested in isolation.                                                    |
| `not-to-dev-dep`              | error    | A devDependency imported by production code is absent in the deployed image.                                              |
| `no-non-package-json`         | error    | Catches phantom dependencies, which `nodeLinker: hoisted` otherwise permits ([ADR-0001](ADR-0001-project-foundation.md)). |
| `no-deprecated-core`          | error    | Deprecated Node core modules will be removed.                                                                             |
| `mobile-not-into-api`         | error    | The client talks to the server over HTTP/WS; contracts go through `packages/types`.                                       |
| `api-not-into-client`         | error    | The backend must never depend on a client application.                                                                    |
| `shared-packages-stay-shared` | error    | A package importing an app inverts the dependency direction.                                                              |
| `no-orphans`                  | warn     | Usually dead code. `tools/*` is excluded — those are CLI entry points.                                                    |

**Add a rule whenever a boundary is established.** A rule costs one entry;
rediscovering the violation later costs a refactor.

## Trade-offs accepted

- **Another tool in the chain.** Accepted: it replaces both a graph tool and a
  set of custom lint rules.
- **`output/` is committed**, so it can go stale. Mitigated by CLAUDE.md §14
  requiring regeneration, and by `graph:validate` running in CI regardless of
  the committed artifact.
- **Static analysis only.** Runtime-only coupling — a dynamically constructed
  import, a string-keyed DI token — is invisible to it. Nest's DI in particular
  is resolved at runtime; the graph sees the `import`, which is enough for blast
  radius but does not model the injection edge.

## Revisit when

- The repository adopts Nx (the graph would come with it), or
- Runtime-coupling blind spots start causing missed regressions, at which point
  add complementary runtime tracing rather than replacing this.
