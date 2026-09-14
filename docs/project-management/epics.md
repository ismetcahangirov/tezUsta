# Epics

Source definitions for the GitHub Epics. Each is created as a tracking issue
labelled `epic` with native sub-issues. Order and dependencies:
[`roadmap.md`](roadmap.md).

> An Epic is a **tracking issue**, not a work item. Nobody is assigned to "do the
> Epic" — its sub-issues carry the work.

---

## EPIC 1 — Project Foundation

**Problem.** The repository has engineering documentation and tooling but no
running application.

**Goal.** `apps/api` and `apps/mobile` exist on the pinned stack, connect to a
database, run in CI, and have their first passing tests.

**Scope.** Scaffold the Expo app (SDK 57, Expo Router, NativeWind 4 + Tailwind
3.4.17) and the NestJS API (Fastify adapter). Docker Compose for Postgres+PostGIS
and Redis. Drizzle wired up with the first migration enabling PostGIS. Config
module with Zod-validated env parsing that fails at startup. Health endpoints.
Test harnesses for both apps. CI running the full gate.

**Out of scope.** Any business feature, any UI beyond a smoke screen, auth.

**Technical considerations.** Use `npx expo install` for Expo-managed packages,
never `pnpm add`. The version pins in [ADR-0002](../decisions/ADR-0002-toolchain-version-pinning.md)
are binding. `nodeLinker: hoisted` is required for Metro.

**Acceptance criteria.** `pnpm verify` passes. The API boots, `/health/ready`
reports database and Redis. The mobile app builds and runs against the local
API. CI is green on a pull request. `pnpm graph` shows both apps.

---

## EPIC 2 — Authentication & User Roles

**Problem.** Nothing can be user-scoped without identity.

**Goal.** Users authenticate, hold customer and/or master roles, and every
endpoint is authorized server-side.

**Scope.** Token issuance, refresh rotation with reuse detection, device
sessions, logout and logout-everywhere, `expo-secure-store` on the client, guards
for authentication/role/ownership, rate limiting, and the OTP sender behind a
provider interface.

**Out of scope.** Admin authentication (EPIC 13).

**Technical considerations.** Design is settled in
[`../architecture/authentication.md`](../architecture/authentication.md). A user
may hold both roles — role is a set, not a column. **Role claims are re-checked
against the database on every authorization decision.**

**Sign-in method decided:** **phone number + SMS OTP only**, no social sign-in
([ADR-0008](../decisions/ADR-0008-otp-delivery.md)). The phone number is
simultaneously the identity and the contact channel.

🔴 **Blocked by the SMS provider.** With OTP as the only sign-in path, nobody can
enter the app without one. This is the highest-priority unblocking decision in
the project. A sender ID must also be registered with Azerbaijani operators.

**Also needed before launch:** an account-recovery path for a user who loses
their phone number. This is the principal weakness of phone-only sign-in.

**Acceptance criteria.** Sign-in issues a valid pair. Refresh rotates. **Reuse
revokes the family.** A suspended user cannot act with a pre-suspension token.
Rate limits trigger. Unauthorized access to another user's resource returns 404.

---

## EPIC 3 — Service Catalog

**Problem.** Orders need a catalogue of services to reference.

**Goal.** Categories and services are stored, admin-editable, and served to the
app.

**Scope.** `service_categories` and `services` schema, pricing shape (fixed vs
inspection), activation flags, ordering, public read endpoints, seed data for the
categories in [`../product/product-overview.md`](../product/product-overview.md).

**Out of scope.** Admin UI (EPIC 13). Master-specific pricing (EPIC 5).

**Technical considerations.** **The catalogue is data, not code.** Adding a
service must never require an app release. The app renders whatever the backend
returns.

**Pricing decided:** the **master** sets the price; the platform takes a
commission ([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)).
`services.base_price` is a reference only — the authoritative figure for an order
comes from `master_services`. This Epic is no longer blocked.

