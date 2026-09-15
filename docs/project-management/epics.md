# Epics

Source definitions for the GitHub Epics. Each is created as a tracking issue
labelled `epic` with native sub-issues. Order and dependencies:
[`roadmap.md`](roadmap.md).

> An Epic is a **tracking issue**, not a work item. Nobody is assigned to "do the
> Epic" — its sub-issues carry the work.

Every Epic below carries the eight sections the Epic template requires
([`issue-rules.md`](issue-rules.md)): Problem, Goal, Scope, Out of scope,
Technical considerations, Dependencies, Acceptance criteria, Definition of Done.
The dependency table in [`roadmap.md`](roadmap.md) is authoritative; the
**Dependencies** section of each Epic restates it.

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

**Already delivered.** `apps/mobile` is scaffolded (Expo SDK 57, Expo Router,
NativeWind 4 + Tailwind 3.4.17, Jest), the design system
([ADR-0011](../decisions/ADR-0011-design-system.md)) is implemented in
`apps/mobile/src/theme`, and the Storybook workshop
([ADR-0012](../decisions/ADR-0012-component-workshop.md)) runs. What remains is
`apps/api`, Docker Compose, Drizzle and the PostGIS migration, env parsing,
health endpoints, the API test harness, and CI. See
[`roadmap.md`](roadmap.md#where-the-repository-actually-is).

**Out of scope.** Any business feature, any UI beyond a smoke screen, auth. Any
`packages/*` workspace beyond `eslint-config` and `typescript-config` — a package
is created when a second workspace imports it
([ADR-0016](../decisions/ADR-0016-shared-package-timing.md)), so provider
interfaces and runtime config start in `apps/api/src/infra/`.

**Technical considerations.** Use `npx expo install` for Expo-managed packages,
never `pnpm add`. The version pins in [ADR-0002](../decisions/ADR-0002-toolchain-version-pinning.md)
are binding. `nodeLinker: hoisted` is required for Metro.

**Dependencies.** None. This Epic is the prerequisite for everything else.

**Acceptance criteria.** `pnpm verify` passes. The API boots, `/health/ready`
reports database and Redis. The mobile app builds and runs against the local
API. CI is green on a pull request. `pnpm graph` shows both apps. No
`packages/*` workspace exists that has fewer than two consumers.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 2 — Authentication & User Roles

**Problem.** Nothing can be user-scoped without identity.

**Goal.** Users authenticate, hold customer and/or master roles, and every
endpoint is authorized server-side.

**Scope.** Token issuance, refresh rotation with reuse detection, device
sessions, logout and logout-everywhere, `expo-secure-store` on the client, guards
for authentication/role/ownership, rate limiting, and the OTP sender behind a
provider interface. **The `admin` role, its permission checks, and the guard that
enforces them** ship here as part of the shared authorization layer
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)) — every later Epic
that exposes an admin endpoint depends on them existing.

**Out of scope.** Admin **credentials** — email + password + mandatory TOTP, the
admin session policy, and `apps/admin` — are EPIC 13
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)). Admin
**authorization** is in scope here: until EPIC 13, admin endpoints exist, are
guarded, and are tested against a fixture admin, but no production admin
credential is issued.

**Technical considerations.** Design is settled in
[`../architecture/authentication.md`](../architecture/authentication.md). A user
may hold both roles — role is a set, not a column. **Role claims are re-checked
against the database on every authorization decision.**

**Sign-in method decided:** **phone number + SMS OTP only**, no social sign-in
([ADR-0008](../decisions/ADR-0008-otp-delivery.md)). The phone number is
simultaneously the identity and the contact channel. That decision governs
customer and master accounts only; admin accounts are a separate credential path
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)).

🔴 **The SMS provider blocks completing EPIC 2 — real sign-in — not building
it.** The sender is an interface with a stub implementation and
`SMS_PROVIDER=stub` ships in `.env.example`, so every endpoint, guard, rotation
rule and rate limit is implementable and testable today. What cannot happen until
a provider is chosen and a sender ID is registered with Azerbaijani operators is
a real user receiving a real code. This remains the highest-priority unblocking
decision in the project.

