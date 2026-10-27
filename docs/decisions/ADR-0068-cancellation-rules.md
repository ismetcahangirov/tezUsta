# ADR-0068 — Cancellation rules: free windows, a one-minute hand-back, and no automatic penalties

- **Status:** **Accepted**
- **Date:** 2026-10-27
- **Decided by:** Project owner, on 27 October 2026, answering [#459]. The
  owner accepted the recommendations on questions 1–3 and 5–7, and replaced
  question 4 with a rule of their own: "qaydalar yaxisdi yerindedi birde orda
  usta ozu de legv eleye bilmelidi usta 1 deq erzinde leg eleye bilsin 1
  deqiqeni kecse legv eleye bilmesin" — the rules are good; a master must be
  able to cancel too, within 1 minute; after 1 minute they cannot.
- **Context:** EPIC 8 (#9), issue [#459]
- **Settles:** "Cancellation rules and penalties", the last open EPIC 8
  decision in CLAUDE.md § 1, and the matching **OPEN** in
  `docs/product/customer-flow.md` and `docs/product/master-flow.md`.
- **Amends:**
  - [ADR-0015](ADR-0015-order-lifecycle-states.md). The assigned master's
    re-dispatch edges gain a time guard. No status or edge is added or removed.
  - [ADR-0055](ADR-0055-search-radar-and-arrival-promise.md) § 11 and "What
    this does not decide". Lateness has no penalty, and lets the customer
    cancel free.
  - [ADR-0060](ADR-0060-inspection-price-approval.md) § 4. A price decline
    stays penalty-free. The trade-off "an unresponsive customer stalls the job"
    now ends with an admin, not with a re-dispatch.

[#459]: https://github.com/ismetcahangirov/tezUsta/issues/459

## Context

[ADR-0015](ADR-0015-order-lifecycle-states.md) settled which cancellations
exist. It left their cost to the owner.

- **The customer** may cancel from every status up to and including
  `IN_PROGRESS`, with a reason.
- **The assigned master** cannot cancel an order. They hand it back: from
  `ACCEPTED`, `MASTER_ON_THE_WAY` or `MASTER_ARRIVED` the order returns to
  `SEARCHING`. The master is excluded from the next broadcast, and
  `MAX_ORDER_REDISPATCHES` caps how often this happens to one order.

None of these cost anybody anything today.

Three settled facts bound any rule:

- **The platform holds no order money**
  ([ADR-0046](ADR-0046-subscription-only-monetisation.md) § 4). It cannot
  charge a cancellation fee, keep a deposit or pay compensation.
- **Automatic suspension is deferred for lack of data**
  ([ADR-0023](ADR-0023-master-verification-policy.md)). Admins suspend masters
  and customers by hand, with a reason
  ([ADR-0050](ADR-0050-admin-customer-accounts.md)).
- **Dispatch has no ranking**
  ([ADR-0009](ADR-0009-dispatch-model.md)). A penalty cannot be "fewer offers"
  without building a score.

## Decision

### 1. A customer's cancellation is free early, and in two special cases

A customer's cancellation is **free** in four situations:

- while the order is `SEARCHING`;
- in `ACCEPTED`, within **2 minutes** of `accepted_at`. The customer has just
  seen the accepting master's price (ADR-0013) and may decide against it;
- whatever the status, once the arrival promise
  ([ADR-0055](ADR-0055-search-radar-and-arrival-promise.md)) has passed by
  more than **10 minutes**. The master is late;
- as a declined inspection quote
  ([ADR-0060](ADR-0060-inspection-price-approval.md) § 4).

Any other customer cancellation is a **late cancellation**.

The customer can still cancel in every status ADR-0015 allows. "Late"
classifies the cancellation and refuses nothing.

### 2. There is no cancellation fee

Not from the platform, which holds no money (ADR-0046). The app does not
record a fee arranged between the parties either.

### 3. A late cancellation is counted, and only an admin sees the count

The customer's admin file
([ADR-0050](ADR-0050-admin-customer-accounts.md)) shows how many late
cancellations they have made. Nothing happens automatically. An admin who
sees abuse suspends the account by hand, with a reason, as today.

### 4. The assigned master may hand an order back only within 1 minute of accepting it

- The assigned master may send the order back to `SEARCHING` **only within
  1 minute of `accepted_at`**, from whichever of `ACCEPTED`,
  `MASTER_ON_THE_WAY` or `MASTER_ARRIVED` the order is in.
- **After that minute, the master's hand-back is refused.** The edges stay in
  the table, because an admin still drives them.
- Re-dispatch semantics are unchanged (ADR-0015 § Re-dispatch). The order goes
  back out to other masters rather than ending, `MAX_ORDER_REDISPATCHES` still
  applies, and the next master's minute starts from their own accept.
- A hand-back within the minute costs the master nothing. It is counted on the
  master's admin file, like the customer's late cancellations, so a master who
  keeps accepting and releasing is visible to an admin.
- **A master who cannot come after the minute contacts support.** An admin
  returns the order to `SEARCHING` (ADR-0015, "an admin acting on a stuck
  order"), with the reason recorded.

### 5. A master cannot abandon work in progress

There is still no master edge out of `IN_PROGRESS`, as ADR-0015 has it. A
master who cannot finish contacts support. An admin overrides the order to
`CANCELLED` with a reason, and the customer may report the master
([ADR-0053](ADR-0053-party-reports.md)).

### 6. Lateness is information

Lateness has no automatic consequence. The admin already sees promised versus
actual arrival on the order (ADR-0055 § 11). The master's admin file adds how
many of their arrivals were late. The customer's remedy for a late master is
the free cancellation in § 1.

### 7. Neither party sees the other's record

All the counts in §§ 3, 4 and 6 are admin-only. A master offered an order does
not see the customer's late cancellations, and a customer does not see a
master's hand-backs.

### 8. The values are configuration

The three durations are configuration, not literals, as
`MAX_ORDER_REDISPATCHES` is:

- the customer's grace, 2 minutes;
- the master's hand-back window, 1 minute;
- the lateness threshold, 10 minutes.

## Why

**Most cancellations are early and blameless.** A customer who changes their
mind while the search runs, or on seeing the price, has cost nobody anything.
The rule marks only the cancellations that waste a master's journey.

**A master's acceptance is a promise.** The owner's one-minute rule makes
accept final once the master has had a moment to notice a mis-tap. Without it,
a customer can watch a master on the way and then lose them, along with their
place in the queue and possibly their price. The cap per order limits how
often that can happen. Only the window limits when.

**No automatic penalty before there is data.** Thresholds chosen before launch
are guesses. Counting from day one gives the data, and the admin acts in the
meantime, as ADR-0023 already does for masters.

**Counting is cheap; showing is not.** Showing one party the other's record
would label people on a single early event. Counts that only admins see do
not.

## Alternatives considered

| Option                                                        | Why not                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A cancellation fee charged by the platform                    | The platform holds no money (ADR-0046). It would need payment rails and the custody it was designed to avoid.                                                             |
| A call-out fee the master asks for, recorded in the app       | It cannot be enforced, so it becomes an argument at the door and a support case. It can be revisited with data.                                                           |
| Counting a master's later hand-backs instead of refusing them | It was the recommendation on #459, question 4. The owner chose a hard window: a promise that cannot be taken back after a minute, rather than one that is merely counted. |
| A master edge `IN_PROGRESS` → `CANCELLED`                     | Abandoning work is rare and serious, and an admin should see each case. It would also supersede ADR-0015 for little gain.                                                 |
| Automatic soft limits or suspension at a threshold            | There is no data to set a threshold. ADR-0023 deferred the same question for masters.                                                                                     |
| Showing counts to the other party                             | One early event would label a person, and there is no ranking to feed them into yet.                                                                                      |

## Trade-offs accepted

- **After the minute, a master who genuinely cannot come depends on support.**
  A breakdown or an emergency now needs a human. The customer meanwhile has the
  free cancellation once the promise has passed by 10 minutes.
- **An unresponsive customer stalls an inspection-priced job until an admin
  acts.** ADR-0060 gave the master re-dispatch as the exit when the customer
  neither approves nor declines a quote. By `MASTER_ARRIVED` the minute has
  almost always passed, so the exit is now the admin.
- **A late cancellation is marked without the customer being told.** It has
  no consequence the customer would feel. If an automatic consequence is ever
  added, the customer must be told before it applies.
- **Free within 2 minutes includes a customer who cancels a master already
  driving.** That is accepted: the master has driven for at most two minutes.

## Consequences

- **API.**
  - The master's re-dispatch is refused after the window with a stable error
    code. The check is in the conditional `UPDATE`, against the database
    clock, so a slow request cannot slip past it. An admin's re-dispatch is not
    affected.
  - Each customer cancellation records its class (free, late, master late, or
    price declined) when it happens, so a later change to a duration does not
    rewrite history.
  - The three durations are added to the configuration schema.
- **Admin panel.** The customer's file shows the late-cancellation count. The
  master's file shows the hand-back count and the late-arrival count.
- **Mobile.** The master's hand-back control is offered only within the
  window. A refusal from the server is shown, not retried.
- **Tests.**
  - a hand-back at 59 s succeeds and one at 61 s is refused;
  - an admin re-dispatch after the window still succeeds;
  - each customer cancellation lands in the right class, including on the
    boundaries;
  - no count is ever returned to the other party.
- CLAUDE.md § 1 moves the question to the settled table, and the product
  flows, `user-roles.md`, the roadmap and the epics are updated.

## Revisit when

- Data from the first months shows abuse that admins cannot keep up with by
  hand. That is the time for automatic limits, and the customer is told first.
- Support load from masters who cannot come after the minute is significant.
  That may call for a self-service exit with a reason, counted against the
  master.
- Dispatch gains a ranking (ADR-0009). The counts would then be its obvious
  inputs.
- The owner decides on a call-out fee.
