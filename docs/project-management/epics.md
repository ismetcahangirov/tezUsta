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

**Pricing decided:** the **master** sets the price
([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)); there is no
commission ([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md)).
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

**Out of scope.** Admin UI (EPIC 13). Subscriptions (EPIC 14).
`master_wallets`, `commission_rules` and payouts are not built at all
([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md)).

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

**Superseded by ADR-0046 (10 October 2026).** There is no commission, so the
debt term is removed (#321) and an active subscription takes its place in the
same predicate and the same accept re-check (#322). This section records what
EPIC 7 built.

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

**Out of scope.** Payment settlement — the platform never touches order money
([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md)). Re-dispatch from `IN_PROGRESS` —
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

**Status: RETIRED by [ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md)
(10 October 2026). Nothing is built here.**

**Problem.** This Epic was scoped to settle orders in cash and by card, to record
the commission owed on each, and to track what every master owed the platform.

**Why it is retired.** The owner decided on 10 October 2026 that TezUsta earns
only from master subscriptions and that **the platform never touches order
money**. The customer pays the master directly, in cash or by the master's own
card or transfer. With no order payment and no commission there is no
settlement path, no wallet, no debt and no order refund to build. The three
blockers this Epic carried are gone with it: the fund-holding question is
answered "no", the payment provider now concerns only subscription billing
(EPIC 14), and there is no commission rate.

**What moved elsewhere.**

- Subscription billing — the provider port, the hosted checkout, the webhook and
  reconciliation — belongs to EPIC 14 (#323).
- ADR-0007's binding constraints still apply there: integer minor units,
  append-only payment records, idempotency on every mutating operation, webhooks
  as the settlement source of truth, prices from the backend, scheduled
  reconciliation and PCI scope zero.
- Removing the commission-debt column, its environment variable and the
  dispatch term is #321.

**Order statuses.** `PAYMENT_PENDING` and `PAID` are dormant: nothing writes
them, and a normal order ends at `COMPLETED`. `REFUNDED` stays withheld from
admins with `REFUND_NOT_AVAILABLE`, indefinitely. All three stay in the enum
and the transition table, and retiring them would be its own ADR (ADR-0046 § 4).

**Dependencies.** None. **Definition of Done.** The tracking issue (#13) is
closed as superseded by ADR-0046 once that ADR is merged.

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

## EPIC 14 — Master Subscriptions

**Problem.** TezUsta has no revenue. ADR-0046 makes master subscriptions the
only source of it, and nothing in the system yet knows whether a master has paid.

**Goal.** A master holds the one subscription, bought monthly or yearly, with a
trial and a grace window. An active subscription is a condition for receiving work, checked
in dispatch and again on accept. The master pays for it outside the app, through
a local provider, and the app shows where it stands.

**Scope** ([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md)):

- removing the commission-debt machinery (#321)
- `subscription_settings`, versioned `subscription_prices`,
  `master_subscriptions` and an append-only `subscription_events`; calendar
  period arithmetic in `Asia/Baku`; the entitlement predicate; and the dispatch
  and accept gate in the seam the debt brake leaves (#322)
- subscription billing behind a provider port with a stub — hosted checkout,
  signed idempotent webhook, a TezUsta-scheduled charge on a saved token, and
  reconciliation (#323)
- admin editing of the subscription — monthly and yearly prices, trial, grace
  and purchases open — plus a master's subscription and audited grants (#324)
- the master's status surface and warnings in the app, with **no purchase flow,
  link or price in it** (#325)
- status pushes before expiry, on grace, on expiry and on renewal, with no link
  or call to action (#326)
- a web purchase surface outside the app, with its own master sign-in, which
  still needs an issue

**Out of scope.** Commission of any kind, `commission_rules`, `master_wallets`
and payouts — ADR-0046 rules them out. Order payments, which the platform never
takes. Selling the subscription inside the app, through a local provider or
through Apple or Google — ADR-0046 § 7 sells it outside the app, and IAP is only
the iOS fallback if Apple rejects the build.

**Technical considerations.** There is one subscription and no plan catalogue.
Its prices, trial and grace are admin-edited data, not code. A price is
versioned, never edited in place, and a period keeps the price it was paid at.
A renewal at a new price needs 30 days' notice. Money is
integer minor units. Every subscription transition is a conditional update plus
an event row in one transaction. The entitlement is read by the server at the
moment it matters, never from a token claim. The gate is on the dispatch hot
path, so the `EXPLAIN` tests from #297 must stay green with the new join. An
expired master finishes a job already accepted, because expiry cancels nothing.
The app may show status and nothing that leads to a purchase (Apple 3.1.1(a),
Google Play Payments). ADR-0007's billing constraints apply in full.

**Dependencies.** EPIC 5 (a trial starts at verification approval) and EPIC 8
(an accepted job runs to its end). Building is unblocked by ADR-0046. Going live
needs the owner's launch monthly and yearly prices, trial and grace, and a
billing provider.
The web purchase page also needs a real master sign-in, so it shares EPIC 2's
SMS-provider blocker.

**Acceptance criteria.** An expired master is not offered work and cannot accept
or go available, and is told why. A master in trial, active or in grace receives
work exactly as before. A verified webhook extends a period once, however many
times it is delivered. A bad signature changes nothing. A client cannot
influence the amount charged. Changing a price does not alter a period already
paid. No card data is stored or logged. The app contains no purchase
button, link or price. Every admin grant is audited with a reason.

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
