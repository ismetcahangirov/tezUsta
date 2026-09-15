# Product overview

> **Scope note.** This document records what the project owner has specified,
> plus the questions that remain open. Where something is not yet decided it is
> marked **OPEN**. Per CLAUDE.md §17, open product and visual decisions are not
> filled in by engineering.

## What TezUsta is

TezUsta connects people who have an **urgent or small household problem** with a
nearby **verified professional** ("master"), quickly.

The workflow philosophy is a ride-hailing app's, applied to home repair: the
customer states a need, the platform finds someone nearby who can do it now, and
both sides track the job to completion.

**Market:** Azerbaijan, starting in Baku. **Currency:** AZN.

## Service categories

| Category                    | Typical job                                |
| --------------------------- | ------------------------------------------ |
| Plumbing                    | Leaking pipe, blocked drain, replace a tap |
| Locks                       | Lock replacement, lockout entry            |
| Electrical                  | Socket, wiring fault, light fitting        |
| Air conditioning            | Not cooling, service, install              |
| Appliance repair            | Washing machine, fridge, oven              |
| Small construction / repair | Minor fixes and patching                   |
| Furniture assembly          | Flat-pack assembly                         |
| Painting                    | Small painting work                        |
| Cleaning                    | Household cleaning                         |
| Other                       | Anything not covered above                 |

The authoritative list lives in the database (`service_categories`, `services`),
is editable by admins, and is **never hardcoded in the mobile app**. The app
renders whatever the catalogue returns.

## The core loop

```
CUSTOMER                          MASTER
   |                                 |
select service                    go online
   |                                 |
describe problem                     |
   |                                 |
attach photos (optional)             |
   |                                 |
set location / address               |
   |                                 |
create order ------------------> receives nearby order
   |                                 |
   |                            reviews service, problem,
   |                            distance band, price
   |                                 |
   |<---------------------------- accepts
   |                                 |
track master <----------------- travels to customer
   |                                 |
   |<---------------------------- arrives
   |                                 |
   |                            starts work
   |                                 |
   |<---------------------------- completes
   |                                 |
pays ---------------------------> receives payment
   |                                 |
leaves review                    receives rating
```

The offer card carries a **distance band, not the customer's exact address**. The
address is PII and is revealed only to the master who accepts (CLAUDE.md §11) —
otherwise every broadcast would hand a home address to every master in range,
including the ones who never take the job.

Per-role detail: [`customer-flow.md`](customer-flow.md),
[`master-flow.md`](master-flow.md), [`admin-flow.md`](admin-flow.md).

## What makes this hard

These are the properties that actually shape the architecture:

1. **Dispatch is a race.** Several masters may see the same order. Exactly one
   must win, and the rest must be told promptly. This is a concurrency problem,
   not a UI problem — see [`../architecture/backend-architecture.md`](../architecture/backend-architecture.md).
2. **Location is continuous but expensive.** A master's phone must report
   position often enough to be useful and rarely enough not to drain the
   battery. See [`../architecture/realtime-architecture.md`](../architecture/realtime-architecture.md).
3. **Two-sided trust.** A customer lets a stranger into their home; a master
   travels to a stranger's address. Verification and reviews are not features,
   they are the product.
4. **Not all prices are knowable up front.** "Replace a tap" has a price.
   "Air conditioner not working" does not, until someone looks at it.
5. **Cancellation is normal.** Both sides will cancel. The rules around when,
   and with what consequence, are a product decision — **OPEN**.

## Pricing model

Three shapes are specified:

| Shape                   | Example                | Behaviour                                  |
| ----------------------- | ---------------------- | ------------------------------------------ |
| **Fixed price**         | Replace a tap — 15 AZN | Known before the master is dispatched      |
| **Inspection-based**    | AC not cooling         | Price determined after the master inspects |
| **Emergency surcharge** | Out-of-hours call-out  | Base price plus an urgency fee             |

**The master sets the price** ([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)).
The catalogue's price is a reference; the authoritative figure for an order comes
from that master's own listing — **including the emergency surcharge**, which the
master sets on their own service within platform guardrails. Ownership of the
surcharge is not a separate question from ownership of the price.

**Prices still always come from the backend.** "The master sets it" does not mean
the app submits an amount — the master sets it in their profile and the server
stores it. The client never submits an amount, at order creation or at accept. A
client-side price is a client-controlled price.

**An order's price is frozen at accept, not at creation**
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)). Before the order
exists there is no single price to freeze: the order is broadcast to many
masters, and ADR-0010 accepts that their prices differ. So the customer sees an
**indicative range** — the minimum and maximum of the eligible masters' prices,
labelled explicitly as an estimate — `orders.price_minor` stays null while the
order is `SEARCHING`, and the accepting master's stored price is copied onto the
order in the same transaction that writes `master_id`. The commission rate
freezes at completion. A later change to either must never rewrite a finished
order.

**OPEN:** the surcharge cap, what hours count as "out-of-hours", and whether the
platform imposes minimum/maximum price guardrails. These are numbers, not
ownership.