**Also needed before launch:** an account-recovery path for a user who loses
their phone number. This is the principal weakness of phone-only sign-in.

**Dependencies.** EPIC 1. Real sign-in additionally requires the SMS provider and
sender ID ([ADR-0008](../decisions/ADR-0008-otp-delivery.md)); the Epic cannot be
closed on the stub.

**Acceptance criteria.** Sign-in issues a valid pair. Refresh rotates. **Reuse
revokes the family.** A suspended user cannot act with a pre-suspension token.
Rate limits trigger. Unauthorized access to another user's resource returns 404.
An endpoint requiring the `admin` role rejects customer and master tokens and
admits a fixture admin. Swapping the stub sender for a real provider touches only
the provider implementation, not a call site.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue. The Epic stays open until the OTP sender is wired
to a chosen provider.

---

## EPIC 3 — Service Catalog

**Problem.** Orders need a catalogue of services to reference.

**Goal.** Categories and services are stored, admin-editable, and served to the
app.

**Scope.** `service_categories` and `services` schema, pricing shape (fixed vs
inspection), activation flags, ordering, public read endpoints, admin write
endpoints behind the `admin` guard from EPIC 2, seed data for the categories in
[`../product/product-overview.md`](../product/product-overview.md).

**Out of scope.** Admin UI (EPIC 13). Master-specific pricing (EPIC 5).

**Technical considerations.** **The catalogue is data, not code.** Adding a
service must never require an app release. The app renders whatever the backend
returns.

**Pricing decided:** the **master** sets the price; the platform takes a
commission ([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)).
`services.base_price` is a reference only — the authoritative figure for an order
comes from `master_services`. This Epic is no longer blocked.

**Dependencies.** EPIC 1. The `admin` role and guard come from EPIC 2
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)); the catalogue's
public read surface does not depend on EPIC 2 and can land first.

**Acceptance criteria.** The app renders the catalogue from the API with no
hardcoded list. A deactivated service is not offered. Fixed and inspection-priced
services are distinguishable by the client. A non-admin token cannot write to the
catalogue.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

**Note.** This Epic is buildable while the design decisions blocking other Epics
are still outstanding — see [`roadmap.md`](roadmap.md).

---

## EPIC 4 — Customer Profile & Address

**Problem.** An order needs a destination a master can actually find.

**Goal.** Customers manage a profile and saved addresses with the structured
detail Baku requires.

**Scope.** Customer profile, `addresses` with building, **entrance (giriş)**,
floor, apartment, and landmark note; a default address; geocoding and reverse
geocoding behind the provider interface; a geocode cache in Postgres. This Epic
also **measures whether `react-native-maps` forces a development build** —
[ADR-0008](../decisions/ADR-0008-otp-delivery.md) left that open and assigned it
to EPIC 1, but EPIC 1 ships no UI beyond a smoke screen and no map, so the
measurement belongs to the Epic that first renders one.

**Out of scope.** Master-side location streaming and live tracking (EPIC 9).
Turn-by-turn navigation — the app hands off to a maps app. The Google Maps style
JSON, which is owner-supplied art (ADR-0011).

**Provider decided:** Google Maps Platform ([ADR-0004](../decisions/ADR-0004-location-and-maps.md)).
The provider interface lives in `apps/api/src/infra/geo/` until a second
workspace consumes it ([ADR-0016](../decisions/ADR-0016-shared-package-timing.md)).

**Technical considerations.** A coordinate alone is frequently not enough to find
a door in Baku — the structured fields are a requirement, not a nicety. No call
site imports a vendor SDK directly.

**Dependencies.** EPIC 2.

**Acceptance criteria.** A customer saves, edits, and deletes addresses. Reverse
geocoding pre-fills a new address. Repeated geocoding of the same address hits
the cache. A denied location permission still permits manual entry. Whether a
development build is required for `react-native-maps` is measured and recorded,
not assumed.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 5 — Master Profile & Verification

**Problem.** Only trusted professionals may be sent to someone's home.

