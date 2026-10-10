# ADR-0046 — TezUsta earns only from master subscriptions

- **Status:** Accepted (launch prices, trial length, grace length and the
  billing provider pending)
- **Date:** 10 October 2026
- **Decided by:** Project owner — _"the payment system will be subscription
  only"_ (10 October 2026). The owner also confirmed on 10 October 2026 that the
  platform never touches order money (§ 4), that price guardrails are not
  wanted for now (§ 3), and that the subscription is sold outside the app
  (§ 7). The subscription's shape is the owner's of the same day: _"there will
  be one subscription; a master buys it monthly or yearly; the subscription is
  editable from the admin panel"_ (§ 5).
- **Context:** issue #320; EPIC 12 (#13), EPIC 14 (#15)
- **Supersedes in part:** [ADR-0010](ADR-0010-pricing-and-commission.md) — the
  commission, the frozen commission rate, the commission-debt consequence and
  the price-guardrail question. [ADR-0007](ADR-0007-payments.md) — the money
  flow, the wallet and debt threshold, the fund-holding question and the
  commission question.
- **Amends:** [ADR-0015](ADR-0015-order-lifecycle-states.md) § `RESOLVED` and
  `REFUNDED` (what a refund on a cash order is) and
  [ADR-0043](ADR-0043-admin-panel-policy.md) § 5 and § Revisit when (when
  `REFUNDED` is enabled). Neither ADR's status table or edges change.

## Context

Until today TezUsta's revenue model was a commission on each completed order
(ADR-0010), collected through cash and card (ADR-0007). Cash made that model
hard: the money never passes through the platform, so the commission became a
debt the master owed, which needed a wallet, a debt ceiling in the dispatch
query, and a legal answer to whether TezUsta may hold customer funds before any
card flow could be designed. EPIC 12 has been blocked on three owner and legal
decisions since 14 September 2026, and EPIC 14 was scoped as "commission plus
subscription".

On 10 October 2026 the owner replaced that model: TezUsta earns only from
master subscriptions.

What exists in the code today because of commission, and is removed by #321:

- `masters.commission_debt_minor` and its CHECK
  `masters_commission_debt_non_negative` (migration
  `0014_order_offers_and_commission_debt.sql`)
- `MAX_COMMISSION_DEBT_MINOR` (`apps/api/src/infra/config/env.schema.ts`)
- the dispatch eligibility term `m.commission_debt_minor <= max` in
  `masterEligibilityTerms` (`apps/api/src/modules/masters/nearby-masters.repository.ts`)
- the accept-time re-check of that term (`master-offers.service.ts`)

Nothing else that commission implied was ever built: there is no
`commission_rules`, no `master_wallets`, no `payouts`, no `payments` table and
no `orders.commission_rate` column.

## Decision

### 1. Who pays

**Masters pay TezUsta a subscription. Customers use the app free.** A customer
pays nothing to TezUsta — not a booking fee, not a service fee, not a markup on
the master's price. The only money that reaches TezUsta is a master's
subscription payment.

### 2. No commission, anywhere

- No commission on any order, whatever its payment method.
- No `commission_rules`, no `master_wallets`, no commission debt, no payout
  cycle. None of them is to be created, in EPIC 12, EPIC 14 or later, without a
  new ADR superseding this one.
