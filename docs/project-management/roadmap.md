# Roadmap

Epics, their order, and what depends on what. The authoritative status of any
Epic is its GitHub issue; this document is the map.

## Dependency graph

```
                    EPIC 1 — Project Foundation
                              │
                    EPIC 2 — Authentication & User Roles
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   EPIC 3 —             EPIC 4 —              EPIC 5 —
   Service Catalog      Customer Profile      Master Profile
                        & Address             & Verification
        │                     │                     │
        └─────────────────────┴──────────┬──────────┘
                                         ▼
                              EPIC 6 — Order Creation
                                         │
                                         ▼
                              EPIC 7 — Master Matching
                                         │
                                         ▼
                              EPIC 8 — Order Lifecycle
                                         │
                    ┌────────────────────┼────────────────────┐
                    ▼                    ▼                    ▼
              EPIC 9 —             EPIC 10 —            EPIC 11 —
              Realtime Tracking    Notifications        Reviews & Ratings
                    │                    │                    │
                    └────────────────────┼────────────────────┘
                                         ▼
                              EPIC 12 — Payments        ← blocked: ADR-0007
                                         │
                                         ▼
                              EPIC 13 — Admin Panel
                                         │
                              EPIC 14 — Subscription & Commission
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
   EPIC 15 —                       EPIC 16 —                        EPIC 17 —
   Security & Abuse                Performance &                    Production
   Prevention                      Scalability                      Deployment
```

**EPIC 15 and 16 are continuous, not terminal.** Security and performance are
requirements of every Epic ([`../engineering/security.md`](../engineering/security.md),
[`../engineering/performance.md`](../engineering/performance.md)). These Epics
exist to audit and harden what was already built to standard — not to add
security at the end.

## The critical path

```
1 → 2 → 5 → 6 → 7 → 8
```

Everything that makes TezUsta a marketplace rather than a form runs through
order creation, matching, and lifecycle. EPIC 5 is on the path because
**verification gates who may accept work** — dispatch is meaningless without it.

## Epics

| #   | Epic                          | Depends on | Blocked by                                                                  |
| --- | ----------------------------- | ---------- | --------------------------------------------------------------------------- |
| 1   | Project Foundation            | —          | —                                                                           |
| 2   | Authentication & User Roles   | 1          | 🔴 **SMS provider** ([ADR-0008](../decisions/ADR-0008-otp-delivery.md))     |
| 3   | Service Catalog               | 1          | — (master sets price)                                                       |
| 4   | Customer Profile & Address    | 2          | — (Google Maps decided)                                                     |
| 5   | Master Profile & Verification | 2          | Verification criteria                                                       |
| 6   | Order Creation                | 3, 4, 5    | —                                                                           |
| 7   | Master Matching               | 6          | — (Bolt-style broadcast)                                                    |
| 8   | Order Lifecycle               | 7          | Cancellation policy                                                         |
| 9   | Realtime Tracking             | 8          | —                                                                           |
| 10  | Notifications                 | 8          | —                                                                           |
| 11  | Reviews & Ratings             | 8          | —                                                                           |
| 12  | Payments                      | 8          | **Provider + fund-holding** ([ADR-0007](../decisions/ADR-0007-payments.md)) |
| 13  | Admin Panel                   | 5, 8       | Permission model                                                            |
| 14  | Subscription & Commission     | 12         | Business model detail                                                       |
| 15  | Security & Abuse Prevention   | continuous | —                                                                           |
| 16  | Performance & Scalability     | continuous | —                                                                           |
| 17  | Production Deployment         | 8          | Hosting decision                                                            |

## Decisions settled by the owner (2026-09-14)

| Decision           | Outcome                                                | Unblocked      |
| ------------------ | ------------------------------------------------------ | -------------- |
| Sign-in method     | **Phone + SMS OTP only** — no social sign-in           | EPIC 2 design  |
| Dispatch model     | **Parallel broadcast, first accept wins** (Bolt-style) | EPIC 7         |
| Who sets the price | **The master**; platform takes a commission            | EPIC 3, EPIC 5 |
| Payment methods    | **Both cash and card**                                 | EPIC 12 design |
| Maps / geocoding   | **Google Maps Platform**                               | EPIC 4         |

## What is still blocked, and on what

Engineering cannot resolve these. They are product, business, or legal decisions
(CLAUDE.md §17).

| Decision                                        | Blocks                | Why it cannot be researched                                           |
| ----------------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| 🔴 **SMS provider + sender ID**                 | **EPIC 2 — entirely** | OTP is now the only sign-in path; no provider means nobody can log in |
| 🔴 **Account recovery when the number is lost** | Launch                | The principal weakness of phone-only sign-in                          |
| **Visual design system**                        | All UI work           | The owner owns it                                                     |
| Master verification criteria                    | EPIC 5                | Policy and trust decision                                             |
| Cancellation rules and penalties                | EPIC 8                | Business policy                                                       |
| Does TezUsta hold customer funds?               | EPIC 12               | **Needs legal advice** — likely a regulated activity                  |
| Payment provider                                | EPIC 12               | Follows the banking relationship                                      |
| Commission rate + price guardrails              | EPIC 14               | Business decision                                                     |
| Hosting / cloud provider                        | EPIC 17               | Budget and operational preference                                     |
| Languages at launch                             | EPIC 1                | Product decision                                                      |

**The SMS provider is the highest-priority unblocking decision.** Choosing phone

- OTP as the sole sign-in path moved it onto the critical path: EPIC 2 blocks
  almost everything, and EPIC 2 now blocks on this.

Work blocked on one of these is labelled `needs-design-decision`, so "waiting on
you" stays visible rather than being quietly invented.

## Suggested first increment

After the foundation lands, the highest-value order is:

1. **EPIC 1** — scaffold `apps/api` and `apps/mobile` with the pinned stack;
   database and migrations; CI. Nothing user-facing, everything downstream.
2. **EPIC 2** — authentication. Unblocks the widest set of Epics.
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
- Do not create entities for a future Epic. `payments`, `wallets`, and
  `subscriptions` do not exist until EPIC 12/14.
