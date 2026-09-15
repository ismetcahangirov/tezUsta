---
name: project-graph-query
description: Use BEFORE editing existing TezUsta code to find what depends on it, what it depends on, and which tests cover it — and after structural changes to regenerate the graph. Triggers on "what uses this", "blast radius", "what will break", "refactor", "rename", "delete", or modifying any shared code.
---

# Query the project graph before you edit

CLAUDE.md §19 requires knowing the blast radius before modifying existing code.
The graph answers that in one command instead of a repository-wide search.

## Impact report for a file

```bash
node tools/project-graph/query.mjs apps/api/src/modules/orders/orders.service.ts
```

```
=== apps/api/src/modules/orders/orders.service.ts ===
workspace: apps/api
module:    apps/api/src/modules/orders

Depends on (4):                      ← what this file needs
Depended on by (blast radius) (7):   ← what breaks if you change it
Covered by tests (2):                ← run these after editing
Affected modules (3):                ← what else to re-verify
```

A substring works too:

```bash
node tools/project-graph/query.mjs orders.service
```

## Find files with no test

```bash
node tools/project-graph/query.mjs --untested apps/api
```

**Know what this means.** It shows which files no test file _imports_ — not which
lines are exercised. Use it to find files with **no test at all**; use the
coverage report for anything finer.

## Regenerate

```bash
pnpm graph        # regenerate output/
pnpm graph:check  # regenerate and fail if the committed output moved
```

Required after: a feature, a refactor, a new module, a dependency change, or an
architecture change (CLAUDE.md §14).

`graph:check` is a CI gate. It is meaningful because the generator reads **no
clock** and sorts every collection, so two runs on the same tree are
byte-identical and a non-empty diff means the source tree actually moved. Do not
reintroduce a timestamp or an unordered collection into the generator — it would
make every run produce a diff, and a signal that always fires is a signal nobody
reads.

## Enforce the boundaries

```bash
pnpm graph:validate
```

This is a **required CI gate**, not advisory. It is what makes the architecture
boundaries real rather than aspirational.

Rules in `.dependency-cruiser.cjs`:

| Rule                          |                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `no-circular`                 | Anywhere                                                                                                                                                                                     |
| `not-to-dev-dep`              | A devDependency in production code is absent in the deployed image                                                                                                                           |
| `no-non-package-json`         | Phantom dependencies — which `nodeLinker: hoisted` otherwise permits                                                                                                                         |
| `no-deprecated-core`          | A deprecated Node core module disappears in a future runtime                                                                                                                                 |
| `mobile-not-into-api`         | The client talks over HTTP/WS. Contracts will go through `packages/types`, which is created when a second consumer exists (`ADR-0016`); until then they live in `apps/api/src/**/*.types.ts` |
| `api-not-into-client`         | The backend never depends on a client                                                                                                                                                        |
| `shared-packages-stay-shared` | `packages/*` importing `apps/*` inverts the dependency direction                                                                                                                             |

**Add a rule whenever you establish a boundary.** One entry now is cheaper than
a refactor later.

### The npm rules are easy to silence by accident

`not-to-dev-dep`, `no-non-package-json` and `no-deprecated-core` all reason about
edges into `node_modules`. Three of them once could not produce a violation at
all, because the configuration removed those edges before the rule engine saw
them:

- **`includeOnly`** drops every module outside its pattern — including every npm
  package. Do not reintroduce one.
- **`node_modules` in `exclude`** (rather than `doNotFollow`) does the same.
  `doNotFollow` records the typed edge and stops there; `exclude` deletes it.
- **An unanchored `exclude` pattern** such as `(^|/)dist/` also matches
  `node_modules/vite/dist/index.js`, silently dropping any package whose entry
  point sits in a `dist/` folder. Every exclude is anchored to `^(apps|packages|tools)/`
  for exactly this reason.

The failure mode is invisible: the gate still passes, and it now proves nothing.

**So changing anything under `options:` in `.dependency-cruiser.cjs` must be
proved with an injection test.** Deliberately introduce a violation — import a
devDependency from production code, or import a package that `package.json` does
not declare — confirm `pnpm graph:validate` **fails**, then revert it. A rule you
have not seen fail is a rule you have not tested.

## Reading the raw index directly

`tools/project-graph/output/index.json` is the machine-readable source of truth
and is committed, so it can be read without installing:

```json
{
  "files": {
    "<path>": {
      "workspace": "apps/api",
      "module": "apps/api/src/modules/orders",
      "isTest": false,
      "dependsOn": [],
      "dependedOnBy": [],
      "coveredByTests": [],
      "orphan": false
    }
  }
}
```

Prefer this over crawling the repository.

## Workflow when changing shared code

```
1. node tools/project-graph/query.mjs <file>     # blast radius
2. Read the dependents — will the change break them?
3. Make the change
4. Run the tests listed under "Covered by tests"
5. Run the tests of the affected modules too
6. pnpm graph          (if structure changed — commit the regenerated output)
7. pnpm graph:validate
8. pnpm graph:check    (what CI will run; fails if the committed graph is stale)
```

## Limitation — know it

This is **static analysis**. Runtime-only coupling is invisible to it:

- NestJS DI resolved by token at runtime
- Dynamically constructed imports
- String-keyed lookups

The graph sees the `import` statement, which is enough for blast radius, but it
does **not** model the injection edge. For a Nest module, also check which modules
list it in their `imports` array.