- The commission-debt brake is removed from the code (#321). The subscription
  entitlement takes its place in the same seam, `masterEligibilityTerms`, and in
  the same accept-time re-check (#322).

### 3. What of ADR-0010 still holds

ADR-0010 is **superseded in part**. Its body is not edited.

| ADR-0010 rule                                                                             | After this ADR                                                                               |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| The master sets the price                                                                 | **Holds.** `master_services.price` stays authoritative                                       |
| The price is frozen on the order — at accept ([ADR-0013](ADR-0013-price-freeze-point.md)) | **Holds.** The frozen price is what the customer is shown and what a dispute is argued about |
| The client never submits an amount                                                        | **Holds**, for orders and for subscriptions alike                                            |
| Money is integer minor units (`bigint`), never a float                                    | **Holds**, for the order price and for the subscription price                                |
| The platform takes a commission; `orders.commission_rate` freezes at completion           | **Superseded.** No commission; the column is never created                                   |
| Commission on cash becomes a debt; a wallet and a threshold follow                        | **Superseded.** No debt, no wallet, no threshold                                             |
| Open question 4 — minimum and maximum price guardrails                                    | **Closed: not wanted for now.** See below                                                    |

**Price guardrails.** ADR-0010 asked for a price floor to stop commission
avoidance — a master listing 1 AZN and taking the rest in cash. With no
commission there is nothing to avoid. A guardrail could still serve as consumer
protection — a ceiling against an emergency call-out priced at ten times the
going rate — but the owner decided on 10 October 2026 not to have one for now.
The indicative price range the customer sees before accept
([ADR-0013](ADR-0013-price-freeze-point.md)) and reviews
([ADR-0042](ADR-0042-review-policy.md)) are the existing protections. Revisit if
complaints about pricing appear (§ Revisit when).

### 4. The platform never touches order money

**The customer pays the master directly** — in cash, or by the master's own card
terminal or bank transfer. TezUsta processes no order payment, holds no customer
funds and pays out nothing. The app shows the frozen price as information: what
the master said the job costs, not a bill TezUsta collects.

This settles ADR-0007's first and largest open question — _does TezUsta hold
customer funds?_ — and the answer is **no**. The payment-provider question no
longer concerns order money at all. It shrinks to **which provider bills master
subscriptions** (§ 6), and it stays open.

"Cash and card" (ADR-0007) remains true in the sense the customer cares about —
they may pay either way — but both are between the customer and the master. The
platform is in neither path.

Consequences for the order lifecycle ([ADR-0015](ADR-0015-order-lifecycle-states.md)):

- **`PAYMENT_PENDING` and `PAID` become dormant.** Both existed for the
  platform's own settlement. No system path writes either status today, and
  after this ADR none ever will. A normal order ends at `COMPLETED`. The
  statuses and edges stay in the enum and the transition table, because removing
  an enum value is a migration and a new ADR superseding ADR-0015. Retiring them
  is a separate decision, not part of this one.
- **An admin should not be able to write them either.** An admin may drive any
  edge the table contains (ADR-0015 § Admin override), so today an admin with
  `orders.override` can move a completed order to `PAID` or `PAYMENT_PENDING`.
  That would record a payment the platform never saw — the same false audit
  trail ADR-0043 refused `REFUNDED` to avoid. The admin override to those two
  statuses is to be refused the way `REFUNDED` is. That is a code change, and it
  needs its own issue.
- **`REFUNDED` stays refused, and is no longer waiting for anything.** ADR-0043
  withheld it, with `REFUND_NOT_AVAILABLE`, "until EPIC 12 ships a refund
  mechanism". There will be no such mechanism for orders, because the platform
  never held the money that would be refunded. The admin action stays withheld
  indefinitely, the edge stays in the table, and the error code stays as it is.
  ADR-0015's sentence that "a refund on a cash order is a commission adjustment
  against the master's balance" no longer describes anything, because there is
  no balance.
- **A dispute is closed `RESOLVED`.** When a resolver decides the master should
  return money, that is a matter between the two parties. The resolver records
  the outcome in the mandatory reason, and the platform does not move the money.
  Reports about a party, and suspension, stay the platform's levers
  ([ADR-0043](ADR-0043-admin-panel-policy.md)).

What this costs is listed under § Trade-offs accepted.

### 5. The subscription

**There is exactly one subscription.** No tiers and no plan catalogue: every
master who pays gets the same entitlement, which is to receive work. A master
buys it **monthly or yearly**, and each billing period has its own price.

**It is admin-editable data, not code.** The monthly price, the yearly price,
the trial length, the grace length and whether new purchases are open are
edited from the admin panel, each change audited with a reason (#324). None of
them is a constant or an environment variable, and changing one is not a
release.

| Element                  | Decision                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Billing periods**      | **Monthly** and **yearly**. A period is one **calendar** month or one calendar year, computed in `Asia/Baku` and clamped to the last day of a shorter month: 31 January plus one month is 28 or 29 February. Not a fixed number of days — a master who pays on the 5th expects the 5th, not "30 days later"                                 |
| **Prices**               | **Versioned, never edited in place.** A change inserts a new price version with an `effective_from`. It applies to purchases and renewals from that moment. A period already paid keeps the price it was paid at, and every period records which price version it was paid against (#322)                                                   |
| **Price-change notice**  | **30 days.** A new price version takes effect no sooner than 30 days after it is entered, for new purchases and renewals alike, and masters with auto-renewal are told when it is entered (§ 6, #324, #326). One rule means there is never an old and a new price live at the same time                                                     |
| **Switching period**     | **Prepaid stacking.** A master who buys the other period while one is running gets it **after** the current one ends. No proration, and no refund of the unused part                                                                                                                                                                        |
| **Trial**                | **Yes.** It starts when verification approves the master ([ADR-0023](ADR-0023-master-verification-policy.md)), not at sign-up, because a master who is still pending cannot receive work and a trial spent waiting for review is a trial wasted. A trial change applies to trials started after it. **The launch length is an owner input** |
| **Grace**                | **Yes**, after a period ends unpaid. In grace the master still receives work. A grace change applies to lapses after it. **The launch length is an owner input**                                                                                                                                                                            |
| **Purchases open**       | A switch. It is **closed** in the seed until the owner gives launch prices, and cannot be opened while either period has no price (#324)                                                                                                                                                                                                    |
| **Who may subscribe**    | A master whose verification status is `active`. A pending, rejected or suspended master cannot buy a period                                                                                                                                                                                                                                 |
| **Suspension**           | Suspending a master does not pause their subscription. The clock keeps running. An admin can grant days to make up for a suspension later judged unfair (#324)                                                                                                                                                                              |
| **Admin grant**          | An admin can grant a period, audited, with a reason (#324). That is how a promotion, a compensation or a correction is done without the provider — and, until a provider is live, the only way to activate a master                                                                                                                         |
| **Subscription refunds** | A refund of a subscription payment, if the provider issues one, is recorded as an event on the subscription (#323). It does not touch any order                                                                                                                                                                                             |

**What an expired master can and cannot do.** "Expired" means past the period
end and past grace.

| An expired master **can**                                  | An expired master **cannot**                     |
| ---------------------------------------------------------- | ------------------------------------------------ |
| Sign in                                                    | Turn availability on (`is_available = true`)     |
| See their order history, reviews and profile               | Be included in a dispatch broadcast              |
| Use the conversation of an order that is still open        | Accept an offer, even one received before expiry |
| **Finish a job already accepted** — expiry cancels nothing | Be re-dispatched an order                        |
| Buy or renew a period — outside the app (§ 7)              |                                                  |

A master going available is refused with a stable error code, so the app can say
why rather than show an empty feed (#322, #325). An accepted job runs to its end:
cancelling a customer's repair because the master's card was declined punishes
the customer for something they cannot see.

The entitlement is one predicate, evaluated by the server at the moment it
matters and never read from a token claim, just as verification is
([ADR-0023](ADR-0023-master-verification-policy.md)). The statuses (`trialing`,
`active`, `past_due`, `expired`, `cancelled`), the event history and the
predicate itself are specified in #322.

### 6. Renewal

**Auto-renewal by a merchant-initiated charge on a saved card, scheduled by
TezUsta, with manual renewal as the fallback.**

- The first payment goes through the provider's hosted checkout, which saves
  the card and returns a token. TezUsta stores the token reference, never card
  data, so PCI scope stays at zero.
- Before the period ends, a TezUsta job charges the token for the next period.
  A verified webhook, and nothing else, extends the period (#323).
- If the charge fails and the period ends unpaid, the subscription moves to
  `past_due`. The master keeps working through grace and can renew by hand
  with a new checkout at any time.
- A master who does not want auto-renewal, or whose token has lapsed, renews by
  hand. That is a prepaid period: a new checkout and no stored token.
- Cancelling stops renewal. The current period runs to its end (`cancelled`,
  #322).
- Renewal renews the billing period the master last bought. A queued period
  (§ 5, prepaid stacking) is used before any renewal charge.
- **A price change reaches a renewal only after 30 days' notice** (§ 5). The
  notice goes to the master by push (#326) and, once an SMS provider exists, by
  SMS. A master who does not accept the new price cancels before it applies.

The schedule belongs to TezUsta, not to the provider. Payriff offers a
dashboard scheduler, but Epoint documents none, and a provider-side schedule
would put the subscription's state machine in two places. With the schedule on
our side, the timing works the same whichever provider is chosen, and the
provider only executes a charge on a token.

**Evidence** (official developer documentation, read 10 October 2026). All three
local candidates document charging a saved card:

| Provider  | Saved-card charge                                                                                                                                                                                                                                                        | Scheduler                                                                                   | Source                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Payriff   | _"This method allows you to make an automatic payment using a previously saved card. To use it, you must first save a card using the cardSave method."_ (`POST /api/v3/autoPay`)                                                                                         | Yes — _"automatically charge customers at scheduled intervals — daily, weekly, or monthly"_ | `docs.payriff.com` — Recurring Payments, AutoPay, Card Save                |
| Epoint    | _"Charge a previously registered card without requiring the customer to enter card details again."_ (Execute Pay)                                                                                                                                                        | Not documented                                                                              | `developer.epoint.az/en` — Card Registration, Execute Pay                  |
| AzeriCard | Tokenised card storage, plus merchant-initiated scheduled and unscheduled charges (§ 7 "Recurring", `MIT_AGREEMENT`, `RECUR_FREQ`). `RECUR_EXP`: _"Abunəlik max kart saxlamadan 1 il müddətində ola bilər"_ — a subscription can last at most one year from card storage | Merchant-initiated scheduled charges                                                        | `developer.azericard.com` §§ 6–7. `azericard.com` itself answered HTTP 403 |

**If AzeriCard is chosen**, a token expires a year after the card was stored,
and the master re-authorises with a new checkout. A **yearly** subscription
therefore never auto-renews on AzeriCard: each year is a new checkout. The
manual path above already covers that.

**Not verified:** each provider's commercial onboarding, its fees, and whether
recurring charges need a separate agreement with the acquiring bank. These
depend on the provider the owner chooses. Nor is whether Azerbaijani consumer
law sets its own notice period for a price change on a recurring charge; 30 days
is this ADR's choice, not a legal finding.

### 7. Where the subscription is sold — app store policy

**The subscription is sold outside the app** — on a web page, through the local
billing provider, in AZN. **The app does not sell it.** It shows the master's
subscription status and nothing else: no purchase button, no link to the web
page, no price, and no call to action pointing at another way to pay. Decided
by the owner on 10 October 2026, on the evidence below.

#### What the store rules say

Both sources were read on 10 October 2026. Apple's page says _"Last Updated:
June 8, 2026"_. Google's page shows no date.

**Apple — [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)**

> **3.1.1** If you want to unlock features or functionality within your app,
> (by way of example: subscriptions, in-game currencies, game levels, access to
> premium content, or unlocking a full version), you must use in-app purchase.

> **3.1.1(a)** … In all other storefronts, except for the United States
> storefront, where this prohibition does not apply, apps and their metadata may
> not include buttons, external links, or other calls to action that direct
> customers to purchasing mechanisms other than in-app purchase.

> **3.1.3** The following apps may use purchase methods other than in-app
> purchase. Apps in this section cannot, within the app, encourage users to use
> a purchasing method other than in-app purchase, except for apps on the United
> States storefront and as set forth in 3.1.1(a) and 3.1.3(a). Developers can
> send communications outside of the app to their user base about purchasing
> methods other than in-app purchase.

> **3.1.3(b) Multiplatform Services:** Apps that operate across multiple
> platforms may allow users to access content, subscriptions, or features they
> have acquired in your app on other platforms or your web site, … provided
> those items are also available as in-app purchases within the app.

> **3.1.3(e) Goods and Services Outside of the App:** If your app enables people
> to purchase physical goods or services that will be consumed outside of the
> app, you must use purchase methods other than in-app purchase to collect those
> payments, such as Apple Pay or traditional credit card entry.

**Google — [Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738)**

> Play-distributed apps requiring or accepting payment for access to in-app
> features or services, including any app functionality, digital content or
> goods (collectively "in-app purchases"), must use Google Play's billing system
> for those transactions unless Section 3, 8, or 9 applies.

> Google Play's billing system must not be used in cases where: payment is
> primarily: … for the purchase of physical services (such as transportation
> services, cleaning services, airfare, gym memberships, food delivery, tickets
> for live events); …

> … apps may not lead users to a payment method other than Google Play's billing
> system. This prohibition includes, but is not limited to, leading users to
> other payment methods via: … In-app webviews, buttons, links, messaging,
> advertisements, or other calls to action; and In-app user interface flows,
> including account creation or sign-up flows …

And from Google's [Payments policy FAQ](https://support.google.com/googleplay/android-developer/answer/10281818):

> Google Play allows any app to be consumption-only, even if it is part of a
> paid service… Remember, consumption-only means that any product(s) or
> service(s), whether digital or physical, cannot be purchased from within the
> app.

#### What that means for TezUsta

**The physical-services exceptions do not cover the master's subscription.**
Apple's 3.1.3(e) and Google's physical-services carve-out cover the _customer's_
purchase of the repair. That is a payment TezUsta does not take at all (§ 4).
What the master buys from TezUsta is the ability to receive job offers inside
the app — "features or functionality within your app" (Apple 3.1.1), "access to
in-app features or services" (Google). Apple's own list of appropriate
subscriptions includes "software as a service" (3.1.2(a)), and Google's list of
subscriptions that need Play Billing includes "service upgrades".

**No alternative-billing programme covers Azerbaijan.** Apple's alternative
payment terms are for EU storefronts and the United States. Google's user-choice
billing lists Australia, Brazil, Indonesia, Japan, South Africa, the United
Kingdom and the EEA, plus separate programmes for the United States, India and
South Korea. Azerbaijan is in none of them, and Azerbaijan is not an EU member.

| Where the subscription is sold                                    | Apple risk | Google risk | Cost                                                                                                                         |
| ----------------------------------------------------------------- | ---------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| In the app, through a local provider's hosted checkout            | **High**   | **High**    | Rejection under Apple 3.1.1, or removal later; Google forbids leading users to another payment method from "in-app webviews" |
| **Outside the app, with no link, button or price in it** (chosen) | **Medium** | **Low**     | The master buys on the web. Apple's 3.1.3(b) assumes the item is also offered as an IAP                                      |
| Apple IAP and Google Play Billing                                 | Low        | Low         | Store fees (not researched), two store integrations, and AZN price points set per store                                      |

**Why outside the app.** It keeps one billing path and one provider, in AZN,
under the bank relationship ADR-0007 already expected. It pays no store fee. On
Google it is the consumption-only model the FAQ describes. On Apple it is the
**accepted medium risk** of this ADR: 3.1.3(b) speaks of items "also available
as in-app purchases", and App Review applies these rules unevenly.

**What the app may and may not say.** The same rule applies on both platforms,
so one build serves both:

- **May:** show the status, the billing period, the period end, the grace end
  and a queued next period.
  Say that the subscription has ended and that offers have stopped because of
  it.
- **May not:** show a purchase or renew button, a link or URL to the web page,
  the price, or text telling the master to pay elsewhere. Google's FAQ permits
  "Go to our website to upgrade" in a consumption-only app. Apple's 3.1.1(a)
  does not. The stricter rule wins.
- **Outside the app is allowed:** Apple 3.1.3 lets developers "send
  communications outside of the app to their user base about purchasing
  methods". An SMS to the master's phone number with the renewal link is
  outside the app. **A push notification is not** — it is the app speaking — so
  #326's pushes report status and carry no link, no price and no call to
  action.

**If Apple rejects the build**, the fallback is IAP on iOS only. The schema
already allows it: a subscription period can start from any confirmed payment
reference (#322), so a store receipt becomes one more provider behind the port
(#323). Nothing else in this ADR changes.

**Not verified:** Apple's External Purchase storefront list (the page did not
render); whether Google Play Billing is available in Azerbaijan; store fee
rates; and how comparable apps collect from tradespeople on iOS. The nearest
precedent found, Bark for Professionals, sells lead credits by Apple IAP. Asking
App Review in advance, or explaining the model in the review notes, is
recommended before the first submission.

### 8. Owner inputs

This ADR lists these and does not invent them. Each is admin-editable data or a
commercial choice, so none of them blocks building #322. Until the prices are
given, the seed leaves purchases closed.

| Input                             | Needed by                | Notes                                                                                                                |
| --------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Launch monthly price** in AZN   | Opening purchases (#324) | A price version, entered in the admin panel                                                                          |
| **Launch yearly price** in AZN    | Opening purchases (#324) | A price version, entered in the admin panel                                                                          |
| **Trial length** (days)           | #322 seed, #324          | `0` means no trial. Bounded 0–90 by #324                                                                             |
| **Grace length** (days)           | #322 seed, #324          | Bounded 0–30 by #324                                                                                                 |
| **Subscription billing provider** | #323 going live          | Payriff, Epoint and AzeriCard are the local candidates named so far. Follows the bank relationship, as ADR-0007 said |

## Why

**Subscription alone removes the hardest part of the old model.** Under
ADR-0007 the cash order was the problem: money the platform never saw, a
commission owed on it, and a ledger that had to be reconciled against nothing.
A subscription is charged to the master, by the platform, through one provider,
for one known amount. There is a provider record for every payment that reaches
TezUsta.

**Not touching order money removes the legal blocker.** Whether TezUsta may hold
customer funds needed legal advice because taking a customer's payment and
paying the master later is likely a regulated activity in Azerbaijan. If the
platform never takes it, the question does not arise. EPIC 12 had been blocked
on it for almost a month.

**It matches what customers already do.** Cash on completion is the common case
in this market (EPIC 12 already said so). Card payment to the master, when the
master has a terminal or takes a transfer, works today without TezUsta.

**The seam already exists.** The debt brake put an eligibility term into the
dispatch query and the accept path in EPIC 7. The subscription entitlement is
the same kind of term in the same two places, so the hot path keeps one
predicate and one set of `EXPLAIN` tests.

## Alternatives considered

| Option                                                         | Why not                                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Commission only** (ADR-0010 as it stood)                     | The owner replaced it. It also kept EPIC 12 blocked on legal advice and needed a wallet and a debt ceiling to work with cash                                       |
| **Commission plus subscription** (EPIC 14 as scoped)           | Two revenue mechanisms, both with ledgers, and still the cash debt problem. Everything hard about commission, with a second system on top                          |
| **In-app card payment for orders, no commission**              | The platform would hold customer funds — the regulated activity this ADR avoids — to earn nothing from it. The owner chose against it on 10 October 2026           |
| **A customer booking fee**                                     | The owner's decision is that customers use the app free                                                                                                            |
| **Pay per lead** (the master pays for each offer or accept)    | A per-order charge is a commission in another form: it needs a balance, it punishes a master for an offer the customer then cancels, and it brings back the ledger |
| **A plan catalogue or tiers**                                  | The owner decided on one subscription. Every master gets the same entitlement, so a second plan would sell nothing different                                       |
| **A fixed 30-day period**                                      | A master expects to renew on the same date each month. A calendar month in `Asia/Baku`, clamped at month end, gives that                                           |
| **Proration when switching period**                            | Prepaid stacking is simpler to explain and to reconcile: each payment buys one whole period at one recorded price                                                  |
| **Sell the subscription in the app through a local provider**  | High rejection risk on both stores (§ 7)                                                                                                                           |
| **Sell the subscription by Apple IAP and Google Play Billing** | Lowest policy risk, but store fees, two store integrations, and a second billing path beside the web. Kept as the iOS fallback (§ 7)                               |
| **Keep the price guardrails as consumer protection**           | Not wanted for now (owner, 10 October 2026). Revisit if pricing complaints appear                                                                                  |
| **Remove `PAYMENT_PENDING`, `PAID` and `REFUNDED` now**        | A migration on the order status enum and a new ADR superseding ADR-0015, for statuses no system path writes. Possible later, as its own decision                   |

## Trade-offs accepted

- **No in-app payment for orders.** A customer cannot pay by card inside the
  app. A customer whose master takes neither cards nor transfers has to pay in
  cash.
- **No platform-side refunds.** If a job goes wrong, TezUsta cannot give the
  customer their money back. A dispute ends with a recorded decision and, at
  most, action against the master. Customer trust rests on verification,
  reviews, and suspension.
- **The platform has no payment evidence for an order.** What the customer paid
  is what the two parties say. The frozen price and the order history are the
  only record, as ADR-0007 already accepted for cash.
- **Revenue does not scale with order value.** There is one subscription, so a
  master who does a lot of expensive work pays what one who does little pays.
- **No proration.** A master who switches from monthly to yearly waits for the
  month to end, and one who stops early gets nothing back for the unused part.
- **A master cannot buy or renew in the app.** They are sent outside it, by SMS
  or by someone telling them, and an expired master's app can say only that the
  subscription has ended. That is friction at the worst moment, accepted to stay
  inside the store rules (§ 7).
- **Apple may still reject the build** (medium risk, § 7). The fallback is IAP
  on iOS.
- **A stored card token is a consent obligation.** The master has to agree to
  auto-renewal on the checkout page and be able to turn it off.
- **A master pays before earning.** A new master's first month costs money
  before a single job, which the trial exists to soften.
- **Off-platform repeat work is free.** A customer who calls the same master
  directly next time costs TezUsta nothing, but also pays it nothing. Under a
  subscription that is less of a loss than under commission, because the master
  has already paid.

## Consequences

- **#321** removes the commission-debt column, its CHECK, the environment
  variable, the dispatch term and the accept re-check.
- **#322** adds `subscription_settings`, the versioned `subscription_prices`,
  `master_subscriptions` and `subscription_events`, the calendar period
  arithmetic, the entitlement predicate, and the dispatch gate in the seam #321
  leaves.
- **#323** bills subscriptions behind a provider port with a stub, as ADR-0008
  did for SMS. Renewal is the TezUsta-scheduled charge on a saved token in § 6.
- **#324** lets an admin edit the subscription — both prices, trial, grace and
  purchases open — and a master's subscription, with audited grants.
  Until a web purchase page exists, an admin grant after an offline payment is
  how a master gets a period.
- **#325** takes its "outside the app" branch: status, warnings and the
  explanation for a refused availability toggle, with **no** checkout, link or
  price in the app (§ 7).
- **#326** pushes status changes and the 30-day price-change notice, with no
  link, price or call to action (§ 7). The notice says that the price is
  changing and when; the amount itself is shown outside the app.
- **The admin override to `PAYMENT_PENDING` and `PAID` is refused** like
  `REFUNDED` (§ 4). It needs its own issue.
- **A web purchase surface is new scope.** The master needs a page outside the
  app to pay on, and that page has to know which master is paying. It needs its
  own issue, covering how a master signs in on the web — phone and OTP, so it
  shares EPIC 2's SMS-provider blocker — and the page itself. Its design is the
  owner's (CLAUDE.md §17).
- **EPIC 12 (#13)** no longer settles orders. Its order-payment scope is gone.
  What remains of "payments" is subscription billing, which EPIC 14 owns.
- **EPIC 14 (#15)** becomes "Master Subscriptions". Commission, wallets and
  payouts leave its scope.
- **ADR-0007** and **ADR-0010** gain "Superseded in part by ADR-0046" in their
  headers. **ADR-0015** and **ADR-0043** gain "Amended by ADR-0046". Nothing
  else in those four records changes.
- CLAUDE.md, the roadmap, the Epics and the product documents stop describing a
  commission in the same change as this ADR. The architecture documents that
  describe the debt gate describe code that still exists; they change with #321,
  which removes it.
- EPIC 12's binding constraints from ADR-0007 still apply to subscription
  billing: integer minor units, append-only payment records, idempotency on
  every mutating operation, webhooks as the settlement source of truth, prices
  from the backend, scheduled reconciliation and PCI scope zero.

## Revisit when

- The owner wants in-app card payment for orders. That brings back the
  fund-holding question and needs legal advice first.
- Complaints about pricing appear — reconsider guardrails as consumer
  protection.
- One subscription price proves unfair across masters who earn very different
  amounts — consider tiers, which the owner ruled out for launch.
- The chosen billing provider's recurring support changes (§ 6).
- Apple rejects a build over § 7 — move iOS to IAP.
- Apple or Google change the guidelines quoted in § 7, or open an
  alternative-billing programme to Azerbaijan.