## Business model

- **Commission** on each completed order — the confirmed mechanism
- **Master subscription** — a possible later addition

**Both cash and card are supported** ([ADR-0007](../decisions/ADR-0007-payments.md)).
This is the hardest combination: on a cash order the money never passes through
the platform, so commission cannot be deducted at source and becomes a **debt**.
That requires a master balance and a threshold —
`MAX_COMMISSION_DEBT_MINOR` — above which a master cannot accept new work. The
threshold is part of the accept predicate from the start; the debt column simply
reads zero until EPIC 12 populates it.

Neither is implemented yet, and the supporting entities (wallets, payouts,
commission rules, subscription plans) do not exist until their Epic is scheduled.

## Out of scope for now

Explicitly **not** being built yet — listed so nobody builds them speculatively:

- Scheduled / future-dated bookings (the product is _urgent_ work)
- Multi-master jobs
- Parts and materials inventory
- Master-to-master subcontracting
- Web app for customers
- Any market outside Azerbaijan

In-app chat is **not** on this list. It is an open launch-scope question and is
recorded once, below — a thing cannot be both out of scope and undecided.

## Product decisions — settled

Decided by the project owner on 2026-09-14:

| Decision           | Outcome                                                | ADR                                                         |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| Sign-in method     | **Phone + SMS OTP only** — no social sign-in           | [ADR-0008](../decisions/ADR-0008-otp-delivery.md)           |
| Dispatch model     | **Parallel broadcast, first accept wins** (Bolt-style) | [ADR-0009](../decisions/ADR-0009-dispatch-model.md)         |
| Who sets the price | **The master**; platform takes a commission            | [ADR-0010](../decisions/ADR-0010-pricing-and-commission.md) |
| Payment methods    | **Both cash and card**                                 | [ADR-0007](../decisions/ADR-0007-payments.md)               |
| Maps / geocoding   | **Google Maps Platform**                               | [ADR-0004](../decisions/ADR-0004-location-and-maps.md)      |
| Design system      | **Light + dark, Anybody, lime accent, closed palette** | [ADR-0011](../decisions/ADR-0011-design-system.md)          |

Settled afterwards, because the decisions above could not all be true at once:

| Decision           | Outcome                                                                | ADR                                                         |
| ------------------ | ---------------------------------------------------------------------- | ----------------------------------------------------------- |
| Price freeze point | **At accept**, from the accepting master's stored price                | [ADR-0013](../decisions/ADR-0013-price-freeze-point.md)     |
| Admin sign-in      | **Email + password + mandatory TOTP**, separate account store          | [ADR-0014](../decisions/ADR-0014-admin-authentication.md)   |
| Order lifecycle    | The complete status set, re-dispatch, and `NO_MASTER_FOUND`            | [ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md) |
| Work completion    | **The master marks it complete**; the customer's recourse is a dispute | [ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md) |

## Open product questions

These block specific Epics. They are business decisions, not engineering ones.

This is the whole list. Anything settled above — payment methods, the dispatch
model, who sets the price, maps, the design system — is not open and does not
belong here.

| #   | Question                                                                                                   | Blocks                                       |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| 1   | **Which SMS provider**, and is a sender ID registered with Azerbaijani operators?                          | 🔴 **EPIC 2 — real sign-in**                 |
| 2   | **Which object storage provider?** ([ADR-0005](../decisions/ADR-0005-object-storage.md))                   | Verification documents EPIC 5, photos EPIC 6 |
| 3   | Does TezUsta hold customer funds, or only facilitate, and which payment provider? (**needs legal advice**) | EPIC 12                                      |
| 4   | Commission rate, price guardrails, and the emergency-surcharge cap and hours                               | EPIC 12                                      |
| 5   | How is a master verified — documents, interview, certification? Who approves?                              | EPIC 5                                       |
| 6   | Cancellation rules and penalties for each side                                                             | EPIC 8                                       |
| 7   | Which hosting / cloud provider?                                                                            | EPIC 17                                      |
| 8   | **How is an account recovered when the phone number is lost?**                                             | 🔴 Needed before launch                      |
| 9   | Languages at launch — Azerbaijani, Russian, English?                                                       | Needed before launch                         |
| 10  | Owner art — app icon, splash, Google Maps style JSON, illustration, motion                                 | Polish; blocks no feature                    |
| 11  | Is in-app chat required at launch?                                                                         | Launch scope                                 |

**Question 1 is the highest priority.** With OTP as the only sign-in path, no
user can enter the app without an SMS provider.

**Question 8 is the principal weakness of phone-only sign-in.** If a user loses
their number — the operator reassigns it, the line is closed — their order
history, reviews, and master rating are attached to an account they can no longer
reach.

The visual design system is owned entirely by the project owner (CLAUDE.md §17).
It has now been supplied and is recorded in
[`../design/design-system.md`](../design/design-system.md)
([ADR-0011](../decisions/ADR-0011-design-system.md)). What remains outstanding
there is question 10's artwork — none of which blocks a feature.
