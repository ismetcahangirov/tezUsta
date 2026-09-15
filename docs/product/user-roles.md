# User roles and permissions

## The three roles

| Role         | Who                                                            | Where                                               |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------- |
| **Customer** | Someone with a household problem                               | Mobile app                                          |
| **Master**   | A verified professional who performs the work                  | Mobile app                                          |
| **Admin**    | Platform staff — verification, moderation, disputes, catalogue | Web admin panel (`apps/admin`, planned for EPIC 13) |

## One account, multiple roles

A person may be **both** a customer and a master. A plumber has a broken fridge.

This is about the two consumer roles only. **An admin is not a role on a `users`
row** — admin accounts live in a separate `admin_users` table with their own
credential path, and an admin who is also a customer holds two unlinked accounts
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)).

Therefore:

- `users` holds identity and credentials — one row per person.
- `customers` and `masters` are **role profiles** referencing `users`.
- Roles are a **set**, not a single field. A user may hold both.
- The app switches between customer mode and master mode; it does not require a
  second account.

Modelling role as one column on `users` would force duplicate accounts and split
one person's reviews, history, and phone number across two identities. It is
also very hard to unwind later.

## Why both roles ship in one app

Customer and master are one binary, with the experience switched by role.

Two apps would double build, release, review, and support cost, and would force
a dual-role user to install twice. The route tree is segregated by role group and
guarded at the router level — **and the server never trusts that guard.**

## Permission model

Authorization is enforced **server-side on every request**. A role claim in an
access token is a cache, not an authority; it is re-checked against the database
for every authorization decision.

**A frontend role check is a UX affordance, never a security control.**
(CLAUDE.md §11.)

### Capability matrix

| Capability                        |          Customer          |                                         Master                                          |                    Admin                    |
| --------------------------------- | :------------------------: | :-------------------------------------------------------------------------------------: | :-----------------------------------------: |
| Create an order                   |             ✅             |                                            —                                            |                      —                      |
| View own orders                   |             ✅             |                                      ✅ (assigned)                                      |                  ✅ (all)                   |
| Cancel an order                   |  ✅ (own, rules pending)   |                              ✅ (assigned, rules pending)                               |                     ✅                      |
| See nearby open orders            |             —              |                                 ✅ (verified + online)                                  |                     ✅                      |
| Accept an order                   |             —              | ✅ (verified + online + offers the service + in radius + commission debt under the cap) |                      —                      |
| Advance order status              |             —              |                                   ✅ (assigned only)                                    |                ✅ (override)                |
| See master live location          | ✅ (own active order only) |                                            —                                            | — (post-hoc location history only, audited) |
| Review a master                   |   ✅ (after `COMPLETED`)   |                                            —                                            |                      —                      |
| Review a customer                 |             —              |                                 ✅ (after `COMPLETED`)                                  |                      —                      |
| Manage own service list & pricing |             —              |                                  ✅ (within catalogue)                                  |      — (catalogue and activation only)      |
| Verify / suspend a master         |             —              |                                            —                                            |                     ✅                      |
| Edit the service catalogue        |             —              |                                            —                                            |                     ✅                      |
| Resolve a dispute                 |             —              |                                            —                                            |                     ✅                      |
| Issue a refund                    |             —              |                                            —                                            |                     ✅                      |

Two cells need reading carefully. **Admin override** is a bypass of the _actor_
check only: an admin may make a transition the state machine allows without being
the customer or the assigned master, and may not make one the machine does not
contain ([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)). **Resolve
a dispute** and **issue a refund** are that ADR's two terminal outcomes,
`RESOLVED` and `REFUNDED` — a dispute is always closed as one of them, never left
open.

### Non-negotiable authorization rules

1. **Ownership is checked, not assumed.** `GET /orders/:id` must verify the
   caller is the order's customer, its assigned master, or an admin. An
   authenticated user is not thereby entitled to an arbitrary order id.
2. **Accepting work has five preconditions, all checked server-side at accept
   time** — against current state, not against a token claim issued before a
   suspension. The master must be **verified**, **online**, **offer the
   service**, be **inside the current search radius**, and carry a
   `commission_debt_minor` at or below `MAX_COMMISSION_DEBT_MINOR`. The debt
   condition is what makes cash orders survivable: on a cash order the master
   collects the whole amount and owes the platform its commission, so an
   uncollected debt has to stop new work rather than accumulate. The column
   reads zero until EPIC 12 populates it, so the predicate can ship complete
   from EPIC 7.
3. **Only the assigned master may advance an order's status.** Any other master
   is rejected even with a valid token.
4. **Location visibility is scoped and time-bounded.** A master's live position
   is visible only to the customer on the active order, and only while that
   order is active. It is not historical, not public, and not visible after
   completion. **An admin never sees a live position.** An admin investigating
   an order reads the recorded location history after the fact, and that read is
   itself audited — a live fleet view of every master is surveillance, not
   moderation.
5. **Reviews require a completed order** between exactly those two parties, and
   they run **both ways**: the customer reviews the master and the master
   reviews the customer. Neither side sees the other's review until both have
   been submitted or the review window closes, so a review cannot be written in
   retaliation for the one already visible.
6. **Admin actions are audit-logged** — actor, target, action, timestamp, reason.
7. **An admin does not set a master's price.** The admin owns the catalogue —
   categories, services, pricing _shape_ (fixed vs inspection), activation. The
   amount on a `master_services` row belongs to the master
   ([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)).

## Master verification — OPEN

Verification gates who may accept work, so it must exist before dispatch does.

**Not yet specified** (blocks EPIC 5) — these are product decisions:

- What evidence is required? (ID document, trade certification, references)
- Who reviews it, and against what standard?
- Is verification per category, or one blanket status?
- What is the appeal path for a rejection?
- What automatically suspends a master (rating floor, cancellation rate, complaints)?

The schema will carry a verification **status** and an audit trail regardless of
how the policy lands, so the data model is not blocked by the policy.

## Account states

| State                  | Meaning                                                                     |
| ---------------------- | --------------------------------------------------------------------------- |
| `pending_verification` | Master registered, evidence not yet reviewed                                |
| `changes_requested`    | Reviewed; specific evidence is missing or unusable. The master may resubmit |
| `rejected`             | Reviewed and refused. Not a resubmission state; appeal is the path out      |
| `active`               | Normal                                                                      |
| `suspended`            | Blocked by an admin; cannot accept or create work                           |
| `deleted`              | Soft-deleted; retained for order history and legal/audit reasons            |

`changes_requested` and `rejected` are separate states because they mean
different things to the master and demand different screens: one says _send us a
clearer photo of your ID_, the other says _this application is closed_. A single
"not approved" state would leave the app unable to tell a master which of the
two happened.

Users are **soft-deleted**. A hard delete would orphan completed orders,
payments, and reviews that must remain accountable. Retention and
right-to-erasure handling is a legal question — flagged, not decided.
