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
  - `REFUNDED` — closed and a refund was issued
- A refund on a **cash** order is a commission adjustment against the master's
  balance, not a card refund. The status is the same; the mechanism differs

Disputes are how a customer challenges a completed job, because the master's
completion is final and the customer does not confirm it. The dispute window is
configuration, not a literal.

The **mechanism** of a refund is **OPEN** until the payment provider and the
fund-holding question are answered
([ADR-0007](../decisions/ADR-0007-payments.md)); the two outcomes above are not.

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

## Open questions

Whether a second factor is required is **not** one of them — it is mandatory
(ADR-0014). What is open is only which TOTP library or identity provider supplies
it.

| #   | Question                                                                      | Blocks             |
| --- | ----------------------------------------------------------------------------- | ------------------ |
| 1   | What permission levels exist (support / moderator / finance / super-admin)?   | EPIC 13 schema     |
| 2   | Which TOTP library or identity provider supplies the mandatory second factor? | EPIC 13            |
| 3   | Who provisions admin accounts, and through what process?                      | EPIC 13            |
| 4   | What are the master verification criteria?                                    | EPIC 5             |
| 5   | What is the dispute resolution policy?                                        | EPIC 13            |
| 6   | What are the data retention periods for PII and location history?             | Legal input needed |
