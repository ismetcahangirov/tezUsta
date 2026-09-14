# ADR-0010 — Pricing ownership and commission model

- **Status:** **Accepted** (commission rate and guardrails pending)
- **Date:** 2026-09-14
- **Decided by:** Project owner

## Context

Three pricing shapes were specified for TezUsta: fixed price, inspection-based,
and an emergency surcharge. What was never settled is **who sets the number** —
the platform, the master, or a negotiation. That answer determines the schema,
so it blocked EPIC 3 and EPIC 5.

## Decision

**The master sets the price. The platform takes a commission (a percentage of
the completed order).**

### Schema consequence

```
services.base_price          → reference / suggested price, nullable
master_services.price        → the master's own price — AUTHORITATIVE for an order
orders.price_minor           → frozen copy, taken at order creation
orders.commission_rate       → frozen copy, taken at completion
```

`master_services` therefore **carries a price column**. This closes the question
that blocked #31 and #37.

## Why freezing matters

**A completed order's money must never change retroactively.**

If a master raises their price tomorrow, yesterday's completed order must still
settle at yesterday's figure. The same applies to commission: an order is
settled against the rate **in force when it completed**, not the current rate.

So `orders` stores its own `price_minor` and `commission_rate` rather than
referencing `master_services` and `commission_rules`. A join to a live table
would silently rewrite history every time either value changed — and the first
symptom would be a master disputing a payout months later, with no way to prove
what the rate had been.

## "The master sets the price" does not mean the client sends the amount

The flow is:

```
Master sets their price in their profile   → server stores it
Customer creates an order                  → SERVER applies that master's price
```

The mobile app **never submits an amount** (CLAUDE.md §11). A client-supplied
price is a client-controlled price. Prices still come from the backend; the
backend simply reads them from a master-owned row instead of a platform-owned
one.

## Money representation

**Integer minor units (`bigint`). Never a float.**

Binary floating point cannot represent 0.10 exactly. Summing a percentage
commission across thousands of orders in `double precision` produces figures
that do not reconcile — and payment reconciliation is exactly where that shows
up. 15.00 AZN is stored as `1500`.

## Inspection-based pricing

Unchanged by this decision. For an inspection-priced service the master sets the
amount **after inspecting**, during the order lifecycle (EPIC 8). Whether the
customer approves that amount before work starts remains an open product
question.

## Trade-offs accepted

- **Price dispersion across masters.** Customers will see different prices for
  the same service. That is inherent to the model and arguably a feature, but it
  makes the displayed price part of the offer, not a catalogue fact.
- **Commission avoidance is possible without guardrails.** A master can list
  1 AZN and settle the rest in cash off-platform. See open questions.
- **`commission_rules` must be versioned**, not a single mutable number, so
  historic orders remain explainable.

## Open questions — do not hardcode around these

These do not block the schema (the rate is data, not code), but they are needed
before EPIC 14:

1. **What is the commission percentage?**
2. **Is it uniform, or does it vary by category?**
3. **Is commission added on top of the master's price, or deducted from it?**
   This changes what the customer is shown, so it is a product decision, not an
   accounting one.
4. **Are there minimum and maximum price guardrails?** Without a floor, a master
   can list 1 AZN and take the rest in cash, avoiding commission entirely.

## Interaction with cash payment

Because both cash and card are supported ([ADR-0007](ADR-0007-payments.md)), a
cash order's money **never passes through the platform**. Commission on cash
orders therefore becomes a debt the master owes, which implies a master wallet
or balance — and a threshold above which a master can no longer accept work.

That pulls `master_wallets` and `commission_rules` earlier than EPIC 14 planned.
Confirm the scope when EPIC 12 is scheduled.

## Revisit when

- Commission avoidance is observed in practice, or
- Price dispersion produces customer confusion that a platform-set band would
  fix.