**Goal.** Masters register, submit evidence, are reviewed, and only verified
masters can accept work.

**Scope.** Master profile, document upload via presigned URLs, verification
status and audit trail, admin review endpoints behind the `admin` guard from
EPIC 2, suspension and reinstatement, `master_services` selection, availability
toggle.

**Out of scope.** Admin UI (EPIC 13). `master_wallets` and `commission_rules`
(EPIC 12). Payouts and subscription plans (EPIC 14).

**Technical considerations.** **Verification is checked server-side at accept
time against current status**, never against a token claim. Documents are private
and access-controlled. The schema carries status and audit trail regardless of
how the policy lands, so the data model is not blocked by the policy. The storage
provider sits behind an interface in `apps/api/src/infra/storage/`
([ADR-0005](../decisions/ADR-0005-object-storage.md),
[ADR-0016](../decisions/ADR-0016-shared-package-timing.md)).

**Dependencies.** EPIC 2. Blocked on the verification criteria and approval
process (owner decision). Document upload is additionally blocked on the object
storage provider ([ADR-0005](../decisions/ADR-0005-object-storage.md), provider
pending); the presigned-URL interface and its tests can be built against a local
S3-compatible stand-in.

**Acceptance criteria.** An unverified master cannot accept an order. A suspended
master cannot accept, even with a pre-suspension token. Every status change is
audit-logged with actor and reason. Documents are not publicly readable. The
verification criteria, once supplied, are expressible against the stored evidence
and the audit trail without a schema change — this Epic does not invent them.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue. The Epic stays open until the verification criteria
are supplied and encoded.

---

## EPIC 6 — Order Creation

**Problem.** The core action of the product does not exist.

**Goal.** A customer creates an order that enters `SEARCHING`.

**Scope.** `orders` schema and the status enum, the state machine with the
transition table from
[ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md) in one place, order
creation via the `DRAFT` idempotency anchor transitioning to `SEARCHING` in the
same transaction, `order_status_history`, validation, problem description, photo
upload via presigned URLs, address association, and the **indicative price
range** read model (min–max of eligible masters' prices) that the customer sees
before creating the order
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)).

**Out of scope.** Matching (EPIC 7), lifecycle beyond `SEARCHING` (EPIC 8). The
firm price — it is frozen at accept in EPIC 7, not here.

**Technical considerations.** **The state machine is implemented first, with the
transition table in one place.** Prices come from the backend — never from the
client. `orders.price_minor` is **nullable and NULL at creation**; a not-null
constraint would be wrong
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)). The indicative range
is computed from the same eligibility predicate the broadcast uses, is labelled
as an estimate, and is never stored on the order. Creation must be idempotent:
mobile networks retry, and the `DRAFT` row plus the idempotency key is the
mechanism.

**Dependencies.** EPIC 3, EPIC 4, EPIC 5. Photo upload is blocked on the object
storage provider ([ADR-0005](../decisions/ADR-0005-object-storage.md), provider
pending).

**Acceptance criteria.** An order is created and lands in `SEARCHING` with
`price_minor` NULL. An invalid transition is rejected. Every change writes
history. A retried creation with the same idempotency key returns the existing
order rather than a second one. Photos upload without passing through the API.
The customer sees a range labelled as an estimate, never a firm figure, before
accept.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 7 — Master Matching

**Problem.** An order in `SEARCHING` must reach a master.

**Goal.** Nearby eligible masters are found and exactly one is assigned.

**Scope.** The PostGIS nearby query with GiST index, the eligibility predicate,
dispatch, the accept operation with its atomic guard, **the price freeze at
accept**, offer expiry, and the no-master-found outcome when the dispatch time
limit expires.

The eligibility predicate is the whole gate. A master may accept an order only
if **verified AND online AND offers the service AND in radius AND
`commission_debt_minor <= MAX_COMMISSION_DEBT_MINOR`**. The debt column reads 0
until EPIC 12 populates it, but the check ships here, with matching — otherwise
it falls between the two Epics and the cash-commission threshold has no
enforcement point.

