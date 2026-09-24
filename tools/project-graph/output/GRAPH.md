# TezUsta project graph

<!-- GENERATED FILE — do not edit. Run `pnpm graph` to regenerate. -->

Scanned: apps, packages, tools

## Totals

- Files: **995**
- Test files: **297**
- Architecture rule violations: **0**

## Workspaces

| Workspace | Files | Tests | Files with no direct test |
| --- | ---: | ---: | ---: |
| `apps/admin` | 49 | 10 | 31 |
| `apps/api` | 509 | 153 | 204 |
| `apps/mobile` | 410 | 134 | 121 |
| `packages/eslint-config` | 2 | 0 | 2 |
| `packages/types` | 22 | 0 | 21 |
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
