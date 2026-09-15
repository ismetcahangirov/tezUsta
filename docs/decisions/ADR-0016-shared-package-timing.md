# ADR-0016 — Shared packages are created on the second consumer

- **Status:** **Accepted**
- **Date:** 2026-09-15
- **Supersedes:** the packaging clause of
  [ADR-0004](ADR-0004-location-and-maps.md) — "`packages/config` exports the
  active geocoding provider". ADR-0004's actual decision, Google Maps Platform
  behind a provider interface, is unchanged. Clarifies
  [ADR-0001](ADR-0001-project-foundation.md).

## Context

`CLAUDE.md` states the rule: **packages are created when a second consumer
exists, not before.** It then lists `packages/types`, `packages/validation`,
`packages/api-client`, `packages/config` and `packages/ui` in the repository
tree, only one of which is marked as not yet existing. On disk, `packages/`
contains `eslint-config` and `typescript-config`.

Three documents go further and describe a package that does not exist in the
present tense, as the place a thing already lives:

- `docs/architecture/technology-stack.md` — "`packages/config` exports the
  provider and no call site imports a vendor SDK directly"
- `docs/architecture/location-services.md` — "All geocoding goes through a
  provider interface in `packages/config`."
- [ADR-0004](ADR-0004-location-and-maps.md) — "`packages/config` exports the
  active geocoding provider."

The last is in an accepted ADR, so it cannot be edited away. And it conflicts
with the rule directly: when geocoding is built, `apps/api` is its only
consumer, so the rule forbids creating `packages/config` at exactly the moment
ADR-0004 requires it.

An architecture rule that the architecture documents contradict is not a rule.

## Decision

**A `packages/*` workspace is created at the moment a second workspace imports
it — not earlier, and not later.**

Until then, the code lives in the single consumer that uses it, behind the same
interface it would have had as a package:

| Concern                      | Where it lives today          | Moves to                                          |
| ---------------------------- | ----------------------------- | ------------------------------------------------- |
| Geocoding / maps provider    | `apps/api/src/infra/geo/`     | `packages/config` when a second consumer needs it |
| SMS / OTP provider           | `apps/api/src/infra/sms/`     | `packages/config`                                 |
| Object storage provider      | `apps/api/src/infra/storage/` | `packages/config`                                 |
| Runtime config + env parsing | `apps/api/src/infra/config/`  | `packages/config`                                 |
| Domain types, API contracts  | `apps/api/src/**/*.types.ts`  | `packages/types` when `apps/mobile` consumes them |
| Zod schemas                  | `apps/api/src/**/*.schema.ts` | `packages/validation` when a client reuses them   |
| Typed API client             | —                             | `packages/api-client` when `apps/admin` exists    |
| Presentational components    | `apps/mobile/src/components/` | `packages/ui` when `apps/admin` exists            |

Two rules make the move cheap rather than disruptive:

1. **The interface is designed as if it were already a package.** A provider is
   an interface plus an implementation selected by configuration, with no vendor
   SDK type crossing the boundary. Extraction is then a file move and a
   `package.json`, not a redesign. This is what ADR-0004 was protecting, and it
   is preserved in full.
2. **Documentation names the destination, not a fiction.** A document may say
   "in `apps/api/src/infra/geo/`, destined for `packages/config`". It may not
   say a package exports something when the package does not exist.

`packages/eslint-config` and `packages/typescript-config` already have multiple
consumers and are correct as packages today.

## Why

**The rule was right; only its bookkeeping was wrong.** A package created for
one consumer costs a workspace, a build edge, a version, a `package.json`, and
a boundary rule, and buys nothing until the second consumer arrives. That
reasoning is sound and is why `CLAUDE.md` states it.

**A document that describes a non-existent file teaches an agent to invent
one.** `CLAUDE.md` § Research tells an agent to inspect what the repository
already does. When the documentation says `packages/config` exports the
provider and the repository has no such directory, the two instructions point
in opposite directions, and the likely outcome is a speculative package created
to satisfy the document.

**The dependency-cruiser rule already assumed this.** `mobile-not-into-api`
tells the reader to share contracts through `packages/types`. That rule is
correct as a statement of direction and wrong as a statement of fact; naming
the interim location makes both true.

## Alternatives considered

**Create all five packages now, empty.** Rejected: five workspaces with no
content, five more nodes in the graph, and a build that is slower for no
benefit. It also makes the boundary rules vacuous — a rule about
`packages/types` proves nothing while the package is empty.

**Drop the rule and create a package whenever it feels tidy.** Rejected: this
is how a monorepo acquires thirty packages with one consumer each, at which
point the dependency graph stops being a design and becomes a history.

**Keep the rule and let the documents stay wrong.** Rejected: that is the
current state, and it is what produced the contradiction.

## Consequences

- `docs/architecture/technology-stack.md` and
  `docs/architecture/location-services.md` are corrected to name
  `apps/api/src/infra/` with `packages/config` as the destination.
- `CLAUDE.md` § Architecture marks every not-yet-existing package and app as
  planned.
- The `mobile-not-into-api` rule comment points at this ADR.
- Moving code into a package later is a mechanical change with a graph
  regeneration, not a redesign — provided rule 1 above is honoured when the
  interface is first written.
- When a package is extracted, the extraction gets its own commit, separate
  from any behaviour change.