**Out of scope.** Weighted scoring on rating, response rate, or completion rate.
Populating `commission_debt_minor` (EPIC 12).

**Technical considerations.** **Start simple: distance, availability, category,
verification, and the debt gate.** The scoring model in the brief is built later,
against real data — a weighted score invented before launch is tuned against
nothing.

**The accept guard is the critical piece.** The status check lives in the
`UPDATE`'s `WHERE` clause so the database evaluates it atomically. Reading then
writing is a race. A Redis lock is an optimisation, never the correctness
mechanism.

**Price freeze decided:** the accepting master's stored price is copied into
`orders.price_minor` **in the same statement that sets `master_id`**
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)). One atomic operation
decides both the winner of the race and the price. A master's later price edit
never moves a frozen price, and the commission basis is fixed at the same
instant.

**Dispatch model decided — Bolt-style parallel broadcast, first accept wins**
([ADR-0009](../decisions/ADR-0009-dispatch-model.md)). Every eligible master in
range sees the offer at once; the radius widens if nobody accepts.

**The accepted cost is that every order produces losers.** That makes two things
mandatory, not optional: losing masters are notified **immediately** over the
realtime channel, and an unactioned offer **expires** rather than lingering.

Radius, timeout, and broadcast-size parameters are starting hypotheses in
`.env.example` — this Epic must replace them with measured values.

**Dependencies.** EPIC 6.

**Acceptance criteria.** The nearby query uses the GiST index (verified by
`EXPLAIN`) and returns under 100 ms p95. **A genuinely concurrent accept produces
exactly one winner**, with the losers told immediately. Unverified and unavailable
masters are excluded. A master whose `commission_debt_minor` exceeds
`MAX_COMMISSION_DEBT_MINOR` is excluded from the broadcast and cannot accept. The
accept transaction writes `master_id` and `price_minor` together. An unactioned
offer expires. An order that nobody accepts within the limit ends in
`NO_MASTER_FOUND`, not `CANCELLED`.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 8 — Order Lifecycle

**Problem.** An accepted order has no way to progress to completion.

**Goal.** Orders move through the full state machine with authorization and
history.

**Scope.** The complete status set and transition table from
[ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md):

- All remaining forward transitions — on the way, arrived, in progress,
  completed, and the payment and dispute states.
- **`NO_MASTER_FOUND`** as a terminal status distinct from `CANCELLED`, so an
  unfilled order is never counted against anyone's cancellation rate.
- **`RESOLVED` and `REFUNDED`** as the two terminal outcomes of `DISPUTED`, both
  requiring an admin actor and a mandatory reason.
- **The re-dispatch edges back to `SEARCHING`** from `ACCEPTED`,
  `MASTER_ON_THE_WAY` and `MASTER_ARRIVED`, in one transaction: clear
  `master_id` and `price_minor`, increment `redispatch_count`, exclude the
  cancelling master from the next broadcast, and write history with actor and
  reason. At `MAX_ORDER_REDISPATCHES` the order goes to `NO_MASTER_FOUND` rather
  than searching again.
- Cancellation for both sides, per-actor authorization on each transition,
  inspection-based pricing set after inspection, and **admin override with a
  mandatory reason**.

**Out of scope.** Payment settlement (EPIC 12). Re-dispatch from `IN_PROGRESS` —
[ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md) rejects it; a master
who abandons work in progress cancels, and that is a dispute.

**Technical considerations.** **Only the assigned master may advance an order.**
Every transition is validated and recorded. Invalid transitions are rejected with
a specific error.

**Admin override bypasses the actor check, never the edge table.** An admin may
perform a transition the table permits even though they are neither the customer
nor the assigned master; an admin may **not** perform a transition the table does
not contain. If an admin needs an edge that does not exist, that is a new ADR,
not a special case in a service.

`MAX_ORDER_REDISPATCHES` and the dispute window are configuration, not literals.
`redispatch_count` is an integer column defaulting to 0. Clearing `master_id` on
re-dispatch is what keeps EPIC 7's accept guard — a conditional update on
`master_id IS NULL` — correct on the second round.

