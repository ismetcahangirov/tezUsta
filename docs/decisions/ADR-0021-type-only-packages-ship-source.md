# ADR-0021 — A type-only shared package ships TypeScript source and has no build step

- **Status:** **Accepted**
- **Date:** 2026-09-17
- **Decided by:** Engineering

## Context

ADR-0016 settles _when_ a `packages/*` workspace is created — on its second
consumer. It does not settle _how one is distributed_, and `packages/types` is
the first shared package with real content to land: it exists because
`apps/mobile`'s service catalogue (issue #33) needed the same response shapes
`apps/api` had already written for issue #32. Its pattern is what
`packages/validation`, `packages/api-client`, `packages/config` and
`packages/ui` will each be measured against when their own second consumer
arrives.

The two consumers are unusually far apart. `apps/api` is a NestJS server,
compiled by `tsc` to CommonJS under `@tezusta/typescript-config/base.json` —
`module: NodeNext`, `moduleResolution: nodenext`, `verbatimModuleSyntax: true`,
`isolatedModules: true`. `apps/mobile` is bundled by Metro, tested by Jest, and
its Storybook runs on Vite. A package both must agree on is not a neutral
choice: it is read by a bundler that resolves modules its own way, a test
runner that transforms files its own way, and a type checker enforcing
`verbatimModuleSyntax`.

`packages/types` (`apps/api/src/**/*.types.ts` moved to `packages/types/src/`)
holds exactly one kind of content: `CursorPage`, `Service`, `ServiceCategory`,
`ServicePricing` and `ServicePricingKind` — five `type` and `interface`
exports, re-exported from `packages/types/src/index.ts`, and nothing else.
Every one of them is erased by the compiler; none of them exists once
compilation is done.

## Decision

**A shared package whose every export is a `type` or an `interface` ships its
`.ts` source directly, and has no build step.**

Concretely, as `packages/types/package.json` does today:

```json
{
  "type": "module",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "files": ["src"]
}
```

No `tsconfig.json` in the package sets `noEmit: false`. No `build` script
exists. `apps/api/package.json` and `apps/mobile/package.json` both declare
`"@tezusta/types": "workspace:*"` under `dependencies`, not `devDependencies`,
even though nothing in either app's runtime ever loads the module.

Inside the package, the barrel's relative re-export carries the `.js`
extension `nodenext` module resolution requires —
`export type { ... } from './service-catalogue.js'` in
`packages/types/src/index.ts`, even though the file on disk is
`service-catalogue.ts`. `nodenext` resolves the specifier against the `.ts`
file at typecheck time; the import itself is erased before any bundler is
asked to resolve anything, so the extension that satisfies `tsc` never has to
satisfy Metro, Jest or Rolldown.

## Why — get these right, they were all verified

**Nothing is emitted, so nothing needs building.** `verbatimModuleSyntax`
requires `import type { Service } from '@tezusta/types'` for a type-only
import — a plain `import { Service } from ...` is rejected at compile time,
not merely discouraged — and TypeScript erases every `import type` entirely
rather than lowering it to a runtime `require`. This was verified against the
actual build output, not assumed from the spec: `apps/api/dist/**/*.js`
contains zero `require('@tezusta/types')` calls. The only occurrences of the
string anywhere under `dist/` are inside `.d.ts` declaration files and JSDoc
comments. This held even with `emitDecoratorMetadata: true` set, which is the
NestJS setting most likely to drag a type reference into an emit because
decorator metadata sometimes needs a real constructor at runtime — none of
`packages/types`'s exports are classes, so there is no constructor to need.

**`tsc` under `nodenext` needs the `.js` extension on the package's own
internal relative import.** This is a `nodenext`-resolution requirement, not a
stylistic choice — `moduleResolution: nodenext` resolves relative specifiers
the way Node's own ESM loader does, extension and all, and rejects an
extensionless relative import. The specifier resolves to the `.ts` file at
typecheck time and is erased before any bundler ever sees it, so the same line
that satisfies `tsc` is invisible to everything downstream of it.

**It must be a `dependency`, not a `devDependency`, even though nothing needs
it at runtime — say this explicitly, because it is non-obvious enough that
somebody will "fix" it.** `.dependency-cruiser.cjs` runs with
`tsPreCompilationDeps: true`, which makes dependency-cruiser reason about
`import type` edges the same way `tsc` does — before erasure — rather than
skipping them as it would if it only saw post-compilation output. That means
it sees the edge from `apps/api` and `apps/mobile` to `@tezusta/types` as real,
and `not-to-dev-dep` would fire on it were it filed under `devDependencies`.
Moving it there in a moment of "this is just types, surely it's a dev
dependency" produces a `pnpm graph:validate` failure whose message names a
rule, not the reasoning above — which is exactly why the reasoning is recorded
here rather than left to be rediscovered from a CI log.

