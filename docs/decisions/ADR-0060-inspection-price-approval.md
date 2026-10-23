# ADR-0060 — An inspection price is quoted on arrival and approved by the customer before work starts

- **Status:** **Accepted (decline penalties wait for the cancellation rules)**
- **Date:** 2026-10-23
- **Decided by:** Project owner. On 23 October 2026 the owner accepted the recommendation on [#412].
- **Context:** EPIC 8 (#9), issue [#412]
- **Settles:** [ADR-0010](ADR-0010-pricing-and-commission.md) § Inspection-based pricing, "whether the customer approves that amount before work starts", and the matching **OPEN** in `docs/product/master-flow.md`.
- **Amends:** [ADR-0015](ADR-0015-order-lifecycle-states.md). `MASTER_ARRIVED` → `IN_PROGRESS` gains a guard on inspection-priced orders. No status or edge is added or removed.

[#412]: https://github.com/ismetcahangirov/tezUsta/issues/412

## Context

A service is priced in one of two shapes (`services.pricing_kind`):

- **`fixed`.** The accepting master's stored price is frozen onto the order at accept ([ADR-0013](ADR-0013-price-freeze-point.md)).
- **`inspection`.** The work cannot be priced until a master has seen it. The order is accepted with `price_minor = null`.

ADR-0010 says the master sets an inspection price "after inspecting, during the order lifecycle". Nothing implements that. An inspection-priced order keeps a null price for life: no endpoint sets it, and the customer's screen and the admin show "not set" forever. The EPIC 8 status audit on 2026-10-20 found the gap.

ADR-0010 left one question open: does the customer approve the amount before work starts?

- **Without approval**, the customer has no protection against an inflated quote. The master is standing in their home when the number appears.
- **With approval**, there is a stall point mid-job.

Two settled facts shape the answer:

- **The platform never touches order money** ([ADR-0046](ADR-0046-subscription-only-monetisation.md) § 4). The customer pays the master directly. An approved price is a recorded agreement, not a charge, so approving it moves no money and needs no payment provider.
- **The customer and the master are in the same room** when the quote is made. The stall the approval step adds is a tap on a phone the customer is holding, not a wait on someone who is away.

## Decision

### 1. When: on arrival, before work starts

The assigned master enters the price **while the order is `MASTER_ARRIVED`**, after inspecting. Not at accept, because nobody has seen the job yet, and not during `IN_PROGRESS`, because the work would already have started.

### 2. The customer must approve it

For an inspection-priced order, **`MASTER_ARRIVED` → `IN_PROGRESS` is refused until the customer has approved a price.** A fixed-price order is unaffected: its price was known before the customer ever saw the master.

### 3. The price may change until it is approved, and never after

- Before approval, the master may replace the quote, for example after a second look. Each new quote is pushed to the customer.
- **Approval names the amount the customer saw.** It succeeds only if that amount is still the quote, in one conditional `UPDATE`. A customer who approves 40 AZN can never be recorded as approving the 60 AZN the master typed a second earlier.
- Once approved, the price is frozen exactly like a fixed price ([ADR-0013](ADR-0013-price-freeze-point.md) rule 5). If the job turns out bigger mid-work, there is no re-quote: the customer's recourse is the dispute window ([ADR-0015](ADR-0015-order-lifecycle-states.md)).

### 4. A decline is a cancellation, and costs nobody anything

- The customer declines by cancelling the order from `MASTER_ARRIVED`. That edge already exists for the customer (ADR-0015), so **no new status or edge** is needed.
- The cancellation is recorded **as a price decline**, distinct from any other customer cancellation, so that the cancellation rules can tell the two apart when they are decided.
- **No penalty for either side.** The customer declined a number they had never seen; the master quoted honestly. Neither did anything a penalty should discourage.

### 5. Re-dispatch clears the quote

When an order leaves `MASTER_ARRIVED` for `SEARCHING` (ADR-0015 § Re-dispatch), the quote and any approval are cleared together with `master_id` and `price_minor`, as ADR-0013 rule 4 already does for a fixed price. The next master inspects and quotes again.

### 6. The order remembers its pricing shape

The order records the pricing shape its service had **at creation**. An admin may change a service's shape in the catalogue, and that must not turn an order in flight from inspection-priced into fixed-priced, or the reverse. This is the same copy-not-reference rule ADR-0010 applies to the price itself.

## Why

**It is the only point where both a number and a decision exist.** Before arrival, nobody has inspected anything. After `IN_PROGRESS`, the work has started and declining no longer leaves both sides where they were.

**Approval costs little here.** The usual objection to an approval step is the stall. In this flow the customer is present and holding the phone, so the stall is seconds.

**Matching the amount, not just the order, is what makes "approved" mean something.** An approval that only names the order would let a quote changed after the customer looked be recorded as accepted. A conditional `UPDATE` on the amount closes that race with no lock and no version column, in the same style as ADR-0009's accept guard.

**A decline needs no new state.** The customer could already cancel from `MASTER_ARRIVED`. Recording why is cheaper than a new status, and ADR-0015 forbids adding edges outside an ADR.

**The platform-holds-no-money rule keeps this small.** The approved price is information both parties agreed to, used on the order screen, in the admin and in disputes. Nothing charges it.

## Alternatives considered

| Option                                                                      | Why not                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a) No approval, the price is informational**                             | The customer has no protection against an inflated quote, and the master is already in their home when it appears. The dispute window is the only recourse, after the money has changed hands.                                                                                                          |
| **(c) Approval optional, the price shown and recorded**                     | Behaves like (a) whenever the customer does not tap, which is exactly when a quote goes unchallenged. It adds the screen and the endpoint of (b) without its protection.                                                                                                                                |
| **Quote at accept, from the offer card**                                    | Nobody has seen the job. A number made up before inspection either gets inflated to be safe or renegotiated at the door, which is the problem this ADR exists to settle.                                                                                                                                |
| **Quote during `IN_PROGRESS`**                                              | The work has started. A decline at that point leaves a half-done job, and ADR-0015 rejects re-dispatch from `IN_PROGRESS` for that reason.                                                                                                                                                              |
| **A new `PRICE_PENDING` status between `MASTER_ARRIVED` and `IN_PROGRESS`** | A status and two edges, a migration of the enum, and a new row in every status switch, to represent what a guard on one existing edge represents. ADR-0015 rejected a reason column standing in for statuses; this is the opposite case, where the state is "arrived" and the price is a fact about it. |
| **Approval naming only the order, not the amount**                          | A quote changed between the customer looking and tapping would be recorded as approved.                                                                                                                                                                                                                 |
| **The price may be re-quoted after approval, with a second approval**       | A mid-job renegotiation surface, with the customer's home as the setting. Rare enough, at launch, for the dispute window to carry it. Revisit if disputes show otherwise.                                                                                                                               |

## Trade-offs accepted

- **A master who inspected and was declined earns nothing from the platform's record of the order.** A call-out or inspection fee is a product decision the owner has not made. Since the platform holds no money, any such fee would be the master's own arrangement, and recording one would need its own decision. This ADR does not add one.
- **An unresponsive customer stalls the job.** If the customer never approves or declines, the master's only exit is the existing re-dispatch edge (`MASTER_ARRIVED` → `SEARCHING`, with a reason), which sends the order to another master. That is the wrong outcome for a customer who simply left the phone in another room, but it is rare when both people are in the same place, and the reason is recorded.
- **No re-quote once work starts.** A job that grows mid-work goes to the dispute window, not to a new price.
- **"No penalty" is provisional.** It holds until the cancellation rules, still open in CLAUDE.md § 1, are decided. Recording a decline distinctly is what lets those rules treat it differently without reconstructing history.

## Consequences

For the follow-up implementation:

- **Schema.**
  - The order's pricing shape, copied from the service at creation (§ 6).
  - The approval time (`price_approved_at`, or equivalent). The quote itself can live in `price_minor`: the column is already nullable and `orders_price_requires_master` already allows an assigned master with no amount.
  - A check that an approval implies a price.
  - Re-dispatch clears the quote and the approval with `master_id` (§ 5).
- **Endpoints**, each following the transition pattern: an actor check, one conditional `UPDATE`, an `order_status_history` or audit row, a realtime frame on the order room, and a push to the other party.
  - Quote: the assigned master only, `MASTER_ARRIVED` only, an inspection-priced order only, not yet approved. The amount is integer minor units with the same bounds as `master_services.price_minor`.
  - Approve: the order's customer only, `MASTER_ARRIVED` only, carrying the amount being approved (§ 3).
  - Decline: the existing customer cancellation from `MASTER_ARRIVED`, with the decline recorded as such (§ 4).
- **The transition guard.** `MASTER_ARRIVED` → `IN_PROGRESS` is refused, with a distinct error, for an inspection-priced order with no approved price. The edge table in `order-lifecycle.ts` is unchanged; the guard sits in the transition path that already reads the order row.
- **Mobile.** The master's job screen gets a price entry while arrived on an inspection job. The customer's order screen shows the quote with approve and decline.
- **Admin.** The order detail shows the quote, the approval time, and a decline as the cancellation reason.
- **Tests.** Every refusal (wrong actor, wrong status, fixed-price order, already approved, stale amount on approve), the guard on `IN_PROGRESS`, and re-dispatch clearing the quote.
- CLAUDE.md § 1 moves this question to the settled table.

## Revisit when

- Disputes about jobs that grew mid-work are common enough to justify a re-quote with a second approval.
- The cancellation rules are decided. They decide whether a decline stays penalty-free.
- The owner decides on a call-out or inspection fee.