**Settled since this Epic was written:** the customer does **not** confirm
completion. The assigned master marks the work complete and the customer's
recourse is to open a dispute within the window
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)).

**Dependencies.** EPIC 7. Blocked on the cancellation rules and penalties — who
may cancel at which status without penalty, and what the penalty is (owner
decision). ADR-0015 settles which transitions exist, not what they cost.

**Acceptance criteria.** Every valid transition works; **every invalid one is
rejected**. A non-assigned master cannot advance an order. Cancellation works
from permitted states. History is complete and attributed. A master cancelling
after accept returns the order to `SEARCHING` with `master_id` and `price_minor`
cleared and `redispatch_count` incremented; at the cap the order becomes
`NO_MASTER_FOUND`. A timed-out order is `NO_MASTER_FOUND` and is excluded from
every cancellation metric. A dispute closes only to `RESOLVED` or `REFUNDED`,
only by an admin, and only with a reason. An admin override of an edge that is
not in the table is rejected. The cancellation penalty rules, once supplied, are
expressible on top of this state machine without adding a status.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue. The Epic stays open until the cancellation policy
is supplied and encoded.

---

## EPIC 9 — Realtime Tracking

**Problem.** Neither side can see what is happening live.

**Goal.** Order status and master location stream to the right clients.

**Scope.** WebSocket gateway with authentication on connect and reconnect,
**authorized room joins**, the Redis pub/sub adapter, location ingest under the
budget policy, throttled fan-out, client reconnection with backoff and jitter,
background location while an order is active.

**Out of scope.** Turn-by-turn navigation — the app hands off to a maps app. Push
notifications for the same events (EPIC 10).

**Technical considerations.** **The Redis adapter is not optional** — without it,
a client on instance A never receives an event from instance B. Location updates
are a budget, not a stream: distance-filter on-device first. Interpolate the
marker client-side rather than raising update frequency.

**Dependencies.** EPIC 8.

**Acceptance criteria.** A customer sees the master move during an active order.
**Location is not visible to anyone else, and not after completion.** Unauthorized
room join is refused. A reconnecting client recovers correct state. Measured
battery drain over a realistic shift is acceptable on mid-range Android — and the
budget table in [`../architecture/realtime-architecture.md`](../architecture/realtime-architecture.md)
is updated with the real numbers.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 10 — Notifications

**Problem.** Users miss events when the app is closed.

**Goal.** Push notifications for every meaningful order event.

**Scope.** `devices` with push token registration, Expo push integration, the
`notifications` BullMQ queue, notifications for new offer, accepted, nearby,
arrived, status change, cancellation, and review reminder. Preferences and
deep-linking into the relevant screen.

**Out of scope.** SMS and email notification channels. Marketing or promotional
pushes. In-app chat — an open product question, see [`roadmap.md`](roadmap.md).
The realtime channel itself (EPIC 9).

**Technical considerations.** **Notifications are queued, never sent inline in a
request.** Jobs are idempotent and carry ids, not objects. Expired push tokens
are pruned. A user has several devices.

**Dependencies.** EPIC 8. Shares the realtime event vocabulary with EPIC 9.

**Acceptance criteria.** Each event delivers to the right user. A failed send
retries and lands in the dead-letter queue rather than disappearing. Tapping a
notification opens the right screen. Preferences are respected.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 11 — Reviews & Ratings

**Problem.** There is no trust signal on either side.

**Goal.** Both parties review each other after completion; ratings aggregate.

**Scope.** `reviews` schema, submission restricted to a completed order between
those two parties, rating aggregation on master profiles, display, moderation
hooks, rate limiting.

**Out of scope.** The moderation interface (EPIC 13). Dispute handling — a
dispute is an order state, not a review ([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)).
Weighting ratings into the matching score (deliberately deferred, EPIC 7).

**Technical considerations.** A review requires a completed order between exactly
those parties — enforced by constraint **and** service validation. Aggregates are
maintained incrementally, not recomputed per read.

**Dependencies.** EPIC 8. Whether reviewing is mandatory, skippable, or
promptable later is an open product question; it does not block the schema, which
must support all three.

