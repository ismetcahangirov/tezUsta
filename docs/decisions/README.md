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
- A **PENDING** ADR is legitimate and useful — it records that a decision is
  open and names what blocks it, so nobody quietly invents an answer.

## Index

| ADR                                           | Decision                                   | Status                          |
| --------------------------------------------- | ------------------------------------------ | ------------------------------- |
| [0001](ADR-0001-project-foundation.md)        | Monorepo, pnpm workspaces, Turborepo       | Accepted                        |
| [0002](ADR-0002-toolchain-version-pinning.md) | TypeScript 6, Expo SDK 57, Tailwind 3 pins | Accepted                        |
| [0003](ADR-0003-database-and-geo.md)          | PostgreSQL + PostGIS + Drizzle ORM         | Accepted                        |
| [0004](ADR-0004-location-and-maps.md)         | `react-native-maps`; geocoding provider    | Partial — provider **pending**  |
| [0005](ADR-0005-object-storage.md)            | Presigned S3-compatible uploads; provider  | Partial — provider **pending**  |
| [0006](ADR-0006-project-graph-tooling.md)     | dependency-cruiser for graph + boundaries  | Accepted                        |
| [0007](ADR-0007-payments.md)                  | Payment provider and money flow            | **Pending** — business decision |
| [0008](ADR-0008-otp-delivery.md)              | Phone verification and OTP delivery        | **Pending** — provider decision |

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
