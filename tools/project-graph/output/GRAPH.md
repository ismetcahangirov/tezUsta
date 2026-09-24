# TezUsta project graph

<!-- GENERATED FILE — do not edit. Run `pnpm graph` to regenerate. -->

Scanned: apps, packages, tools

## Totals

- Files: **787**
- Test files: **237**
- Architecture rule violations: **0**

## Workspaces

| Workspace | Files | Tests | Files with no direct test |
| --- | ---: | ---: | ---: |
| `apps/api` | 424 | 127 | 168 |
| `apps/mobile` | 339 | 110 | 104 |
| `packages/eslint-config` | 2 | 0 | 2 |
| `packages/types` | 19 | 0 | 18 |
| `tools/project-graph` | 3 | 0 | 3 |

## Architecture rule violations

_None._

## How to query this graph

```bash
pnpm graph                                  # regenerate
node tools/project-graph/query.mjs <path>   # impact of changing a file
```

`output/index.json` is the machine-readable source of truth. For any file it
records `dependsOn`, `dependedOnBy`, `coveredByTests`, and its owning
workspace/module — read that instead of crawling the repository.