**Acceptance criteria.** A review cannot be left without a completed order. A
party cannot review twice. Aggregates are correct. A moderated review is excluded
from the aggregate. Making reviewing mandatory or optional later is a policy
change, not a schema change.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 12 — Payments

**Status: BLOCKED. Do not implement.**

**Problem.** No money moves.

**Goal.** An order is settled in cash or by card, the commission owed on it is
recorded against the master, and the platform can tell at any moment what each
master owes.

**Payment methods decided: both cash and card**
([ADR-0007](../decisions/ADR-0007-payments.md)).

**Scope.** Payment records and the settlement path for both methods, provider
integration and webhook handling, the completion amount on cash orders,
reconciliation, and — because cash commission debt exists from the very first
cash order — **`master_wallets` and `commission_rules` belong to this Epic**, not
to EPIC 14.

**This is the hardest combination, and it changes the schema.** On a cash order
the money never passes through the platform — the master is paid directly and in
full, so commission cannot be deducted at source and becomes a **debt**. That
requires:

- a **master balance (wallet)** recording commission accrued on cash orders
- a **debt threshold** above which a master cannot accept new work, or the debt
  is never settled and cash becomes a way to use the platform for free — the
  check itself ships with matching in EPIC 7, against
  `commission_debt_minor <= MAX_COMMISSION_DEBT_MINOR`
- a recorded completion amount on cash orders, so the commission owed is computed
  from data rather than a claim

**Out of scope.** Subscription plans, payouts to masters, and commission-rule
tuning (EPIC 14). The matching-time debt check itself (EPIC 7) — this Epic
populates the column that check reads. A card refund mechanism for cash orders: a
refund on a cash order is a commission adjustment against the master's balance
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)).

**Technical considerations.** Money is integer minor units, never a float. An
order freezes its own amount at accept and its commission rate with it
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)). Payment records are
append-only. Every mutating operation is idempotent. Webhooks are the settlement
source of truth, verified and processed idempotently. Prices come from the
backend. PCI scope stays at zero — card data never touches our servers.
Reconciliation is a scheduled job. The `PAYMENT_PENDING`, `PAID`, `DISPUTED`,
`RESOLVED` and `REFUNDED` statuses already exist from EPIC 8; this Epic drives
them, it does not add to the table.

**Dependencies.** EPIC 8. Blocked by [ADR-0007](../decisions/ADR-0007-payments.md)
on three owner or legal decisions: whether TezUsta may hold customer funds
(**needs legal advice** — likely a regulated activity), the payment provider, and
the commission rate plus price guardrails. No payment code is written before all
three are answered.

**Acceptance criteria.** A card order settles through the provider and reaches
`PAID` on a verified webhook, once, however many times the webhook is delivered.
A cash order records the completion amount and accrues the commission owed to
`master_wallets` from the frozen price and the frozen rate. A master whose debt
exceeds `MAX_COMMISSION_DEBT_MINOR` stops being offered work — the EPIC 7 gate
now has real data behind it. Reconciliation finds no unexplained difference over
a seeded day. No card data is stored or logged anywhere in the system. The
fund-holding answer, once given, changes the settlement path only — not the
wallet, commission or order schema.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue. This Epic may not be started, let alone closed,
before the three blocking decisions above are recorded.

---

## EPIC 13 — Admin Panel

**Problem.** Verification, disputes, and catalogue management have no interface.

**Goal.** `apps/admin` exists with the operations in
[`../product/admin-flow.md`](../product/admin-flow.md), and real humans can sign
in to it.

**Scope.** The admin web app; **admin credentials — email + password + mandatory
TOTP — the `admin_users` table, admin provisioning by an existing admin, and the
admin session policy** (access 15 min, refresh 8 hours rotated, 30-minute idle
timeout, httpOnly `Secure` `SameSite=Strict` cookie) per
[ADR-0014](../decisions/ADR-0014-admin-authentication.md); master verification
review, catalogue management, order oversight and override, dispute handling to
`RESOLVED` or `REFUNDED`, moderation, operational dashboard, and **full audit
logging**.

