# ADR-0047 — Who administers the subscription, and when a price change needs notice

- **Status:** Accepted
- **Date:** 11 October 2026
- **Decided by:** Project owner, 11 October 2026. The owner reviewed issue #324
  and accepted both recommendations: finance reads masters, and the notice
  waits for the first payment.
- **Context:** issue #324, PR #340; EPIC 14 (#15)
- **Amends:** [ADR-0043](ADR-0043-admin-panel-policy.md) § 1 (the role table)
  and [ADR-0046](ADR-0046-subscription-only-monetisation.md) § 5 (the
  price-change notice). Neither ADR is otherwise changed.

## Context

ADR-0046 § 5 makes the subscription admin data: two prices, a trial, a grace
and whether purchases are open, all edited from the admin panel, and a period
granted to a master by hand. #324 built that surface. It raised three questions
the accepted ADRs do not answer.

1. **Which roles hold it.** ADR-0043's role table predates the subscription.
   Granting and cancelling are money decisions, which ADR-0043 gives to
   `finance` and `super_admin`. But the grant lives on a master's file, and
   `finance` cannot open one: the table gives it no `masters.read`.
2. **When the 30-day notice applies.** ADR-0046 § 5 says a new price version
   takes effect no sooner than 30 days after it is entered. Read literally,
   the launch prices could not take effect for 30 days, and a typo in a launch
   price could not be corrected for another 30, all while nobody has bought
   anything. The notice exists to protect masters who pay. Before the first
   payment there is nobody to protect.
3. **Whom a grant may reach.** A master's trial starts when verification
   approves them, and #322 gives no second trial to a master who already has a
   subscription. A grant before approval would take the trial away and spend
   the granted days while the master cannot work.

## Decision

1. **Two new permissions.**

   | Permission             | What it allows                                                                   | support | moderator | finance | super_admin |
   | ---------------------- | -------------------------------------------------------------------------------- | ------- | --------- | ------- | ----------- |
   | `subscriptions.read`   | See the offer, the price history and a master's subscription                     | ✓       | ✓         | ✓       | ✓           |
   | `subscriptions.manage` | Change prices, trial, grace and opening sales; grant or cancel a master's period | ✗       | ✗         | ✓       | ✓           |

   **`finance` also gains `masters.read`**, so it can find a master and open
   their file, where grants and cancellations are made. It does not gain review,
   suspension or personal-data reads. `pii.read` stays with `support` and
   `super_admin`.

2. **The notice applies to a billing period once anyone has paid for it.** A
   new price for a period with at least one payment on record takes effect no
   sooner than 30 days after it is entered, as ADR-0046 § 5 says. A period
   nobody has paid for yet can take a price that applies at once. That covers
   the launch prices and any correction made before sales begin. In both cases
   the change is a new price version and the history keeps every one.

3. **A grant reaches a master whom verification has approved, or who is
   suspended.** A grant before approval is refused, so the trial still starts at
   approval. A suspended master may be granted days in compensation, as
   ADR-0046 § 5 foresees.

## Consequences

- `admin-permissions.ts` carries the new permissions and `finance`'s
  `masters.read`. Its unit test pins both.
- `SubscriptionOfferService.changePrices` decides the earliest effective date
  per period from whether that period has been paid for.
- `POST /admin/masters/:id/subscription/grant` refuses a master who is not
  `active` or `suspended`. The panel offers the grant only to those masters.

## Revisit when

- A role other than `finance` needs to grant, for example support compensating
  a master after a complaint.
- Consumer law turns out to require notice even before the first sale (ADR-0046
  § 6 lists this as not verified).
