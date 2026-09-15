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

An ADR may also carry `Supersedes:` or `Amends:` under its status, naming what
it replaces or narrows.

## Index

| ADR                                           | Decision                                       | Status                                         |
| --------------------------------------------- | ---------------------------------------------- | ---------------------------------------------- |
| [0001](ADR-0001-project-foundation.md)        | Monorepo, pnpm workspaces, Turborepo           | Accepted                                       |
| [0002](ADR-0002-toolchain-version-pinning.md) | TypeScript 6, Expo SDK 57, Tailwind 3 pins     | Accepted                                       |
| [0003](ADR-0003-database-and-geo.md)          | PostgreSQL + PostGIS + Drizzle ORM             | Accepted                                       |
| [0004](ADR-0004-location-and-maps.md)         | `react-native-maps` + Google Maps Platform     | Accepted — packaging clause superseded by 0016 |
| [0005](ADR-0005-object-storage.md)            | Presigned S3-compatible uploads; provider      | Accepted (provider pending)                    |
| [0006](ADR-0006-project-graph-tooling.md)     | dependency-cruiser for graph + boundaries      | Accepted                                       |
| [0007](ADR-0007-payments.md)                  | Cash **and** card; provider + fund-holding     | Accepted (provider and fund-holding pending)   |
| [0008](ADR-0008-otp-delivery.md)              | Sign-in by phone + OTP; SMS provider           | Accepted (SMS provider pending)                |
| [0009](ADR-0009-dispatch-model.md)            | Parallel broadcast, first accept wins          | Accepted (parameters pending tuning)           |
| [0010](ADR-0010-pricing-and-commission.md)    | Master sets price; platform commission         | Accepted (rate and guardrails pending)         |
| [0011](ADR-0011-design-system.md)             | Design system: palette, type, token contract   | Accepted (owner art pending)                   |
| [0012](ADR-0012-component-workshop.md)        | Storybook on React Native Web + Vite           | Accepted                                       |
| [0013](ADR-0013-price-freeze-point.md)        | Price is frozen at accept, not at creation     | Accepted                                       |
| [0014](ADR-0014-admin-authentication.md)      | Admin uses a separate credential path          | Accepted (second factor pending)               |
| [0015](ADR-0015-order-lifecycle-states.md)    | Complete order status set and transitions      | Accepted                                       |
| [0016](ADR-0016-shared-package-timing.md)     | Shared packages created on the second consumer | Accepted                                       |

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
