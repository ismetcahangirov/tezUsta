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

EPIC 18 — In-Order Messaging & Calls  needs EPIC 8 (an assigned master) and
                                      EPIC 9 (authorized socket rooms, #167)

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

| #   | Epic                          | Depends on | Blocked by                                                                                                                                        |
| --- | ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Project Foundation            | —          | —                                                                                                                                                 |
| 2   | Authentication & User Roles   | 1          | 🔴 **SMS provider** — blocks real sign-in, not the implementation ([ADR-0008](../decisions/ADR-0008-otp-delivery.md))                             |
| 3   | Service Catalog               | 1          | — (master sets price)                                                                                                                             |
| 4   | Customer Profile & Address    | 2          | — (Google Maps decided)                                                                                                                           |
| 5   | Master Profile & Verification | 2          | — resolved by [ADR-0023](../decisions/ADR-0023-master-verification-policy.md) and [ADR-0024](../decisions/ADR-0024-presigned-upload-mechanism.md) |
| 6   | Order Creation                | 3, 4, 5    | — Cloudflare R2 ([ADR-0024](../decisions/ADR-0024-presigned-upload-mechanism.md))                                                                 |
| 7   | Master Matching               | 6          | — (Bolt-style broadcast)                                                                                                                          |
| 8   | Order Lifecycle               | 7          | Cancellation rules and penalties                                                                                                                  |
| 9   | Realtime Tracking             | 8          | —                                                                                                                                                 |
| 10  | Notifications                 | 8          | —                                                                                                                                                 |
| 11  | Reviews & Ratings             | 8          | —                                                                                                                                                 |
| 12  | Payments                      | 8          | **Provider, fund-holding, commission rate** ([ADR-0007](../decisions/ADR-0007-payments.md))                                                       |
| 13  | Admin Panel                   | 5, 8       | — ([ADR-0014](../decisions/ADR-0014-admin-authentication.md))                                                                                     |
| 14  | Subscription & Commission     | 12         | —                                                                                                                                                 |
| 15  | Security & Abuse Prevention   | continuous | —                                                                                                                                                 |
| 16  | Performance & Scalability     | continuous | —                                                                                                                                                 |
| 17  | Production Deployment         | 8          | Hosting / cloud provider                                                                                                                          |
| 18  | In-Order Messaging & Calls    | 8, 9       | LiveKit on Expo 57 / RN 0.86 is unproven — the Epic opens with a build spike ([ADR-0034](../decisions/ADR-0034-in-app-voice-calls.md))            |

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

Recorded 2026-09-18:

| Decision                   | Outcome                                                                                                                                                                                                                | Unblocked                   |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Master verification policy | ID card front and back plus a **selfie holding it**; one blanket approval rather than per-category; manual admin review ([ADR-0023](../decisions/ADR-0023-master-verification-policy.md))                              | EPIC 5 (#38, #39)           |
| Object storage provider    | **Cloudflare R2** — and the upload size cap moves from the presign policy to the confirm step, because R2 does not implement the S3 POST form policy ([ADR-0024](../decisions/ADR-0024-presigned-upload-mechanism.md)) | EPIC 5 (#38), EPIC 6 photos |

Recorded 2026-09-19:

| Decision                | Outcome                                                                                                                                                                                                                                                                                 | Unblocked                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Deferred-work mechanism | **BullMQ delayed jobs on Redis**, one `dispatch` queue, a dedicated Redis connection, and the worker **in the API process** behind `QUEUE_WORKER_MODE` until a second deployment unit exists ([ADR-0025](../decisions/ADR-0025-deferred-work-on-bullmq.md))                             | EPIC 7 (#103), EPIC 8/10/12 |
| Position freshness      | Dispatch bounds a master's newest position with its own `DISPATCH_MAX_POSITION_AGE_SECONDS`, **not** the presence TTL, and the location budget guarantees a reporting floor the bound is derived from ([ADR-0026](../decisions/ADR-0026-position-freshness-and-the-reporting-floor.md)) | EPIC 7 (#100), EPIC 9       |

Recorded 2026-09-22:

| Decision           | Outcome                                                                                                                                                                                                                       | Unblocked |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| In-order messaging | A conversation is a property of **one order**, opened at accept and read-only at a terminal status; it rides the existing socket and HTTP stays the source of truth ([ADR-0033](../decisions/ADR-0033-in-order-messaging.md)) | EPIC 18   |
| Calling            | **In-app voice over LiveKit** — no masked PSTN (it would need a telephony vendor, the dependency that already blocks EPIC 2) and no video ([ADR-0034](../decisions/ADR-0034-in-app-voice-calls.md))                           | EPIC 18   |

## What is still blocked, and on what

Engineering cannot resolve these. They are product, business, or legal decisions
(CLAUDE.md §17).

| Open decision                                                                          | Blocks                                                 | Why it cannot be researched                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **SMS provider + sender ID**                                                        | Completing EPIC 2 / real sign-in                       | A commercial and operator-registration choice, not a technical one                                                                                                              |
| **Data residency for user-supplied images**                                            | Nothing today — a constraint on where R2 may keep them | A legal question about Azerbaijani regulation. ADR-0005 wanted it answered before a provider was finalised; ADR-0024 chose R2 without it, and it can still invalidate that half |
| **Does TezUsta hold customer funds?**                                                  | EPIC 12                                                | **Needs legal advice** — likely a regulated activity                                                                                                                            |
| **Payment provider**                                                                   | EPIC 12                                                | Follows the banking relationship                                                                                                                                                |
| **Commission rate + price guardrails**                                                 | EPIC 12                                                | Business decision, and needed before any payment code                                                                                                                           |
| **The appeal path out of `rejected`**                                                  | Nothing today — an operational gap                     | Who hears an appeal, and on what basis ([ADR-0023](../decisions/ADR-0023-master-verification-policy.md))                                                                        |
| **What automatically suspends a master** (rating floor, cancellation rate, complaints) | Nothing today — suspension is manual                   | Needs data that does not exist before launch                                                                                                                                    |
| **Cancellation rules and penalties**                                                   | EPIC 8                                                 | Business policy                                                                                                                                                                 |
| **Hosting / cloud provider**                                                           | EPIC 17                                                | Budget and operational preference                                                                                                                                               |
| **Account recovery when the number is lost**                                           | Launch                                                 | The principal weakness of phone-only sign-in                                                                                                                                    |
| **Languages at launch**                                                                | Launch                                                 | Product decision                                                                                                                                                                |
| **Owner art:** app icon, splash, map style JSON, illustration, motion                  | Polish, not features                                   | Owner-supplied art; components ship without them (ADR-0011)                                                                                                                     |

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

**EPIC 1 through EPIC 5 are delivered.** Every sub-issue of each is closed and
merged to `main`. The critical path is therefore at **EPIC 6 — order creation**.

| Epic                                | State                   | What is actually on `main`                                                                                                                                                                                                                                                           |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** Project Foundation            | **Done**                | `apps/api` (NestJS on Fastify) with health endpoints, `apps/mobile` (Expo SDK 57), Docker Compose for Postgres + PostGIS and Redis, Drizzle with migrations, Zod-validated env parsing that fails at startup, CI running the full gate, the design system and the Storybook workshop |
| **2** Authentication & User Roles   | **Built, not finished** | Token issuance, refresh rotation with reuse detection, authentication / role / ownership guards, Redis-backed rate limiting, phone + OTP endpoints, mobile secure storage and route guards. **Nobody can actually sign in** — see below                                              |
| **3** Service Catalog               | **Done**                | `service_categories` and `services` with the launch seed, public cached read endpoints, and the catalogue rendered in the app                                                                                                                                                        |
| **4** Customer Profile & Address    | **Done**                | `customers`, `addresses` with Azerbaijani structured detail and a PostGIS point, geocoding behind a provider interface with a licence-bounded Postgres cache                                                                                                                         |
| **5** Master Profile & Verification | **Done**                | `masters` and `master_services`, verification documents through presigned URLs, append-only verification history, the admin review surface, and the availability toggle backed by Redis presence                                                                                     |
| **6** Order Creation                | **Next**                | Nothing yet                                                                                                                                                                                                                                                                          |

**EPIC 2 is the one that needs care.** Its implementation is complete and every
sub-issue is closed, but the SMS provider is still open, `SMS_PROVIDER=stub`
refuses to run under `NODE_ENV=production`, and no real user can enter the app.
Built and finished are not the same thing here, and calling it done would hide
the single highest-priority launch blocker.

### Packages

`packages/types` exists — it reached its second consumer in EPIC 3, when
`apps/mobile` began importing the catalogue's response shapes, and it has since
grown the customer, address, master, master-document and availability contracts.
`packages/eslint-config` and `packages/typescript-config` exist.

`apps/admin`, `packages/validation`, `packages/config`, `packages/api-client`
and `packages/ui` still do not. Per
[ADR-0016](../decisions/ADR-0016-shared-package-timing.md) a package is created
when a second workspace imports it; until then that code lives in its single
consumer — `apps/api/src/infra/...` for providers and runtime config,
`apps/api/src/**/*.schema.ts` for Zod schemas, and `apps/mobile/src/theme` plus
`apps/mobile/src/components` for the design system.

### One thing that landed outside the Epic that owned it

[ADR-0014](../decisions/ADR-0014-admin-authentication.md) assigned admin
authorization — the `admin_users` account store, the admin token family and the
guard that enforces them — to **EPIC 2**, precisely to avoid a dependency cycle:
EPIC 3, 5 and 8 each ship admin endpoints, and EPIC 13 depends on 5 and 8.

EPIC 2 shipped without it, and EPIC 5 (#39) is where that cycle bit. The layer
was built there instead: `admin_users`, `admin_sessions`, the append-only
`admin_audit_log`, a separate token family with its own key and audience, and a
guard that authenticates every route under `/admin` by path rather than by
decorator.

**EPIC 13 has since landed** (#237–#251, ADR-0043): credentials (scrypt +
TOTP, invitation links, the bootstrap command), cookie sessions, the four-role
permission model, account management, the audit log, catalogue editing, order
oversight and the dispute queue, the operational dashboard, and `apps/admin`
with a screen for each. What it left behind on purpose: `REFUNDED` waits for
EPIC 12, and acting on reports about a party waits for a way to report one.

**EPIC 13's remaining scope was smaller than its issue implied.** The
authorization layer is done; what is left is credential issuance (email,
password, mandatory TOTP), the granular permission model, and `apps/admin`
itself.

## The next increment

1. **EPIC 6 — order creation.** All three prerequisites (3, 4 and 5) are merged,
   and ADR-0024 resolved the object-storage question that would otherwise have
   blocked problem photos. The state machine goes in first, in one table, before
   anything writes a status.
2. **EPIC 7 — matching.** The `master_services (service_id, master_id)` index it
   needs is already in place and already proved against four thousand masters
   with `EXPLAIN`. The accept guard is the piece to get right.
3. **EPIC 8 — order lifecycle**, at which point the marketplace works end to end
   and six further Epics unblock at once.

**In parallel, and not something engineering can unblock:** the SMS provider
decision, which is what turns EPIC 2 from built into finished.

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
