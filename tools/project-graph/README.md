# Project graph

Machine-readable dependency graph for TezUsta. It exists so an agent (or a
human) can answer _"what breaks if I change this?"_ without reading the whole
repository — see `CLAUDE.md` § Project graph.

## Why dependency-cruiser

Chosen over Madge and Nx graph. Recorded in
[`docs/decisions/ADR-0006-project-graph-tooling.md`](../../docs/decisions/ADR-0006-project-graph-tooling.md).
Short version: it is the only candidate that both **emits a machine-readable
graph** and **enforces architectural boundaries as CI-failing rules**, and it
carries no TypeScript peer-version lock (Madge pins `typescript@^5.4.4`, which
conflicts with this repo's TypeScript 6).

## Commands

```bash
pnpm graph              # regenerate output/
pnpm graph:validate     # fail on architecture rule violations (CI gate)

node tools/project-graph/query.mjs <file>            # impact report
node tools/project-graph/query.mjs --untested apps/api
```

## Output

| File                | Purpose                                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `output/graph.json` | Raw dependency-cruiser result, full fidelity.                                                                    |
| `output/index.json` | Condensed index: per file `dependsOn`, `dependedOnBy`, `coveredByTests`, workspace, module. **Read this first.** |
| `output/GRAPH.md`   | Human-readable summary and violation list.                                                                       |

`output/` is committed so a fresh session can read the graph without running an
install first. Regenerate it whenever the rule in
`CLAUDE.md` § Project graph applies (after a feature, refactor, new module,
dependency change, or architecture change).

## Architecture rules

Boundaries are defined in [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs):

- no circular dependencies
- production code may not import a devDependency
- `apps/mobile` may not import `apps/api` (contracts go through `packages/types`)
- `apps/api` may not import any client app
- `packages/*` may not import `apps/*`

Add a rule when you establish a boundary. A rule is cheaper than rediscovering
the violation later.
