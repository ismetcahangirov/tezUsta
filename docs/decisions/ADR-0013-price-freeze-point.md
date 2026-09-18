# ADR-0013 — The order price is frozen at accept, not at creation

- **Status:** **Accepted**
- **Date:** 2026-09-15
- **Supersedes:** the order-creation step of the pricing flow in
  [ADR-0010](ADR-0010-pricing-and-commission.md). Everything else in ADR-0010
  stands: the master sets the price, the client never submits an amount, and
  the platform takes a commission.

## Context

Two accepted decisions did not fit together.

[ADR-0010](ADR-0010-pricing-and-commission.md) describes the pricing flow as:

```
Master sets their price in their profile   → server stores it
Customer creates an order                  → SERVER applies that master's price
```

and freezes `orders.price_minor` at creation.

[ADR-0009](ADR-0009-dispatch-model.md) creates the order into `SEARCHING` and
_then_ broadcasts it to every eligible master, first accept wins.

At creation there is no "that master". There is a set of candidates, and
ADR-0010 itself accepts that their prices differ — it lists **price dispersion
across masters** as a known consequence and calls the displayed price "part of
the offer". So the creation-time freeze describes a price that does not exist
yet, and `docs/product/customer-flow.md` compounded it by showing the customer
a firm price before the order was created.

This is not a detail. It determines what the customer agrees to, what the
master is bound by, what the commission is computed from, and what the order
history has to record.

## Decision

**The price is frozen at accept, from the accepting master's stored price, in
the same transaction as the accept.**

```
Customer picks a service       → server returns an INDICATIVE RANGE
                                 (min–max of eligible masters' prices)
Customer creates the order     → orders.price_minor is NULL
                                 status = SEARCHING
Broadcast to eligible masters  → each master sees THEIR OWN price on the card
First master accepts           → orders.price_minor := that master's price
                                 orders.master_id  := that master
                                 both written in the accept transaction
```

Rules that follow:

1. **`orders.price_minor` is nullable and is null while `SEARCHING`.** A
   non-null price implies an assigned master; the two are written together and
   cleared together.
2. **The client never submits an amount**, at creation or at accept. This is
   ADR-0010's rule and it is unchanged.
3. **The indicative range is labelled as an estimate** in the client and is
   never stored on the order. It is a read model computed from the same
   eligibility predicate the broadcast uses, so the range cannot contain a
   master who would not have been offered the order.
4. **Re-dispatch clears the price.** When an order returns to `SEARCHING`
   because the assigned master cancelled
   ([ADR-0015](ADR-0015-order-lifecycle-states.md)), `price_minor` and
   `master_id` are cleared together. The next accepting master's price is
   frozen instead. The customer is told the price changed.
5. **A master's later price edit never moves a frozen price.** The freeze is a
   copy, not a reference — which was already ADR-0010's intent.
6. **The commission is computed from the frozen price**, so the commission
   basis is fixed at the same instant as the price.

## Why

**It is the only point where a single price exists.** Before accept there is a
set of prices; after accept there is exactly one. Freezing at accept is not a
compromise between the two ADRs, it is the only moment the value is defined.

**It keeps the accept guard intact.** ADR-0009's concurrency guard is a
conditional update on `master_id IS NULL`. Writing the price in that same
statement means the winner of the race and the price are decided by one atomic
operation, with no second write that could interleave.

**It tells the customer the truth.** A firm number shown before dispatch would
be a number the platform cannot honour, since the master who eventually accepts
may charge something else. An explicit range is honest and still lets the
customer decide whether to proceed.

**It leaves cash and card identical.** The payable amount is known at accept in
both cases, well before `COMPLETED`, so neither payment path needs a different
freeze rule.

## Alternatives considered

**Freeze at creation from a platform-normalised price.** The platform would
compute one price — a median, or a band midpoint — and every master would be
offered the order at that price. Rejected: it takes pricing away from the
master, which ADR-0010 settled in the master's favour, and it is a materially
different product decision that the owner did not make.

**Freeze at creation from the nearest master's price.** Rejected: it requires
choosing a master before the broadcast, which is exactly the sequential model
ADR-0009 rejected.

**Do not freeze at all; read the master's current price whenever it is
needed.** Rejected: the master could change their price mid-order, and the
customer would have agreed to nothing enforceable.

**Freeze at completion.** Rejected: the customer would commit to an unknown
amount, and the dispute surface is obvious.

## Consequences

- `orders.price_minor` is nullable. Every read of it on a `SEARCHING` order
  must handle null; a not-null constraint would be wrong.
- The order list for a customer shows "finding a master" rather than a price
  until accept.
- An integration test must cover the accept transaction writing `master_id`
  and `price_minor` together, and the re-dispatch path clearing both.
- The indicative-range endpoint is a new read model. It is not on the critical
  path for EPIC 6 and can ship with a single-value range if needed. **It
  shipped (issue #84) approximating eligibility with a master's verification
  status and offer activity, not yet the broadcast's actual predicate**
  (radius, presence, a commission-debt gate) — building that predicate early
  would be implementing a dependent feature before its prerequisite (CLAUDE.md
  §20). Rule 3 above therefore does not yet hold in the code: the range can
  include a master who would not, in fact, have been offered a given order.
  EPIC 7 is what reconciles the two.
- **Still open, and owner-owned:** whether the platform caps how far a master's
  price may sit from the median for a service. ADR-0010 already lists price
  guardrails as pending; this ADR does not settle them.
