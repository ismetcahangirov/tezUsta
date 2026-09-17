# `@tezusta/types`

The wire contracts `apps/api` serves and `apps/mobile` consumes.

**Created on the second consumer, not before**
([ADR-0016](../../docs/decisions/ADR-0016-shared-package-timing.md)). It exists
from the moment `apps/mobile` needed the service-catalogue response shapes
(issue #33) and not from the moment `apps/api` first wrote them (issue #32),
which is why the extraction is its own commit with no behaviour change in it.

## It ships TypeScript source, and has no build step

Every export here is a `type` or an `interface`. Nothing in this package exists
at runtime, so `verbatimModuleSyntax` erases every `import type` from it before
a bundler ever resolves the module. A `dist/` would be an empty JavaScript
file, a build edge, and a thing to keep in step. Full reasoning and the
verification evidence: [ADR-0021](../../docs/decisions/ADR-0021-type-only-packages-ship-source.md).

**This is not "every tool agrees" — it is an enforcement gap, and the gate is
`pnpm typecheck`.** A plain value import
(`import { Service } from '@tezusta/types'`, where a type-only
`import type` was required) fails `tsc` with `TS1484` under
`verbatimModuleSyntax`, so `pnpm typecheck` and CI catch it. It does **not**
fail under Jest: `babel-jest` resolves through the pnpm symlink, transforms
the `.ts` file with Babel instead of `tsc`, and hands back a module whose
named export is simply `undefined` — the test runs, and fails for a reason
that does not point at the actual mistake. Metro does not typecheck either,
so the same wrong import surfaces as `undefined` inside a running
`expo start` session with no error at all. See ADR-0021 for the full account.

**This holds only while the package stays type-only.** The first `const`,
`enum` or function added here changes that: it becomes a real runtime
dependency of a React Native bundle and needs a build step, an `exports` map
that resolves to JavaScript, and a decision about the module format. Put a
runtime value somewhere else, or accept that cost deliberately.

## What belongs here

A shape that crosses the HTTP boundary, and nothing else. A database row type,
a Drizzle inference, a Nest or Fastify type and a React type all stay in the
workspace that owns them — this package is imported by both an app that runs on
a phone and a server that talks to Postgres, and it must be uninteresting to
both.