**Acceptance criteria.** The app renders the catalogue from the API with no
hardcoded list. A deactivated service is not offered. Fixed and inspection-priced
services are distinguishable by the client.

**Note.** This Epic is buildable while the design decisions blocking other Epics
are still outstanding — see [`roadmap.md`](roadmap.md).

---

## EPIC 4 — Customer Profile & Address

**Problem.** An order needs a destination a master can actually find.

**Goal.** Customers manage a profile and saved addresses with the structured
detail Baku requires.

**Scope.** Customer profile, `addresses` with building, **entrance (giriş)**,
floor, apartment, and landmark note; a default address; geocoding and reverse
geocoding behind the provider interface; a geocode cache in Postgres.

**Provider decided:** Google Maps Platform ([ADR-0004](../decisions/ADR-0004-location-and-maps.md)).

**Technical considerations.** A coordinate alone is frequently not enough to find
a door in Baku — the structured fields are a requirement, not a nicety. No call
site imports a vendor SDK directly.

**Acceptance criteria.** A customer saves, edits, and deletes addresses. Reverse
geocoding pre-fills a new address. Repeated geocoding of the same address hits
the cache. A denied location permission still permits manual entry.

---

## EPIC 5 — Master Profile & Verification

**Problem.** Only trusted professionals may be sent to someone's home.

**Goal.** Masters register, submit evidence, are reviewed, and only verified
masters can accept work.

**Scope.** Master profile, document upload via presigned URLs, verification
status and audit trail, admin review endpoints, suspension and reinstatement,
`master_services` selection, availability toggle.

**Out of scope.** Admin UI (EPIC 13). Payouts (EPIC 12).

**Technical considerations.** **Verification is checked server-side at accept
time against current status**, never against a token claim. Documents are private
and access-controlled. The schema carries status and audit trail regardless of
how the policy lands, so the data model is not blocked by the policy.

**Blocked by.** Verification criteria and the approval process.

**Acceptance criteria.** An unverified master cannot accept an order. A suspended
master cannot accept, even with a pre-suspension token. Every status change is
audit-logged with actor and reason. Documents are not publicly readable.

---

## EPIC 6 — Order Creation

**Problem.** The core action of the product does not exist.

**Goal.** A customer creates an order that enters `SEARCHING`.

**Scope.** `orders` schema and the status enum, the state machine with the
transition table, `order_status_history`, order creation with validation, problem
description, photo upload via presigned URLs, address association, price
resolution from the backend, **idempotent creation**.

**Out of scope.** Matching (EPIC 7), lifecycle beyond `SEARCHING` (EPIC 8).

**Technical considerations.** **The state machine is implemented first, with the
transition table in one place.** Prices come from the backend — never from the
client. Creation must be idempotent: mobile networks retry.

**Acceptance criteria.** An order is created and lands in `SEARCHING`. An invalid
transition is rejected. Every change writes history. A retried creation with the
same idempotency key does not duplicate. Photos upload without passing through
the API.

---

## EPIC 7 — Master Matching

**Problem.** An order in `SEARCHING` must reach a master.

**Goal.** Nearby eligible masters are found and exactly one is assigned.

**Scope.** The PostGIS nearby query with GiST index, eligibility filters
(verified, available, offers the category), dispatch, the accept operation with
its atomic guard, offer expiry, and the no-master-found outcome.

**Out of scope.** Weighted scoring on rating, response rate, or completion rate.

**Technical considerations.** **Start simple: distance, availability, category,
and verification.** The scoring model in the brief is built later, against real
data — a weighted score invented before launch is tuned against nothing.

**The accept guard is the critical piece.** The status check lives in the
`UPDATE`'s `WHERE` clause so the database evaluates it atomically. Reading then
writing is a race. A Redis lock is an optimisation, never the correctness
mechanism.

**Dispatch model decided — Bolt-style parallel broadcast, first accept wins**
([ADR-0009](../decisions/ADR-0009-dispatch-model.md)). Every eligible master in
range sees the offer at once; the radius widens if nobody accepts.