## Be honest about the enforcement gap

The claim "every tool agrees" is too strong, and stating it that way in
`packages/types/README.md` was wrong. What is actually true divides by tool:

- **`tsc` catches it.** A plain value import —
  `import { Service } from '@tezusta/types'` where `Service` is a type — fails
  with `TS1484` ("is a type and must be imported using a type-only import")
  under `verbatimModuleSyntax`. `pnpm typecheck`, and therefore CI, fails on
  it.
- **Jest does not catch it.** `babel-jest` resolves `@tezusta/types` through
  the pnpm symlink to its realpath, transforms the `.ts` file with Babel
  rather than `tsc`, and hands back a module whose named export is simply
  absent — no error, no warning. A test that imports `Service` as a value gets
  `undefined`, the assertion built on it fails for a reason that looks nothing
  like the actual mistake, and the test run reports the wrong root cause
  rather than no error at all.
- **Metro does not catch it either.** Metro bundles for a device; it does not
  typecheck. The same wrong import that fails `tsc` produces `undefined` at
  the exact place a developer is looking at the running app, inside an
  `expo start` loop that has no typechecking step in it at all.

The honest claim is **"CI catches it, because `pnpm typecheck` runs `tsc`"** —
not "every tool agrees." `pnpm typecheck` is the enforcement gate for this
package's central constraint, and it is a gate with a known blind spot in the
inner dev loop, not a property every tool independently upholds.

## Alternatives considered

**Build the package to `dist/` with `.js` + `.d.ts`, the way a normal npm
package would.** Rejected: it buys the one thing nothing here needs — a
runtime module to `require` — at the cost of a build edge in the graph, a
watch mode to keep running during development, a new stale-output failure
mode (edit `src/`, forget to rebuild, consumer silently reads the old
`dist/`), and a `dist/` directory whose every `.js` file is empty because
every export was erased anyway. Paying a build cost to produce nothing is not
a smaller version of the real problem; it is the whole problem, reproduced for
no reason.

**Ship hand-written `.d.ts` files instead of `.ts` source.** Rejected: a
`.d.ts` file is a declaration format, not a source format. It cannot be linted
by the shared ESLint config the way a `.ts` file can, it is materially more
awkward to review in a diff because it carries none of the surrounding
context a normal type definition would, and it forecloses the package ever
holding a type-level helper — a mapped type, a conditional type, a generic
utility — that needs to be _computed_, not merely declared. `packages/types`
today only declares shapes, but nothing about "type-only package" implies
"never computes a type."

**Keep transcribing contracts by hand in each consumer**, which is exactly
what `apps/mobile/src/auth/auth.types.ts` still does for the auth domain today
because that domain has not yet been extracted. Rejected as the general
pattern, not merely as unappealing: it is two independent definitions of the
same wire contract that can silently drift, and drift between what a client
believes the server sends and what the server actually sends is discovered at
runtime, on a device, by a user — not at review time by a type checker. This
is precisely the cost `packages/types` exists to remove for the service
catalogue, and it remains the reason `auth.types.ts` is the next candidate for
extraction rather than a counterexample to this ADR.

**Publish the package to a registry.** Rejected outright, without further
weighing: this is a private monorepo with two consumers, both inside it.
Publishing buys versioning and access control that nothing here needs, and
introduces a registry as a dependency of the build.

## Consequences

- `packages/validation` will **not** be able to follow this pattern when it is
  created. Zod schemas are runtime values — a `z.object({...})` is a function
  call that must execute, not a type erased at compile time — so the day
  `packages/validation` gets its second consumer, it needs real module output,
  an `exports` map that resolves to JavaScript, and an explicit module-format
  decision (CommonJS, ESM, or both) that this ADR's package never had to make.
  This is the first thing to check when `packages/validation` is created, and
  the check is exactly "does this package still export only types" — the
  moment it does not, this ADR no longer applies to it.
- `CLAUDE.md` §2 and `packages/types/README.md` both state the "ships source,
  no build step" rule in prose; this ADR is where the reasoning and the
  verification evidence live, and both should point here rather than
  restating it.
- `pnpm typecheck` is recorded as the actual enforcement gate for the
  type-only boundary, with Jest and Metro named as the tools that do not
  enforce it, so a future contributor debugging an `undefined` value from
  `@tezusta/types` in a test or in `expo start` has a documented explanation
  rather than a mystery.

## Revisit when

A shared package built on this pattern needs to export a runtime value — the
`packages/validation` case above is the expected first instance — or a
consumer's bundler or test runner stops resolving TypeScript source directly
from a workspace dependency and needs a compiled artifact instead.
