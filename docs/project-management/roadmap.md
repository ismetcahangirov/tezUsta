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
EPIC 9   EPIC 10   EPIC 11   EPIC 14      EPIC 13       EPIC 17
Realtime Notifi-   Reviews   Master       Admin Panel   Production
Tracking cations   &         Subscrip-    (also needs   Deployment
                   Ratings   tions (also   EPIC 5)      (hosting
                             needs EPIC 5;               pending)
                             provider
                             pending)

EPIC 12 — Payments  retired by ADR-0046: the platform never touches order
                    money, so there is no order payment to build

EPIC 18 — In-Order Messaging & Calls  needs EPIC 8 (an assigned master) and
                                      EPIC 9 (authorized socket rooms, #167)

EPIC 19 — Master Public Profile        needs EPIC 5 and EPIC 13 (moderation);
          & Work Portfolio             off the critical path
EPIC 20 — Admin Panel: Operations      needs EPIC 13; serving it in production
          Before Launch                waits for hosting (EPIC 17)
EPIC 21 — Live Search Radar            needs EPIC 7 and EPIC 9
          & Arrival Promise

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

**EPIC 15's first full audit ran on 25 September 2026**, once EPIC 8 and 13
had landed (#269–#277). It found one critical and seven lesser findings, and
fixed each one in its own issue. The audit record lists them, the risks
accepted with reasons, and what is still owed:
[`../engineering/security-audit-2026-09.md`](../engineering/security-audit-2026-09.md).
Tuning the limits against real traffic waits for EPIC 17. A second audit waits
for subscription billing (EPIC 14), because money changes the threat model.

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

| #   | Epic                          | Depends on | Blocked by                                                                                                                                                   |
| --- | ----------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Project Foundation            | —          | —                                                                                                                                                            |
| 2   | Authentication & User Roles   | 1          | 🔴 **Email provider** — blocks real sign-in, not the implementation ([ADR-0072](../decisions/ADR-0072-email-one-time-code-sign-in.md))                       |
| 3   | Service Catalog               | 1          | — (master sets price)                                                                                                                                        |
| 4   | Customer Profile & Address    | 2          | — (Google Maps decided)                                                                                                                                      |
| 5   | Master Profile & Verification | 2          | — resolved by [ADR-0023](../decisions/ADR-0023-master-verification-policy.md) and [ADR-0024](../decisions/ADR-0024-presigned-upload-mechanism.md)            |
| 6   | Order Creation                | 3, 4, 5    | — Cloudflare R2 ([ADR-0024](../decisions/ADR-0024-presigned-upload-mechanism.md))                                                                            |
| 7   | Master Matching               | 6          | — (Bolt-style broadcast)                                                                                                                                     |
| 8   | Order Lifecycle               | 7          | — resolved by [ADR-0068](../decisions/ADR-0068-cancellation-rules.md), built in #461                                                                         |
| 9   | Realtime Tracking             | 8          | —                                                                                                                                                            |
| 10  | Notifications                 | 8          | —                                                                                                                                                            |
| 11  | Reviews & Ratings             | 8          | —                                                                                                                                                            |
| 12  | Payments — **retired**        | —          | Nothing: no order money moves through the platform ([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md))                                     |
| 13  | Admin Panel                   | 5, 8       | — ([ADR-0014](../decisions/ADR-0014-admin-authentication.md))                                                                                                |
| 14  | Master Subscriptions          | 5, 8       | **Billing provider**, launch prices, trial and grace ([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md)) — blocks going live, not building |
| 15  | Security & Abuse Prevention   | continuous | —                                                                                                                                                            |
| 16  | Performance & Scalability     | continuous | —                                                                                                                                                            |
| 17  | Production Deployment         | 8          | Hosting / cloud provider                                                                                                                                     |
| 18  | In-Order Messaging & Calls    | 8, 9       | LiveKit on Expo 57 / RN 0.86 is unproven — the Epic opens with a build spike ([ADR-0034](../decisions/ADR-0034-in-app-voice-calls.md))                       |
| 19  | Master Profile & Portfolio    | 5, 13      | Closed. ADR-0045 § 7 ships photos at launch; whether video follows is #504                                                                                   |
| 20  | Admin Operations              | 13         | Hosting / cloud provider, for serving the panel in production                                                                                                |
| 21  | Live Search Radar             | 7, 9       | —                                                                                                                                                            |

## Decisions settled

Settled by the owner (2026-09-14):

| Decision           | Outcome                                                                                                                                                                                                                                               | Unblocked      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Sign-in method     | **Email + a one-time code by email only** — no password, no social sign-in, no phone number ([ADR-0072](../decisions/ADR-0072-email-one-time-code-sign-in.md), 2026-10-30, superseding ADR-0008)                                                      | EPIC 2 design  |
| Dispatch model     | **Parallel broadcast, first accept wins** (Bolt-style)                                                                                                                                                                                                | EPIC 7         |
| Who sets the price | **The master** (the commission half superseded by ADR-0046)                                                                                                                                                                                           | EPIC 3, EPIC 5 |
| Payment methods    | **Both cash and card** — paid to the master directly since ADR-0046                                                                                                                                                                                   | EPIC 12 design |
| Maps / geocoding   | **Google Maps Platform**                                                                                                                                                                                                                              | EPIC 4         |
| Design system      | **Light + dark, Inter, `#1877F2` blue accent, closed palette** ([ADR-0011](../decisions/ADR-0011-design-system.md), [ADR-0048](../decisions/ADR-0048-blue-brand-and-wordmark.md), [ADR-0070](../decisions/ADR-0070-inter-typeface-and-type-scale.md)) | Every UI Epic  |
| Component workshop | **Storybook on React Native Web + Vite** ([ADR-0012](../decisions/ADR-0012-component-workshop.md))                                                                                                                                                    | EPIC 1         |

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

Settled by the owner (2026-10-10):

| Decision         | Outcome                                                                                                                                                              | Unblocked           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Revenue          | **Master subscriptions only** — no commission, customers use the app free ([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md))                      | EPIC 14 (#321–#326) |
| Order money      | **The platform never touches it** — the customer pays the master directly; TezUsta holds no customer funds, which closes ADR-0007's legal question                   | Retires EPIC 12     |
| Where it is sold | **Outside the app**, on the web through a local provider; the app shows status only, with no link, button or price (Apple 3.1.1, Google Play Payments; ADR-0046 § 7) | #323, #325          |
| Price guardrails | **Not wanted for now**                                                                                                                                               | —                   |

## What is still blocked, and on what

Engineering cannot resolve these. They are product, business, or legal decisions
(CLAUDE.md §17).

| Open decision                                                                          | Blocks                                                 | Why it cannot be researched                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔴 **Email provider + sending domain (SPF, DKIM, DMARC)**                              | Completing EPIC 2 / real sign-in                       | A commercial and domain-ownership choice, not a technical one                                                                                                                   |
| **Data residency for user-supplied images**                                            | Nothing today — a constraint on where R2 may keep them | A legal question about Azerbaijani regulation. ADR-0005 wanted it answered before a provider was finalised; ADR-0024 chose R2 without it, and it can still invalidate that half |
| **Subscription billing provider**                                                      | EPIC 14 going live                                     | Follows the banking relationship. Payriff, Epoint and AzeriCard all document saved-card charges ([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md) § 6)       |
| **Launch subscription prices, trial and grace**                                        | EPIC 14 launching the plan                             | Business decision. Each is data, so none blocks building EPIC 14                                                                                                                |
| **The appeal path out of `rejected`**                                                  | Nothing today — an operational gap                     | Who hears an appeal, and on what basis ([ADR-0023](../decisions/ADR-0023-master-verification-policy.md))                                                                        |
| **What automatically suspends a master** (rating floor, cancellation rate, complaints) | Nothing today — suspension is manual                   | Needs data that does not exist before launch                                                                                                                                    |
| **Hosting / cloud provider**                                                           | EPIC 17                                                | Budget and operational preference                                                                                                                                               |
| **Account recovery when access to the email address is lost**                          | Launch                                                 | The principal weakness of email-only sign-in                                                                                                                                    |
| **Languages at launch**                                                                | Launch                                                 | Product decision                                                                                                                                                                |
| **Owner art:** app icon, splash, map style JSON, illustration, motion                  | Polish, not features                                   | Owner-supplied art; components ship without them (ADR-0011)                                                                                                                     |

**The email provider is the highest-priority unblocking decision.** Email plus
a one-time code as the only sign-in path (ADR-0072) puts it on the critical
path: without a provider and a set-up sending domain, no real user can enter
the app. It does **not** stop EPIC 2 from being built — the sender sits behind
a provider interface and `EMAIL_PROVIDER=stub` ships in `.env.example`, so
every endpoint, guard, rotation rule and rate limit is implementable and
testable today. What it stops is EPIC 2 being finished.

Work blocked on one of these is labelled `needs-design-decision`, so "waiting on
you" stays visible rather than being quietly invented.

## Where the repository actually is

Checked against GitHub on 1 November 2026. **The marketplace works end to end
on `main`**: a customer signs in by email and orders, a nearby master is offered
the job, accepts, travels with live tracking and completes it; both sides
review each other and talk in the order's conversation, and an admin can oversee
all of it. **Nothing open can be finished by code alone.** Every open item
waits on an owner decision, a real device, or a deferred feature.

| Epic                                       | State                     | What still keeps it open                                                                                                             |
| ------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **1** Project Foundation                   | **Done**                  | —                                                                                                                                    |
| **2** Authentication & User Roles          | **Built, not finished**   | 🔴 The email provider and sending domain. Every sub-issue is closed; no real user can sign in until real email is sent               |
| **3** Service Catalog                      | **Done**                  | —                                                                                                                                    |
| **4** Customer Profile & Address           | **Done**                  | —                                                                                                                                    |
| **5** Master Profile & Verification        | **API done, no app path** | #490: the app cannot create a master profile, upload the ADR-0023 documents or submit them; waiting on where the path starts (owner) |
| **6** Order Creation                       | **Built**                 | #319: an iPhone HEIC photo, which needs an iPhone to confirm                                                                         |
| **7** Master Matching                      | **Done**                  | —                                                                                                                                    |
| **8** Order Lifecycle                      | **Built**                 | #412 / #464: the inspection price and the hand-back window, built (ADR-0060, ADR-0068) and waiting for the device check              |
| **9** Realtime Tracking                    | **Built**                 | #173: battery drain measured on a real mid-range Android                                                                             |
| **10** Notifications                       | **Built**                 | The owner's push infrastructure, and the "master nearby" kind, which has no issue                                                    |
| **11** Reviews & Ratings                   | **Done**                  | —                                                                                                                                    |
| **12** Payments                            | **Retired**               | ADR-0046                                                                                                                             |
| **13** Admin Panel                         | **Done**                  | —                                                                                                                                    |
| **14** Master Subscriptions                | **Built, not live**       | The billing provider, launch prices, trial and grace. Billing runs behind a provider port with a stub (#323)                         |
| **15** Security & Abuse Prevention         | Continuous                | Two audits done (`security-audit-2026-09.md`, `security-audit-2026-10.md`); the next is due when a real billing provider is wired in |
| **16** Performance & Scalability           | Continuous                | #293: cold start on a real mid-range Android                                                                                         |
| **17** Production Deployment               | **Blocked**               | The hosting / cloud provider decision (#467)                                                                                         |
| **18** In-Order Messaging & Calls          | **Messaging done**        | Voice calls: #183, the LiveKit spike on two real phones, gates #187–#189                                                             |
| **19** Master Profile & Portfolio          | **Done, photos only**     | Video is the owner's decision (#504); the media domain (#505) and content rules (#506) wait for launch                               |
| **20** Admin Operations Before Launch      | **Built**                 | Serving the panel in production, which waits for hosting                                                                             |
| **21** Live Search Radar & Arrival Promise | **Done**                  | —                                                                                                                                    |

**EPIC 2 is still the one that needs care.** Email plus a one-time code is the
only way in (ADR-0072), `EMAIL_PROVIDER=stub` refuses to run under
`NODE_ENV=production`, and no real user can enter the app. Built and finished
are not the same thing here, and calling it done would hide the single
highest-priority launch blocker.

### Packages

`apps/api`, `apps/mobile`, `apps/admin` (the admin panel, EPIC 13) and
`apps/web` (the subscription page, EPIC 14) exist. In `packages/`, `types`,
`eslint-config` and `typescript-config` exist; `packages/types` reached its
second consumer in EPIC 3.

`packages/validation`, `packages/config`, `packages/api-client` and
`packages/ui` still do not. Per
[ADR-0016](../decisions/ADR-0016-shared-package-timing.md) a package is created
when a second workspace imports it; until then that code lives in its single
consumer — `apps/api/src/infra/...` for providers and runtime config,
`apps/api/src/**/*.schema.ts` for Zod schemas, and each app's own `theme` and
`components` for the design system.

### One thing that landed outside the Epic that owned it

[ADR-0014](../decisions/ADR-0014-admin-authentication.md) assigned admin
authorization — the `admin_users` account store, the admin token family and the
guard that enforces them — to **EPIC 2**, precisely to avoid a dependency cycle:
EPIC 3, 5 and 8 each ship admin endpoints, and EPIC 13 depends on 5 and 8.

EPIC 2 shipped without it, and EPIC 5 (#39) is where that cycle bit. The layer
was built there instead: `admin_users`, `admin_sessions`, the append-only
`admin_audit_log`, a separate token family with its own key and audience, and a
guard that authenticates every route under `/admin` by path rather than by
decorator. EPIC 13 (#237–#251, ADR-0043) then built the rest on top of it.

## The next increment

Nothing is waiting on engineering alone. In order of what it unblocks:

1. **The email provider and sending domain** (owner). Turns EPIC 2 from built
   into finished; without it nobody can sign in.
2. **Where master onboarding starts in the app** (owner, #490). Without it no
   real master can join, so there is no supply at launch; the build itself is
   engineering work once the entry point is chosen.
3. **Hosting** (owner, #467). Unblocks EPIC 17 and the production half of
   EPIC 20.
4. **The billing provider, launch prices, trial and grace** (owner). Takes
   EPIC 14 live.
5. **Device sessions.** One Android: #464 (the inspection price and hand-back
   window), #173 (battery), #293 (cold start). Two phones: #183, which unblocks
   voice calls (#187–#189). An iPhone: #319.
6. **The portfolio's launch needs** (owner): the media domain (#505), and the
   content rules and homeowner consent (#506).
7. **Video** (owner, a new ADR, #504). Unblocks #306 and #316.

## Rules

- An Epic is a tracking issue, not a work item. Nobody is assigned to "do the
  Epic".
- An Epic's sub-issues must each be independently completable.
- Do not start an Epic whose prerequisite is incomplete, unless the abstraction
  standing in for it is deliberate and documented
  ([CLAUDE.md §20](../../CLAUDE.md)).
- Do not create entities for a future Epic. Subscription settings and prices,
  master subscriptions and subscription payments do not exist until EPIC 14.
  `payments`, `master_wallets`, `commission_rules` and `payouts` are not to be
  created at all ([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md)).
