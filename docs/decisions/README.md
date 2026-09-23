# Architecture Decision Records

An ADR records **why** a decision was made, what else was considered, and what
was traded away. Code shows what we did; an ADR shows why the alternative was
rejected — which is the part that is expensive to reconstruct later.

## Rules

- **ADRs are immutable once accepted.** To change a decision, write a new ADR
  that supersedes the old one and update both `Status` lines. Never edit an
  accepted ADR's decision.
- Write an ADR when a choice is **hard to reverse** or **would otherwise be
  re-litigated**: a framework, a datastore, a protocol, a versioning constraint,
  a security model, a boundary.
- Do not write one for a choice that a reader can see from the code in a minute.
- A **Pending** ADR is legitimate and useful — it records that a decision is
  open and names what blocks it, so nobody quietly invents an answer.

### Status vocabulary

Exactly five forms. The index below and the `Status` line inside each ADR use
the same words; if they differ, the ADR file is right and the index is stale.

| Status                      | Meaning                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `Proposed`                  | Written, not yet decided. Nothing may be built on it.                                            |
| `Accepted`                  | Decided in full. Build on it; do not re-open it.                                                 |
| `Accepted (<what> pending)` | The decision is made and buildable. A named sub-question is still open and is listed in the ADR. |
| `Pending`                   | The question is recorded, the answer is not. Names what blocks it.                               |
| `Superseded by ADR-MMMM`    | Replaced. Read the successor.                                                                    |

"Accepted with something pending" is the common case here and is **not** a
half-decision: the accepted part is settled and must not be re-litigated. Only
the named sub-question is open.

Under the status an ADR may also carry `Supersedes:`, `Superseded in part by:`,
`Amends:` or `Amended by:`, naming what it replaces or narrows and in which
direction. A clause superseded in part does **not** reopen the rest of the
record: ADR-0004's geocoding decision stands even though ADR-0016 moved where
its provider interface lives.

## Index

