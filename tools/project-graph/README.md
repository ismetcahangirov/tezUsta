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

| File                | Purpose                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `output/graph.json` | The workspace graph with dependency-cruiser's full per-edge metadata. npm edges are deliberately absent — see below. |
| `output/index.json` | Condensed index: per file `dependsOn`, `dependedOnBy`, `coveredByTests`, workspace, module. **Read this first.**     |
| `output/GRAPH.md`   | Human-readable summary and violation list.                                                                           |

`output/` is committed so a fresh session can read the graph without running an
install first. Regenerate it whenever the rule in
`CLAUDE.md` § Project graph applies (after a feature, refactor, new module,
dependency change, or architecture change).

The output carries **no timestamp, no unordered collection, and no fact about
the machine**: it is a pure function of the source tree. CI regenerates it and
fails when `git diff` is not empty, which is only possible because two runs on
two different machines are byte-identical.

That last part is why `graph.json` holds workspace modules only. Raw cruise
output carries the OS string, the Node version, an absolute `baseDir`, and
node_modules leaves that differ between a laptop and the Linux runner —
optional native packages, case-sensitive resolution, symlink realpaths. The npm
edges are still cruised and still enforced by `pnpm graph:validate`; they are
just not part of a committed artifact, because their content describes the
machine rather than the repository. The generator refuses to write a graph that
contains an absolute path, a backslash, or a node_modules path, so a future
change that reintroduces one fails loudly instead of breaking every pull
request's drift check with an unreadable binary diff.

Do not reintroduce a clock reading or a machine fact into the generator.

## Architecture rules

Boundaries are defined in [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs):

- no circular dependencies
- production code may not import a devDependency
- no dependency that `package.json` does not declare (a phantom dependency,
  which `nodeLinker: hoisted` otherwise permits)
- no deprecated Node core module
- `apps/mobile` may not import `apps/api` (contracts will go through
  `packages/types`, which is created when a second consumer exists — see
  [ADR-0016](../../docs/decisions/ADR-0016-shared-package-timing.md))
- `apps/api` may not import any client app
- `packages/*` may not import `apps/*`

Add a rule when you establish a boundary. A rule is cheaper than rediscovering
the violation later.

**A rule only counts if it can fail.** `includeOnly`, and any `exclude` pattern
that is not anchored to `^(apps|packages|tools)/`, removes npm edges from the
graph before the rule engine sees them and silently disables the three npm
rules above. When you change `options` in `.dependency-cruiser.cjs`, prove the
rules still fire: add a `devDependency` import and an undeclared import to a
source file, confirm `pnpm graph:validate` fails, then revert.