**Out of scope.** Admin **authorization** — the `admin` role, its permission
checks, and the guard that enforces them ship in EPIC 2
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)). The admin-only
endpoints themselves, which are built by the Epics that own their domains
(EPIC 3, 5 and 8). Analytics beyond the operational dashboard. Replacing the
password factor with an external identity provider — deferred, not rejected.

**Technical considerations.** **Every admin action is audit-logged** — actor,
action, target, timestamp, reason — including reads of personal data. Admin
endpoints are a separate guarded surface, never a role flag on a customer
endpoint. The schema must not assume a single `is_admin` boolean: `admin_users`
is a distinct table with its own session table, and one human who is both an
admin and a customer has two unlinked accounts. An admin credential cannot sign
in to the mobile app and a phone OTP cannot sign in to the admin panel — the two
paths share no issuer, audience claim, or refresh family. Dispute outcomes are
the terminal states in
[ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md); this Epic gives them
an interface, it does not define new ones.

**Dependencies.** EPIC 5 and EPIC 8. The `admin` role and guard come from
EPIC 2. Still open, and not blocking: which TOTP library or identity provider
supplies the second factor
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)).

**Acceptance criteria.** An admin signs in with email, password and TOTP; without
the second factor sign-in fails. An admin session expires after 8 hours and after
30 minutes idle. An admin credential is rejected by the mobile API and a phone
OTP is rejected by the admin API. There is no self-registration path. Every
admin action, including a read of personal data, produces an audit record with
actor, action, target, reason and timestamp. An admin can verify a master, edit
the catalogue, override a stuck order within the transition table, and close a
dispute to `RESOLVED` or `REFUNDED`.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 14 — Subscription & Commission

**Status: BLOCKED on EPIC 12.**

**Problem.** Commission accrues but never leaves the ledger: masters are not paid
out, the commission rate cannot be varied per plan or category, and there is no
subscription product.

**Goal.** Masters are paid out on a cycle, commission rules can be tuned without
a deploy, and subscription plans exist as an alternative to per-order commission.

**Scope.** Subscription plans and enrolment, the payout cycle and payout records,
and tuning of the `commission_rules` introduced in EPIC 12 — per plan, per
category, and over time.

**Out of scope.** `master_wallets` and `commission_rules` themselves (EPIC 12) —
cash commission debt exists from the first cash order, so those entities cannot
wait for this Epic. The matching-time debt gate (EPIC 7).

**Technical considerations.** A commission rule is versioned, never edited in
place: an order froze a rate at accept
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)) and that historical
figure must stay reconstructable. Payouts are append-only, idempotent, and
reconciled against the wallet. Designing a subscription before the cash-vs-card
question is answered would be designing for a guess.

**Dependencies.** EPIC 12, including its three blocking decisions.

**Acceptance criteria.** A payout run pays each master exactly what the wallet
says they are owed, once, and is safe to re-run. Changing a commission rule does
not alter the rate frozen on an existing order. A master on a subscription plan
is charged according to that plan and not twice. Every payout and every rule
change is auditable.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.

---

## EPIC 15 — Security & Abuse Prevention

**Continuous, not terminal.** Security is a requirement of every Epic
([`../engineering/security.md`](../engineering/security.md)). This Epic audits
and hardens what was already built to standard.

**Problem.** Every Epic is built to the security standard, but nothing verifies
that at the system level, and marketplace-specific abuse has no owner.

**Goal.** The security checklist has been run against the whole system by
someone deliberately trying to break it, and the marketplace abuse vectors have
named mitigations.

**Scope.** Full security review against the checklist, penetration-style testing
of authorization boundaries, abuse-vector work specific to marketplaces (fake
orders, review manipulation, location spoofing, competitor blocking), rate-limit
tuning, dependency audit, PII and retention review, incident response.

**Out of scope.** Building the controls themselves — each Epic ships its own
authorization, validation and rate limiting. This Epic verifies and hardens; it
is not where security is added.

**Technical considerations.** A finding is an issue against the Epic that owns
the code, not a patch applied here. Vulnerability detail never goes in a public
issue ([`issue-rules.md`](issue-rules.md)).