| ADR                                                            | Decision                                                       | Status                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| [0001](ADR-0001-project-foundation.md)                         | Monorepo, pnpm workspaces, Turborepo                           | Accepted                                                   |
| [0002](ADR-0002-toolchain-version-pinning.md)                  | TypeScript 6, Expo SDK 57, Tailwind 3 pins                     | Accepted                                                   |
| [0003](ADR-0003-database-and-geo.md)                           | PostgreSQL + PostGIS + Drizzle ORM                             | Accepted                                                   |
| [0004](ADR-0004-location-and-maps.md)                          | `react-native-maps` + Google Maps Platform                     | Accepted (map library and geocoding provider both decided) |
| [0005](ADR-0005-object-storage.md)                             | Presigned S3-compatible uploads; provider                      | Accepted (provider pending)                                |
| [0006](ADR-0006-project-graph-tooling.md)                      | dependency-cruiser for graph + boundaries                      | Accepted                                                   |
| [0007](ADR-0007-payments.md)                                   | Cash **and** card; provider + fund-holding                     | Accepted (provider and fund-holding pending)               |
| [0008](ADR-0008-otp-delivery.md)                               | Sign-in by phone + OTP; SMS provider                           | Accepted (SMS provider pending)                            |
| [0009](ADR-0009-dispatch-model.md)                             | Parallel broadcast, first accept wins                          | Accepted (parameters pending tuning)                       |
| [0010](ADR-0010-pricing-and-commission.md)                     | Master sets price; platform commission                         | Accepted (commission rate and guardrails pending)          |
| [0011](ADR-0011-design-system.md)                              | Design system: palette, type, token contract                   | Accepted (owner art pending)                               |
| [0012](ADR-0012-component-workshop.md)                         | Storybook on React Native Web + Vite                           | Accepted                                                   |
| [0013](ADR-0013-price-freeze-point.md)                         | Price is frozen at accept, not at creation                     | Accepted                                                   |
| [0014](ADR-0014-admin-authentication.md)                       | Admin uses a separate credential path                          | Accepted (second-factor provider pending)                  |
| [0015](ADR-0015-order-lifecycle-states.md)                     | Complete order status set and transitions                      | Accepted                                                   |
| [0016](ADR-0016-shared-package-timing.md)                      | Shared packages created on the second consumer                 | Accepted                                                   |
| [0017](ADR-0017-state-management.md)                           | Redux Toolkit for client state, RTK Query for server state     | Accepted                                                   |
| [0018](ADR-0018-spatial-index-on-the-geography-cast.md)        | Spatial GiST index is built on the `geography` cast            | Accepted                                                   |
| [0019](ADR-0019-localized-catalogue-names.md)                  | Catalogue display names are a per-row locale map               | Accepted                                                   |
| [0020](ADR-0020-public-cached-service-catalogue.md)            | Service catalogue reads are public and Redis-cached            | Accepted                                                   |
| [0021](ADR-0021-type-only-packages-ship-source.md)             | A type-only shared package ships source, no build step         | Accepted                                                   |
| [0022](ADR-0022-geocode-cache-stores-coordinates-only.md)      | The geocode cache stores coordinates only, 30 days max         | Accepted                                                   |
| [0023](ADR-0023-master-verification-policy.md)                 | Master verification: evidence, scope, and review               | Accepted (appeal path and re-verification cadence pending) |
| [0024](ADR-0024-presigned-upload-mechanism.md)                 | Cloudflare R2; the size cap is enforced at confirm             | Accepted (data-residency check outstanding)                |
| [0025](ADR-0025-deferred-work-on-bullmq.md)                    | Time-driven work runs on BullMQ delayed jobs, in-process       | Accepted (worker topology revisited)                       |
| [0026](ADR-0026-position-freshness-and-the-reporting-floor.md) | Position freshness is its own bound; the budget has a floor    | Accepted (floor's battery cost measured in EPIC 9)         |
| [0027](ADR-0027-refresh-token-incident-retention.md)           | A reuse incident is kept whole for a year, then deleted        | Accepted (a legal finding may supersede it)                |
| [0028](ADR-0028-customer-profile-at-first-run.md)              | A customer profile comes from a first-run question             | Accepted (the wider first-run experience pending)          |
| [0029](ADR-0029-customer-order-screen.md)                      | The customer's order screen is a status card, not a stepper    | Accepted (the order list and its actions still open)       |
| [0030](ADR-0030-customer-root-navigation-and-order-list.md)    | The customer's root is a tab bar, and one tab is the orders    | Accepted (the master's root still a stack, deliberately)   |
| [0031](ADR-0031-where-settings-is-reached-from.md)             | Settings is a tab for the customer, a control for the master   | Accepted (the master's wider root still open)              |
| [0032](ADR-0032-realtime-transport.md)                         | socket.io on the API's own port, fanned out over Redis streams | Accepted (sticky sessions deferred to the hosting choice)  |
| [0035](ADR-0035-customer-tracking-map.md)                      | The customer watches the master on a map card                  | Accepted (owner art, copy and frame rate still pending)    |
| [0036](ADR-0036-master-work-surface.md)                        | The master's work lives on home; the job is one pushed screen  | Accepted (job history and a tab bar still open)            |

## Template

```markdown
# ADR-NNNN — <short title>

- **Status:** Proposed | Accepted | Pending | Superseded by ADR-MMMM
- **Date:** YYYY-MM-DD

## Context

What forced a decision. The constraints that were real at the time.

## Decision

What we chose. Specific and unambiguous.

## Why

The reasoning. Include the evidence — version metadata, benchmarks, quoted
documentation — not just the conclusion.

## Alternatives considered

| Option | Why not |

## Trade-offs accepted

What this costs us. An ADR with no trade-offs section is usually incomplete.

## Consequences

What follows for the codebase.

## Revisit when

The condition under which this should be reopened.
```
