# Coding standards

Formatting is automated (Prettier) and not a matter of opinion. This document
covers what a formatter cannot decide.

## TypeScript

**Strict mode, everywhere.** `tsconfig.base.json` enables `strict`,
`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`,
`noUnusedLocals`, and `noUnusedParameters`.

### `any` is forbidden

`@typescript-eslint/no-explicit-any` is an **error**, not a warning.

```ts
// Forbidden — silences the compiler and the reason
const data = response as any;

// Use unknown and narrow it
const data: unknown = await response.json();
const order = orderSchema.parse(data); // Zod gives the type and the guarantee
```

`unknown` forces a check. `any` deletes the check and every downstream check with
it. If a type is genuinely unknowable, `unknown` plus a Zod parse is the answer.

### Type over interface, except for extension

Prefer `type` for object shapes. Use `interface` where declaration merging or
class implementation is actually needed.

### Prefer `const` unions to enums

```ts
export const ORDER_STATUS = ['DRAFT', 'SEARCHING', 'ACCEPTED'] as const;
export type OrderStatus = (typeof ORDER_STATUS)[number];
```

The array is iterable at runtime (useful for validation and tests) and the type
is derived from it, so the two cannot drift.

### Make illegal states unrepresentable

```ts
// Weak — permits { status: 'SEARCHING', masterId: 'x' }, which is nonsense
type Order = { status: OrderStatus; masterId?: string };

// Better — the type encodes the rule
type Order =
  | { status: 'DRAFT' | 'SEARCHING'; masterId: null }
  | { status: 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED'; masterId: string };
```

A rule enforced by the type system does not need a test or a code review.

### `import type` for type-only imports

Enforced by lint. It keeps runtime imports explicit and avoids pulling modules
into the bundle for their types alone.

## Naming

| Thing                 | Convention                  | Example                   |
| --------------------- | --------------------------- | ------------------------- |
| Directories           | `kebab-case`                | `order-lifecycle/`        |
| React components      | `PascalCase.tsx`            | `OrderCard.tsx`           |
| Hooks                 | `useThing.ts`               | `useNearbyMasters.ts`     |
| NestJS files          | `name.role.ts`              | `orders.service.ts`       |
| Tests                 | `.test.ts(x)`, co-located   | `OrderCard.test.tsx`      |
| Types                 | `PascalCase`                | `OrderStatus`             |
| Constants             | `SCREAMING_SNAKE_CASE`      | `MAX_SEARCH_RADIUS_M`     |
| Variables / functions | `camelCase`                 | `findNearbyMasters`       |
| Booleans              | `is` / `has` / `can` prefix | `isVerified`, `canAccept` |
| DB tables / columns   | `snake_case`, tables plural | `order_status_history`    |
| JSON / API fields     | `camelCase`                 | `createdAt`               |
| Env vars              | `SCREAMING_SNAKE_CASE`      | `JWT_ACCESS_SECRET`       |

### Units belong in the name

```ts
const MAX_SEARCH_RADIUS_M = 5000; // metres — unambiguous
const LOCATION_INTERVAL_MS = 15_000; // milliseconds
const priceMinor = 1500; // 15.00 AZN in minor units
```

Ambiguous units are a real source of bugs — a radius in metres passed to a
function expecting kilometres is silently wrong, and both are `number`.

### No abbreviations

`order`, not `ord`. `master`, not `mstr`. The exceptions are universal: `id`,
`url`, `api`, `db`.

## Functions

- One job per function. A function whose name needs "and" does two things.
- **Guard clauses over nesting.** Handle the failure and return.
- Fewer than four positional parameters; beyond that, take an options object —
  positional booleans at a call site are unreadable.
- No side effects in a function that looks like a query. `getOrder` must not
  write.

## Error handling

```ts
// Bad — swallows the failure and continues with a lie
try {
  await doThing();
} catch {
  return null;
}

// Good — handle what you understand, let the rest propagate
try {
  await doThing();
} catch (error) {
  if (error instanceof KnownError) return handleIt(error);
  throw error; // unknown failures belong to the global filter
}
```

- Never swallow an error silently.
- Throw typed errors (`AppError` subclasses) with a stable code.
- Errors crossing the API boundary are mapped by the global filter — internal
  detail never reaches a client
  ([`../architecture/backend-architecture.md`](../architecture/backend-architecture.md)).
- `catch (error: unknown)` — enforced by `useUnknownInCatchVariables`.

## Async

- `await` everything, or handle the promise explicitly. `no-floating-promises` is
  an error — an unhandled rejection in a request handler or queue worker is a
  silent failure.
- Use `Promise.all` for genuinely independent work; sequential `await` in a loop
  is usually a mistake.
- Never `async` in a `forEach` — it does not wait.

## Comments

Comments explain **why**, never what.

```ts
// Bad — restates the code
// increment the counter
counter += 1;

// Good — explains a decision the code cannot
// The WHERE clause is the lock: reading then writing would let two masters
// both observe SEARCHING and both write. See backend-architecture.md.
```

- No commented-out code. Git remembers it.
- No `TODO` without an issue number: `// TODO(#123): ...`.
- A disabled lint rule **must** carry a comment explaining why
  ([CLAUDE.md §20](../../CLAUDE.md)).

## Imports

Ordered: node builtins → external → workspace (`@tezusta/*`) → relative.
No deep imports into another workspace's internals — use its public entry point.

## React / React Native

- Function components only.
- Custom hooks for shared logic; hooks start with `use`.
- Complete dependency arrays. Do not silence the exhaustive-deps rule — a missing
  dependency is a stale-closure bug waiting to happen.
- Keys are stable ids, **never array indices** on a reorderable list.
- **No hardcoded design values** — colour, spacing, and type come from the theme
  ([CLAUDE.md §17](../../CLAUDE.md)). A hex literal in a component is a design
  decision engineering was not entitled to make.

## NestJS

- Controllers: HTTP shape only, no business logic.
- Services: business logic; they own the transaction boundary.
- Repositories: Drizzle queries only.
- Constructor injection; no service locator.
- One module per bounded concern; no circular module dependencies (CI-enforced).

## Files

- Roughly 300 lines is a smell, not a limit. A long file is usually several
  concerns.
- One component or one service per file.
- `index.ts` re-exports a directory's public surface — it does not contain logic.
