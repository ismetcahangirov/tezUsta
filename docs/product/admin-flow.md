# Admin flow

> Behaviour only. **No visual design is specified here** (CLAUDE.md §17).
> Scheduled for EPIC 13 — this document exists so the data model and audit
> requirements are not designed into a corner beforehand.

## Why admin is web, not mobile

Admin work is document review, tabular comparison, and dispute reading — tasks
that need a large screen and a keyboard. Embedding it in the mobile app would
bloat a consumer binary with staff-only code and put privileged operations one
compromised phone away from the platform.

**Admin is a separate web application** (`apps/admin`) with its own
authentication and its own session policy.

## Responsibilities

### 1. Master verification

The gate on supply quality.

- Review submitted evidence
- Approve, reject with a reason, or request more
- Suspend or reinstate
- Maintain the audit trail

Criteria are **OPEN** — see [`user-roles.md`](user-roles.md).

### 2. Service catalogue

Categories, services, pricing shape (fixed vs inspection), activation.

The catalogue is data, not code. Adding a service must never require an app
release — which is why the mobile app renders whatever the backend returns.

### 3. Order oversight

- View any order and its full status history
- Intervene on a stuck order (a master who accepted and vanished)
- Force a status transition, **always recorded with actor and reason**

An admin override is still a state-machine transition. It is logged, attributed,
and reversible in the record — never a silent database edit.

### 4. Disputes

- Read the order, its history, photos, and both parties' accounts
- Decide an outcome
- Trigger a refund or an adjustment (**OPEN** until [ADR-0007](../decisions/ADR-0007-payments.md))

### 5. Moderation

- Remove abusive reviews (with a recorded reason)
- Act on reports about either party

### 6. Operational visibility

Enough to answer "is the marketplace working?" — orders created vs filled,
unfilled orders by area and category, master availability by area, cancellation
rates.

**Not** a business-intelligence platform. Enough to spot a supply gap.

## Non-negotiable requirements

These constrain the schema and must hold from the first admin endpoint:

1. **Every admin action is audit-logged**: actor, action, target, timestamp,
   reason, before/after where applicable. Admins act on other people's money,
   livelihood, and home addresses. An unlogged admin action is indistinguishable
   from an attacker's.
2. **Admin authentication is separate and stronger** than customer/master
   authentication. Shorter sessions; MFA expected (**OPEN** — confirm with the
   owner).
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

| #   | Question                                                                    | Blocks             |
| --- | --------------------------------------------------------------------------- | ------------------ |
| 1   | What permission levels exist (support / moderator / finance / super-admin)? | EPIC 13 schema     |
| 2   | Is MFA required for admin sign-in?                                          | EPIC 2             |
| 3   | Who creates admin accounts, and how?                                        | EPIC 13            |
| 4   | What are the master verification criteria?                                  | EPIC 5             |
| 5   | What is the dispute resolution policy?                                      | EPIC 13            |
| 6   | What are the data retention periods for PII and location history?           | Legal input needed |