**The accepted cost is that every order produces losers.** That makes two things
mandatory, not optional: losing masters are notified **immediately** over the
realtime channel, and an unactioned offer **expires** rather than lingering.

Radius, timeout, and broadcast-size parameters are starting hypotheses in
`.env.example` — this Epic must replace them with measured values.

**Acceptance criteria.** The nearby query uses the GiST index (verified by
`EXPLAIN`) and returns under 100 ms p95. **A genuinely concurrent accept produces
exactly one winner**, with the losers told immediately. Unverified and unavailable
masters are excluded. An unactioned offer expires.

---

## EPIC 8 — Order Lifecycle

**Problem.** An accepted order has no way to progress to completion.

**Goal.** Orders move through the full state machine with authorization and
history.

**Scope.** All remaining transitions (on the way, arrived, in progress,
completed), cancellation for both sides, per-actor authorization on each
transition, inspection-based pricing set after inspection, admin override with
reason.

**Out of scope.** Payment settlement (EPIC 12).

**Technical considerations.** **Only the assigned master may advance an order.**
Every transition is validated and recorded. Invalid transitions are rejected with
a specific error.

**Blocked by.** Cancellation rules and penalties. Whether the customer confirms
completion. Whether the customer approves an inspection price before work starts.

**Acceptance criteria.** Every valid transition works; **every invalid one is
rejected**. A non-assigned master cannot advance an order. Cancellation works
from permitted states. History is complete and attributed.

---

## EPIC 9 — Realtime Tracking

**Problem.** Neither side can see what is happening live.

**Goal.** Order status and master location stream to the right clients.

**Scope.** WebSocket gateway with authentication on connect and reconnect,
**authorized room joins**, the Redis pub/sub adapter, location ingest under the
budget policy, throttled fan-out, client reconnection with backoff and jitter,
background location while an order is active.

**Out of scope.** Turn-by-turn navigation — the app hands off to a maps app.

**Technical considerations.** **The Redis adapter is not optional** — without it,
a client on instance A never receives an event from instance B. Location updates
are a budget, not a stream: distance-filter on-device first. Interpolate the
marker client-side rather than raising update frequency.

**Acceptance criteria.** A customer sees the master move during an active order.
**Location is not visible to anyone else, and not after completion.** Unauthorized
room join is refused. A reconnecting client recovers correct state. Measured
battery drain over a realistic shift is acceptable on mid-range Android — and the
budget table in [`../architecture/realtime-architecture.md`](../architecture/realtime-architecture.md)
is updated with the real numbers.

---

## EPIC 10 — Notifications

**Problem.** Users miss events when the app is closed.

**Goal.** Push notifications for every meaningful order event.

**Scope.** `devices` with push token registration, Expo push integration, the
`notifications` BullMQ queue, notifications for new offer, accepted, nearby,
arrived, status change, cancellation, and review reminder. Preferences and
deep-linking into the relevant screen.

**Technical considerations.** **Notifications are queued, never sent inline in a
request.** Jobs are idempotent and carry ids, not objects. Expired push tokens
are pruned. A user has several devices.

**Acceptance criteria.** Each event delivers to the right user. A failed send
retries and lands in the dead-letter queue rather than disappearing. Tapping a
notification opens the right screen. Preferences are respected.

---

## EPIC 11 — Reviews & Ratings

**Problem.** There is no trust signal on either side.

**Goal.** Both parties review each other after completion; ratings aggregate.

**Scope.** `reviews` schema, submission restricted to a completed order between
those two parties, rating aggregation on master profiles, display, moderation
hooks, rate limiting.

**Technical considerations.** A review requires a completed order between exactly
those parties — enforced by constraint **and** service validation. Aggregates are
maintained incrementally, not recomputed per read.

**Blocked by.** Whether reviewing is mandatory, skippable, or promptable later.

**Acceptance criteria.** A review cannot be left without a completed order. A
party cannot review twice. Aggregates are correct. A moderated review is excluded
from the aggregate.

