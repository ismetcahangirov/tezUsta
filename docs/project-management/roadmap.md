# Roadmap

Epics, their order, and what depends on what. The authoritative status of any
Epic is its GitHub issue; this document is the map.

## Dependency graph

The dependency table under [Epics](#epics) is authoritative. This drawing is that
table.

```
                        EPIC 1 — Project Foundation
                                     │
                   ┌─────────────────┴─────────────────┐
                   ▼                                   ▼
        EPIC 2 — Authentication              EPIC 3 — Service Catalog
                & User Roles                           │
                   │                                   │
         ┌─────────┴─────────┐                         │
         ▼                   ▼                         │
    EPIC 4 —            EPIC 5 —                       │
    Customer Profile    Master Profile                 │
    & Address           & Verification                 │
         │                   │                         │
         └─────────┬─────────┴─────────────────────────┘
                   ▼
        EPIC 6 — Order Creation
                   │
                   ▼
        EPIC 7 — Master Matching
                   │
                   ▼
        EPIC 8 — Order Lifecycle
                   │
   ┌────────┬──────┴──┬─────────┬─────────────┬─────────────┐
   ▼        ▼         ▼         ▼             ▼             ▼
EPIC 9   EPIC 10   EPIC 11   EPIC 12      EPIC 13       EPIC 17
Realtime Notifi-   Reviews   Payments     Admin Panel   Production
Tracking cations   &         (provider    (also needs   Deployment
                   Ratings   + fund-       EPIC 5)      (hosting
                             holding                     pending)
                             pending)
                                 │
                                 ▼
                             EPIC 14 — Subscription & Commission

   ╔═══════════════════════════════════════════════════════════════╗
   ║  EPIC 15 — Security & Abuse Prevention       ── continuous ──  ║
   ║  EPIC 16 — Performance & Scalability         ── continuous ──  ║
   ╚═══════════════════════════════════════════════════════════════╝
      These run alongside every Epic above, from EPIC 1 onwards.
```

**EPIC 15 and 16 are continuous, not terminal.** Security and performance are
requirements of every Epic ([`../engineering/security.md`](../engineering/security.md),
[`../engineering/performance.md`](../engineering/performance.md)). These Epics
exist to audit and harden what was already built to standard — not to add
security at the end.

## The critical path

```
1 → 2 → {3, 4, 5} → 6 → 7 → 8
```

EPIC 6 needs all three of EPIC 3, 4 and 5, so none of them is optional on the
path. EPIC 3 hangs off EPIC 1 rather than EPIC 2 — it is a catalogue, not a
user-scoped resource — which is why it stays buildable while EPIC 2 waits on a
provider.

Everything that makes TezUsta a marketplace rather than a form runs through
order creation, matching, and lifecycle. EPIC 5 is on the path because
**verification gates who may accept work** — dispatch is meaningless without it.

## Epics

| #   | Epic                          | Depends on | Blocked by                                                                                                            |
| --- | ----------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | Project Foundation            | —          | —                                                                                                                     |
| 2   | Authentication & User Roles   | 1          | 🔴 **SMS provider** — blocks real sign-in, not the implementation ([ADR-0008](../decisions/ADR-0008-otp-delivery.md)) |
| 3   | Service Catalog               | 1          | — (master sets price)                                                                                                 |
| 4   | Customer Profile & Address    | 2          | — (Google Maps decided)                                                                                               |
| 5   | Master Profile & Verification | 2          | Verification criteria; object storage provider for documents                                                          |
| 6   | Order Creation                | 3, 4, 5    | Object storage provider for photos                                                                                    |
| 7   | Master Matching               | 6          | — (Bolt-style broadcast)                                                                                              |
| 8   | Order Lifecycle               | 7          | Cancellation rules and penalties                                                                                      |
| 9   | Realtime Tracking             | 8          | —                                                                                                                     |
| 10  | Notifications                 | 8          | —                                                                                                                     |
| 11  | Reviews & Ratings             | 8          | —                                                                                                                     |
| 12  | Payments                      | 8          | **Provider, fund-holding, commission rate** ([ADR-0007](../decisions/ADR-0007-payments.md))                           |
| 13  | Admin Panel                   | 5, 8       | — ([ADR-0014](../decisions/ADR-0014-admin-authentication.md))                                                         |
| 14  | Subscription & Commission     | 12         | —                                                                                                                     |
| 15  | Security & Abuse Prevention   | continuous | —                                                                                                                     |
| 16  | Performance & Scalability     | continuous | —                                                                                                                     |
| 17  | Production Deployment         | 8          | Hosting / cloud provider                                                                                              |

## Decisions settled

Settled by the owner (2026-09-14):

| Decision           | Outcome                                                                                                     | Unblocked      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- | -------------- |
| Sign-in method     | **Phone + SMS OTP only** — no social sign-in                                                                | EPIC 2 design  |
| Dispatch model     | **Parallel broadcast, first accept wins** (Bolt-style)                                                      | EPIC 7         |
| Who sets the price | **The master**; platform takes a commission                                                                 | EPIC 3, EPIC 5 |
| Payment methods    | **Both cash and card**                                                                                      | EPIC 12 design |
| Maps / geocoding   | **Google Maps Platform**                                                                                    | EPIC 4         |
| Design system      | **Light + dark, Anybody, lime accent, closed palette** ([ADR-0011](../decisions/ADR-0011-design-system.md)) | Every UI Epic  |
| Component workshop | **Storybook on React Native Web + Vite** ([ADR-0012](../decisions/ADR-0012-component-workshop.md))          | EPIC 1         |

Recorded 2026-09-15:

| Decision               | Outcome                                                                                                                | Unblocked        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Price freeze point     | Frozen **at accept**, not at creation ([ADR-0013](../decisions/ADR-0013-price-freeze-point.md))                        | EPIC 6, EPIC 7   |
| Admin authentication   | Separate credential path; the `admin` role ships in EPIC 2 ([ADR-0014](../decisions/ADR-0014-admin-authentication.md)) | EPIC 3, 5, 8, 13 |
| Order lifecycle states | The complete status set and transition table ([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md))             | EPIC 6, EPIC 8   |
| Shared package timing  | A package is created on the **second** consumer ([ADR-0016](../decisions/ADR-0016-shared-package-timing.md))           | EPIC 1           |

## What is still blocked, and on what

Engineering cannot resolve these. They are product, business, or legal decisions
(CLAUDE.md §17).

| Open decision                                                                                       | Blocks                                      | Why it cannot be researched                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| 🔴 **SMS provider + sender ID**                                                                     | Completing EPIC 2 / real sign-in            | A commercial and operator-registration choice, not a technical one |
| **Object storage provider** ([ADR-0005](../decisions/ADR-0005-object-storage.md), provider pending) | Document upload in EPIC 5, photos in EPIC 6 | Vendor, cost, and data-residency choice                            |
| **Does TezUsta hold customer funds?**                                                               | EPIC 12                                     | **Needs legal advice** — likely a regulated activity               |
| **Payment provider**                                                                                | EPIC 12                                     | Follows the banking relationship                                   |
| **Commission rate + price guardrails**                                                              | EPIC 12                                     | Business decision, and needed before any payment code              |
| **Master verification criteria**                                                                    | EPIC 5                                      | Policy and trust decision                                          |
| **Cancellation rules and penalties**                                                                | EPIC 8                                      | Business policy                                                    |
| **Hosting / cloud provider**                                                                        | EPIC 17                                     | Budget and operational preference                                  |
| **Account recovery when the number is lost**                                                        | Launch                                      | The principal weakness of phone-only sign-in                       |
| **Languages at launch**                                                                             | Launch                                      | Product decision                                                   |
| **In-app chat at launch**                                                                           | Open product question                       | Product scope decision                                             |
| **Owner art:** app icon, splash, map style JSON, illustration, motion                               | Polish, not features                        | Owner-supplied art; components ship without them (ADR-0011)        |

**The SMS provider is the highest-priority unblocking decision.** Choosing phone
plus OTP as the only sign-in path put it on the critical path: without a provider
and a registered sender ID, no real user can enter the app. It does **not** stop
EPIC 2 from being built — the sender sits behind a provider interface and
`SMS_PROVIDER=stub` ships in `.env.example`, so every endpoint, guard, rotation
rule and rate limit is implementable and testable today. What it stops is EPIC 2
being finished.

Work blocked on one of these is labelled `needs-design-decision`, so "waiting on
you" stays visible rather than being quietly invented.

## Where the repository actually is

EPIC 1 is **partially delivered**. No business feature exists.

| Item                                                                                   | State                 |
| -------------------------------------------------------------------------------------- | --------------------- |
| `apps/mobile` — Expo SDK 57, Expo Router, NativeWind 4 + Tailwind 3.4.17, Jest         | **Done**              |
| Design system and theme tokens ([ADR-0011](../decisions/ADR-0011-design-system.md))    | **Done**              |
| Storybook component workshop ([ADR-0012](../decisions/ADR-0012-component-workshop.md)) | **Done**              |
| `packages/eslint-config`, `packages/typescript-config`                                 | **Done**              |
| `apps/api` (NestJS on Fastify), health endpoints, API test harness                     | Outstanding in EPIC 1 |
| Docker Compose for Postgres + PostGIS and Redis                                        | Outstanding in EPIC 1 |
| Drizzle wired up, first migration enabling PostGIS                                     | Outstanding in EPIC 1 |
| Zod-validated env parsing that fails at startup                                        | Outstanding in EPIC 1 |
| CI running the full gate                                                               | Outstanding in EPIC 1 |

Everything else named in
[`../architecture/architecture-overview.md`](../architecture/architecture-overview.md)
is planned, not present: `apps/admin`, `packages/types`, `packages/validation`,
`packages/config`, `packages/api-client` and `packages/ui` do not exist. Per
[ADR-0016](../decisions/ADR-0016-shared-package-timing.md) a package is created
when a second workspace imports it; until then that code lives in its single
consumer — `apps/api/src/infra/...` for providers and runtime config.

## Suggested first increment

The highest-value order from here:

1. **EPIC 1 — finish it.** Scaffold `apps/api` on the pinned stack; database,
   migrations and Docker Compose; CI. Nothing user-facing, everything
   downstream.
2. **EPIC 2** — authentication, on the stub sender. Unblocks the widest set of
   Epics; the SMS provider is needed only to turn real sign-in on.
3. **EPIC 3** — the catalogue. Independent, testable, and needed by order
   creation. Buildable while design decisions are still outstanding.
4. **EPIC 5** — master verification. On the critical path and slow to get right.

EPIC 3 is deliberately early: it is real, useful work that does **not** depend on
any of the blocked decisions above.

## Rules

- An Epic is a tracking issue, not a work item. Nobody is assigned to "do the
  Epic".
- An Epic's sub-issues must each be independently completable.
- Do not start an Epic whose prerequisite is incomplete, unless the abstraction
  standing in for it is deliberate and documented
  ([CLAUDE.md §20](../../CLAUDE.md)).
- Do not create entities for a future Epic. `payments`, `master_wallets` and
  `commission_rules` do not exist until EPIC 12; subscription plans and payouts
  do not exist until EPIC 14.
