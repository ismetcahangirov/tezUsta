# Admin flow

> Behaviour only. **No visual design is specified here** (CLAUDE.md §17).
> Scheduled for EPIC 13 — this document exists so the data model and audit
> requirements are not designed into a corner beforehand.

## Why admin is web, not mobile

Admin work is document review, tabular comparison, and dispute reading — tasks
that need a large screen and a keyboard. Embedding it in the mobile app would
bloat a consumer binary with staff-only code and put privileged operations one
compromised phone away from the platform.

**Admin is a separate web application** with its own authentication and its own
session policy. That application — `apps/admin` — **does not exist yet**; it is
planned for EPIC 13, and nothing in this document should be read as describing
code that is on disk today.

The credential path is settled
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)): **email + password +
a mandatory TOTP second factor**, against a distinct `admin_users` table with no
overlap with `users`. Sessions refresh for 8 hours, idle out after 30 minutes,
and live in an httpOnly cookie rather than a bearer token, because the admin
panel is a browser application and a cookie closes the XSS token-theft path. An
admin credential cannot sign in to the mobile app and a phone OTP cannot sign in
here.

The split across Epics matters: **the `admin` role and its guard ship in EPIC
2**, with the rest of authorization, so that admin endpoints written in EPIC 3, 5
and 8 are guarded and testable. **Credentials and `apps/admin` ship in EPIC 13.**
Until then admin endpoints exist and are tested against a fixture admin, and no
production admin credential is issued.

## Responsibilities

### 1. Master verification

The gate on supply quality.

- Review submitted evidence
- Move the master to `active`, `changes_requested`, or `rejected` — each with a
  recorded reason
- Suspend or reinstate
- Maintain the audit trail

The three review outcomes are the account states in
[`user-roles.md`](user-roles.md), not free-text verdicts. "Request more" is
`changes_requested` and must name **what** is missing, because that text is the
whole of what the master's app can show them. "Reject" is `rejected` and is not a
resubmission invitation — conflating the two produces a master who resubmits the
same documents forever.

Criteria are **OPEN** — see [`user-roles.md`](user-roles.md).

### 2. Service catalogue

Categories, services, pricing shape (fixed vs inspection), activation.

**Not the amounts.** An admin never sets or edits a master's price or surcharge;
those belong to the master
([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)). The catalogue
price is a reference figure, and the shape is what tells the app whether to show
a price or "price after inspection".

The catalogue is data, not code. Adding a service must never require an app
release — which is why the mobile app renders whatever the backend returns.

### 3. Order oversight

- View any order and its full status history
- Intervene on a stuck order (a master who accepted and vanished) — typically by
  returning it to `SEARCHING` so it is offered again, which clears the assigned
  master and the frozen price
- Perform a transition the customer or master would normally perform, **always
  recorded with actor and mandatory reason**

**An override bypasses the actor check, never the edge table**
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)). An admin may make
a transition the state machine permits even though they are neither the customer
nor the assigned master. An admin may **not** make a transition the table does
not contain — there is no "force any status" power, and if an admin needs an edge
that does not exist, the answer is a new ADR, not a special case in a service.

**Three edges are in the table and still closed to admins:** `PAYMENT_PENDING`,
`PAID` and `REFUNDED`. Each would record money moving through the platform, and
the platform never holds order money
([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md) § 4). The
server refuses them (`ORDER_PAYMENT_NOT_TRACKED`, `REFUND_NOT_AVAILABLE`), and
the override dialog shows them disabled with the reason rather than hiding them.

Every override writes `order_status_history` with actor, reason and timestamp.
The reason is mandatory: it is what the audit trail is made of. An override is
logged, attributed, and reversible in the record — never a silent database edit.

**An admin never watches a master's live position.** Investigating an order means
reading recorded location history after the fact, and that read is itself audited
([`user-roles.md`](user-roles.md)).

### 4. Disputes

- Read the order, its history, photos, and both parties' accounts
- Close the dispute one of exactly two ways, each terminal and each requiring an
  admin actor and a mandatory reason
  ([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)):
  - `RESOLVED` — closed with no money movement
  - `REFUNDED` — closed and a refund was issued. **Withheld indefinitely**:
    the platform never holds order money, so it never has a refund to issue
    ([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md) § 4). The server refuses it
    with `REFUND_NOT_AVAILABLE`
- When the resolver decides the master should return money, that is between the
  two parties; the decision goes in the mandatory reason and the order closes
  `RESOLVED`

Disputes are how a customer challenges a completed job, because the master's
completion is final and the customer does not confirm it. The dispute window is
configuration, not a literal.

The fund-holding question is answered — TezUsta holds no customer funds
([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md)) — so there is no order-refund
mechanism to design.

### 5. Moderation

- Remove abusive reviews (with a recorded reason)
- Act on reports about either party

### 6. Operational visibility

Enough to answer "is the marketplace working?" — orders created vs filled,
unfilled orders by area and category, master availability by area, cancellation
rates.

**`NO_MASTER_FOUND` is counted as an unfilled order, never as a cancellation.**
An unfilled order is a supply signal; a cancellation is a quality signal about a
person. Mixing them makes both numbers useless and quietly penalises masters for
orders nobody was offered.

**Not** a business-intelligence platform. Enough to spot a supply gap.

