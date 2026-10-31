# ADR-0050 — Customer accounts in the admin panel

- **Status:** Accepted
- **Amended by:** [ADR-0072](ADR-0072-email-one-time-code-sign-in.md) — § 5
  searches by a whole email address instead of a whole E.164 number, and the
  reveal is of the email address. The rest stands.
- **Date:** 13 October 2026
- **Decided by:** Issue #328 (the owner's specification). § 3 and § 4 depart
  from the issue's wording, for the reasons given there. Both are flagged in
  PR for the owner's acceptance.
- **Context:** issue #328; EPIC 20 (#327)
- **Amends:** [ADR-0043](ADR-0043-admin-panel-policy.md) § 1 (the role table).
  ADR-0043 is otherwise unchanged.

## Context

The panel had masters, orders and reviews, but no customers. An abusive
customer could be stopped only through the database. `users.status` already
had `suspended`, and both the request guard (`ActorService`) and the refresh
endpoint already refuse a suspended account. Nothing in the panel set it.

## Decision

### 1. Two permissions

| Permission          | support | moderator | finance | super_admin |
| ------------------- | :-----: | :-------: | :-----: | :---------: |
| `customers.read`    |    ✓    |     ✓     |    ✓    |      ✓      |
| `customers.suspend` |         |     ✓     |         |      ✓      |

`customers.suspend` goes to the same people who suspend a master. A phone
number stays behind `pii.read` and a reason, as on an order (ADR-0043 § 6), so
a moderator can suspend a customer without being able to read their number.

### 2. A suspension belongs to the account

The status is `users.status`. There is no `customers.status`: one account has
one status. Suspending a customer who also holds a master profile therefore
stops both, and the panel says so before the admin confirms. This differs from
a master suspension, which is `masters.verification_status` and leaves the
customer role alone.

A suspension writes three things **in one transaction**:

- the status, by a conditional update from `active`;
- the revocation of every session;
- the audit row, with before and after.

A second suspension answers 409 and writes nothing. A reinstatement moves
`suspended` back to `active`, also with a reason and an audit row in one
transaction.

### 3. Searching orders are cancelled by the suspending admin

After the transaction commits, each order still `SEARCHING` is moved to
`CANCELLED` through the order state machine with the reason
`customer_suspended`. An order a master already holds is not touched. The
response lists those orders so that support can follow them up. A reinstatement
does not restore anything that was cancelled.

Each cancel is conditional on the order **still** being `SEARCHING`. An order
a master accepts in the moment between the commit and the cancel is held, and
is listed with the others for follow-up rather than cancelled.

**Two gaps, accepted for now.** The cancels run after the commit, one by one. If
the process dies between the commit and the last cancel, or a cancel fails, an
order can be left searching for a suspended account. A second suspension
answers 409, so it does not redo them. A held order that its master sends back
out (`ACCEPTED → SEARCHING`) after the suspension is also searching again, and
nothing cancels it. In both cases the order is findable: the audit row names
every order that was searching or held at the suspension. Support cancels it
with an override. Closing both properly means dispatch refusing to offer an
order whose account is not active; that is dispatch's change, not this one.

**The actor is the admin, not `system`.** The issue asked for `system`. But the
transition table gives `SEARCHING → CANCELLED` to the customer alone, and
adding `system` to it is an edge change, which needs an ADR superseding
ADR-0015 (`order-lifecycle.ts`). The admin door (ADR-0043 § 5) already permits
the edge. It is also the truer record: a person decided this, and the order's
trail names them.

### 4. Saved addresses show their label only

The issue asked for addresses as "district-level text only". **No district is
stored.** An address row holds the formatted text, the flat details and the
position. Cutting a district out of the formatted text would be a guess, and a
wrong guess shows the street. So the customer's file lists each saved address
by the customer's own label ("Ev", "İş") and whether it is the default. No text
and no coordinates are shown. An order's address remains readable on that
order, where reading it is audited.

### 5. Search finds a name prefix, an id, or a whole number

`q` is read as:

1. a customer id, if it is one;
2. a phone number, only if it is a whole Azerbaijani number in E.164;
3. otherwise, a case-insensitive prefix of the display name.

Part of a number is therefore read as a name, and finds nobody. A partial
match would let an admin walk the number space. A whole-number search that
finds someone is audited (`customer.phone.search`) against the customer found:
it ties a number to a person, whether or not the admin holds `pii.read`.

The prefix is served by `customers_display_name_prefix_idx`, an index on
`lower(display_name) text_pattern_ops`. The `text_pattern_ops` operator class
is needed because the database collation is `en_US.utf8`, not `C`. A trigram
index was not chosen: `pg_trgm` is available but not installed, and a prefix is
all the search offers. The database lowers both the column and the query
(`İ`).

### 6. The race with a new order is closed by a lock

A customer's order creation already serialises on an advisory lock per
customer. It now re-reads the account's status under that lock, so a request
authorized before a suspension writes nothing after it. It answers 401, the
same as the request guard gives the suspended account's next request. The suspension takes
the same lock before it reads which orders to cancel. Whichever transaction
gets the lock first, the other one sees its result.

## Consequences

- Every read of a customer's file is audited (`customer.read`). So is every
  phone reveal (`customer.phone.read`). The list is not audited, because it
  carries only names and masked numbers.
- A suspended account's file shows when and why it was suspended, from the
  latest `customer.suspend` audit row. Who did it is in the audit log.
- A suspended account that also holds a master profile stops receiving work as
  soon as its presence expires. Its requests are refused at once.

## Revisit when

- Addresses store a district or locality, for example from the reverse geocode
  at save time. The file can then show it (§ 4).
- A `system` cancellation edge is wanted for other reasons. A superseding ADR
  for ADR-0015 could then move § 3 to it.
