# User roles and permissions

## The three roles

| Role         | Who                                                            | Where           |
| ------------ | -------------------------------------------------------------- | --------------- |
| **Customer** | Someone with a household problem                               | Mobile app      |
| **Master**   | A verified professional who performs the work                  | Mobile app      |
| **Admin**    | Platform staff — verification, moderation, disputes, catalogue | Web admin panel |

## One account, multiple roles

A person may be **both** a customer and a master. A plumber has a broken fridge.

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

| Capability                        |          Customer          |            Master            |       Admin        |
| --------------------------------- | :------------------------: | :--------------------------: | :----------------: |
| Create an order                   |             ✅             |              —               |         —          |
| View own orders                   |             ✅             |        ✅ (assigned)         |      ✅ (all)      |
| Cancel an order                   |  ✅ (own, rules pending)   | ✅ (assigned, rules pending) |         ✅         |
| See nearby open orders            |             —              |    ✅ (verified + online)    |         ✅         |
| Accept an order                   |             —              |        ✅ (verified)         |         —          |
| Advance order status              |             —              |      ✅ (assigned only)      |   ✅ (override)    |
| See master live location          | ✅ (own active order only) |              —               | ✅ (active orders) |
| Review a master                   |   ✅ (after completion)    |              —               |         —          |
| Review a customer                 |             —              |    ✅ (after completion)     |         —          |
| Manage own service list & pricing |             —              |    ✅ (within catalogue)     |         ✅         |
| Verify / suspend a master         |             —              |              —               |         ✅         |
| Edit the service catalogue        |             —              |              —               |         ✅         |
| Resolve a dispute                 |             —              |              —               |         ✅         |
| Issue a refund                    |             —              |              —               |         ✅         |

### Non-negotiable authorization rules

1. **Ownership is checked, not assumed.** `GET /orders/:id` must verify the
   caller is the order's customer, its assigned master, or an admin. An
   authenticated user is not thereby entitled to an arbitrary order id.
2. **Only a verified master may accept work.** Checked server-side at accept
   time, against current verification status — not against a token claim issued
   before suspension.
3. **Only the assigned master may advance an order's status.** Any other master
   is rejected even with a valid token.
4. **Location visibility is scoped and time-bounded.** A master's live position
   is visible only to the customer on the active order, and only while that
   order is active. It is not historical, not public, and not visible after
   completion.
5. **Reviews require a completed order** between exactly those two parties.
6. **Admin actions are audit-logged** — actor, target, action, timestamp, reason.

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

| State                  | Meaning                                                          |
| ---------------------- | ---------------------------------------------------------------- |
| `pending_verification` | Master registered, evidence not yet reviewed                     |
| `active`               | Normal                                                           |
| `suspended`            | Blocked by an admin; cannot accept or create work                |
| `deleted`              | Soft-deleted; retained for order history and legal/audit reasons |

Users are **soft-deleted**. A hard delete would orphan completed orders,
payments, and reviews that must remain accountable. Retention and
right-to-erasure handling is a legal question — flagged, not decided.