The dashboard also counts masters' subscriptions as they stand now: in trial,
active monthly, active yearly, on granted days, in grace, and expired in the
last seven days (#324).

### 7. The subscription

There is one subscription, bought monthly or yearly
([ADR-0046](../decisions/ADR-0046-subscription-only-monetisation.md) § 5). It is
admin data, edited on the **Subscription** page (#324). Every role can read it.
`subscriptions.manage` — finance and super_admin — can change it, and every
change carries a reason and is audited in the same transaction.

- **Prices are versions, never edits.** A change enters a new version for a
  date. The history keeps every version, including withdrawn ones.
- **Notice** ([ADR-0047](../decisions/ADR-0047-subscription-administration.md)). Once anyone has paid for a period, a new price for it takes
  effect no sooner than 30 days out. Before the first payment a price can
  apply at once, so launch prices can be set and corrected freely.
- **One scheduled change per period.** A scheduled price can be withdrawn
  before it takes effect. The withdrawal is its own row.
- **The typo guard.** A price that at least doubles or halves, or a first price
  above 1 000 AZN, asks for an explicit confirmation.
- **Trial, grace and opening sales.** A trial change applies to trials started
  from then on, and a grace change to lapses from then on. Purchases cannot
  open until both periods have a price in effect.
- **One master's subscription** is on their file: the status, the period, the
  history with what each period was paid at, and — for a manager — granting
  days and cancelling. Days are granted once verification has approved the
  master, or to a suspended one in compensation. Until a billing provider is live, a grant is how a
  master who paid offline gets a period. Grants and cancellations are audited
  against the master.

### 8. Customer accounts

The **Customers** page (#328,
[ADR-0050](../decisions/ADR-0050-admin-customer-accounts.md)) finds a customer
by a name prefix, by their id, or by a **whole** phone number. Part of a number
finds nobody. Every role can read it. `customers.suspend` (moderator and
super_admin) can suspend and reinstate.

- **The file** shows the profile, the order counts, the saved addresses and the
  order history. Addresses are listed by their label only, because no district
  is stored. Opening the file is audited. The phone number is masked; revealing
  it needs `pii.read` and a reason, and is audited.
- **A suspension belongs to the account.** It signs the person out everywhere,
  refuses their next request, and cancels their orders still searching for a
  master. Orders a master already holds are not touched. They are listed for
  support to follow up. If the account also holds a master profile, the panel
  says so before confirming, because that stops too.
- **Reinstating** restores sign-in. Orders the suspension cancelled stay
  cancelled. Both actions take a reason and are audited in the same
  transaction as the change.

## Non-negotiable requirements

These constrain the schema and must hold from the first admin endpoint:

1. **Every admin action is audit-logged**: actor, action, target, timestamp,
   reason, before/after where applicable. Admins act on other people's money,
   livelihood, and home addresses. An unlogged admin action is indistinguishable
   from an attacker's.
2. **Admin authentication is separate and stronger** than customer/master
   authentication: a distinct account store, an 8-hour refresh, a 30-minute idle
   timeout, and a **mandatory** TOTP second factor
   ([ADR-0014](../decisions/ADR-0014-admin-authentication.md)). An admin account
   can suspend a master, resolve a dispute, and read personal data across the
   whole platform; binding that to an SMS OTP would make a SIM swap a
   platform-wide compromise.
3. **Least privilege.** Not every staff member needs refunds or PII access.
   Granularity is **OPEN**, but the schema must not assume a single `is_admin`
   boolean — that assumption is expensive to unwind.
4. **PII access is logged and minimised.** Viewing a customer's address or phone
   number is an event worth recording.
5. **No destructive deletes.** Admin actions soft-delete or supersede. Order
   history, payments, and reviews stay accountable.
6. **Admin endpoints are a separate, separately-guarded surface** — never a
   role flag on a customer-facing endpoint.

## Settled by ADR-0043

[ADR-0043](../decisions/ADR-0043-admin-panel-policy.md) answers the questions
this section used to list:

- **Permission levels:** four roles — `support`, `moderator`, `finance`,
  `super_admin` — held many-to-many, each a fixed bundle of permissions; every
  admin handler declares the permission it needs and an undeclared one is
  refused.
- **Second factor:** TOTP per RFC 6238 on `node:crypto`, the secret encrypted at
  rest, a used step never accepted twice; passwords are scrypt. No recovery
  codes — a `super_admin` resets a lost authenticator.
- **Provisioning:** the first `super_admin` by a server command; everyone else
  by a `super_admin`'s invitation, a single-use setup link valid 24 hours that
  ends only when TOTP is enrolled.
- **Disputes:** a queue ordered by age; `RESOLVED` needs `disputes.resolve` and
  a reason; `REFUNDED` is refused by the server until EPIC 12 ships a refund
  mechanism, because recording a refund that did not happen falsifies the trail.
- **"Area"** on the dashboard is a 0.02° grid cell until a districts dataset
  exists.

Master verification criteria were settled earlier by
[ADR-0023](../decisions/ADR-0023-master-verification-policy.md).

## Open questions

| #   | Question                                                          | Blocks             |
| --- | ----------------------------------------------------------------- | ------------------ |
| 1   | What are the data retention periods for PII and location history? | Legal input needed |
| 2   | How does a customer or master report the other party?             | A mobile design    |