---

## EPIC 12 — Payments

**Status: BLOCKED. Do not implement.**

**Problem.** No money moves.

**Payment methods decided: both cash and card**
([ADR-0007](../decisions/ADR-0007-payments.md)).

**This is the hardest combination, and it changes the schema.** On a cash order
the money never passes through the platform — the master is paid directly and in
full, so commission cannot be deducted at source and becomes a **debt**. That
requires:

- a **master balance (wallet)** recording commission accrued on cash orders
- a **debt threshold** above which a master cannot accept new work, or the debt
  is never settled and cash becomes a way to use the platform for free
- a recorded completion amount on cash orders, so the commission owed is computed
  from data rather than a claim

`master_wallets` and `commission_rules` may therefore be needed **with this
Epic**, not deferred to EPIC 14 as originally planned.

**Still blocked by** [ADR-0007](../decisions/ADR-0007-payments.md): whether
TezUsta may hold customer funds (**needs legal advice** — likely a regulated
activity), the provider, the commission rate, and the payout cycle.

**Constraints that already hold.** Money is integer minor units, never a float.
An order freezes its own amount and commission rate. Payment records are
append-only. Every mutating operation is idempotent. Webhooks are the settlement
source of truth, verified and processed idempotently. Prices come from the
backend. PCI scope stays at zero — card data never touches our servers.
Reconciliation is a scheduled job.

---

## EPIC 13 — Admin Panel

**Problem.** Verification, disputes, and catalogue management have no interface.

**Goal.** `apps/admin` exists with the operations in
[`../product/admin-flow.md`](../product/admin-flow.md).

**Scope.** Admin web app, separate stronger authentication, master verification
review, catalogue management, order oversight and override, dispute handling,
moderation, operational dashboard, and **full audit logging**.

**Technical considerations.** **Every admin action is audit-logged** — actor,
action, target, timestamp, reason. Admin endpoints are a separate guarded
surface, never a role flag on a customer endpoint. The schema must not assume a
single `is_admin` boolean.

**Blocked by.** Permission levels. Whether MFA is required. Dispute policy.

---

## EPIC 14 — Subscription & Commission

**Status: BLOCKED on EPIC 12.**

Commission rules, master wallets, payouts, subscription plans. Entities do not
exist until this Epic — designing a wallet before the cash-vs-card question is
answered would be designing for a guess.

---

## EPIC 15 — Security & Abuse Prevention

**Continuous, not terminal.** Security is a requirement of every Epic
([`../engineering/security.md`](../engineering/security.md)). This Epic audits
and hardens what was already built to standard.

**Scope.** Full security review against the checklist, penetration-style testing
of authorization boundaries, abuse-vector work specific to marketplaces (fake
orders, review manipulation, location spoofing, competitor blocking), rate-limit
tuning, dependency audit, PII and retention review, incident response.

---

## EPIC 16 — Performance & Scalability

**Continuous, not terminal.**

**Scope.** Load testing the nearby query and location ingest, query plan review,
index audit, **replacing the hypothetical budgets in
[`../engineering/performance.md`](../engineering/performance.md) with measured
numbers**, mobile profiling on mid-range Android, Redis position caching if
measurement justifies it, horizontal scaling validation.

---

## EPIC 17 — Production Deployment

**Problem.** Nothing runs outside a laptop.

**Goal.** Staging and production exist, with CI/CD, monitoring, and tested
backups.

**Scope.** Infrastructure provisioning, managed Postgres **with PostGIS
confirmed**, managed Redis, object storage, deployment pipeline, migration
strategy, secrets management, TLS and domains, monitoring and alerting, **tested
backup restore**, EAS Build and store submission.

**Technical considerations.** Migrations run before code and must be
backward-compatible — during a rolling deploy both versions are live. Staging
matches production's Postgres and PostGIS versions. Staging never holds
production third-party credentials. **An untested backup is a belief, not a
backup.**

**Blocked by.** Hosting and cloud provider choice.