**Dependencies.** Continuous. Runs alongside every Epic from EPIC 1 onwards.

**Acceptance criteria.** Every item on the security checklist has been executed
against a running system and recorded as pass or as a filed issue. Authorization
boundaries are tested negatively, not only positively. Each named abuse vector
has either a mitigation or a recorded, accepted risk. The dependency audit is
clean or every exception is justified. No token, OTP code, full phone number, or
precise coordinate appears in any log.

**Definition of Done.** Per [CLAUDE.md §8](../../CLAUDE.md) for each sub-issue.
As a continuous Epic this one is never closed; it is reviewed each release.

---

## EPIC 16 — Performance & Scalability

**Continuous, not terminal.**

**Problem.** The performance budgets in the documentation are hypotheses. Nothing
has been measured on real data or a real device.

**Goal.** Every budget on a hot path is a measured number, and the system is
known to scale horizontally rather than assumed to.

**Scope.** Load testing the nearby query and location ingest, query plan review,
index audit, **replacing the hypothetical budgets in
[`../engineering/performance.md`](../engineering/performance.md) with measured
numbers**, mobile profiling on mid-range Android, Redis position caching if
measurement justifies it, horizontal scaling validation.

**Out of scope.** Optimising code that has not been measured. Adding indexes
speculatively — an index a query plan does not use is a write cost with no
reader.

**Technical considerations.** A measurement without the device, dataset size and
concurrency it was taken at is not a measurement. Mid-range Android is the
realistic device in this market, not the reviewer's phone.

**Dependencies.** Continuous. Meaningful measurement of the nearby query needs
EPIC 7 and a seeded dataset.

**Acceptance criteria.** The nearby query's plan is recorded and uses the GiST
index. The budget tables in
[`../engineering/performance.md`](../engineering/performance.md) and
[`../architecture/realtime-architecture.md`](../architecture/realtime-architecture.md)
contain measured figures with the conditions they were measured under. Two API
instances behind a load balancer behave identically — no in-process state.
Battery and frame-rate figures come from a mid-range Android device.

**Definition of Done.** Per [CLAUDE.md §8](../../CLAUDE.md) for each sub-issue.
As a continuous Epic this one is never closed; it is reviewed each release.

---

## EPIC 17 — Production Deployment

**Problem.** Nothing runs outside a laptop.

**Goal.** Staging and production exist, with CI/CD, monitoring, and tested
backups.

**Scope.** Infrastructure provisioning, managed Postgres **with PostGIS
confirmed**, managed Redis, object storage, deployment pipeline, migration
strategy, secrets management, TLS and domains, monitoring and alerting, **tested
backup restore**, EAS Build and store submission.

**Out of scope.** Multi-region deployment. Autoscaling policy tuning — that
follows EPIC 16's measurements. Application-level performance work (EPIC 16) and
the security audit (EPIC 15).

**Technical considerations.** Migrations run before code and must be
backward-compatible — during a rolling deploy both versions are live. Staging
matches production's Postgres and PostGIS versions. Staging never holds
production third-party credentials. **An untested backup is a belief, not a
backup.**

**Dependencies.** EPIC 8 — there is no point deploying a system that cannot
complete an order. Blocked on the hosting and cloud provider choice (owner
decision), which also settles the object storage provider
([ADR-0005](../decisions/ADR-0005-object-storage.md)).

**Acceptance criteria.** A commit to `main` reaches staging without a manual
step. Production and staging run the same Postgres and PostGIS versions, with
PostGIS confirmed present on the managed instance. A backup is restored into a
scratch environment and the restored system serves traffic — verified, not
assumed. Secrets exist only in the secret store; none is in the repository or in
an `EXPO_PUBLIC_*` variable. Alerts fire on a deliberately induced failure. An
EAS build is submitted to both stores.

**Definition of Done.** Every sub-issue closed from a merged PR, the acceptance
criteria above verified by execution, and [CLAUDE.md §8](../../CLAUDE.md)
satisfied for each sub-issue.
