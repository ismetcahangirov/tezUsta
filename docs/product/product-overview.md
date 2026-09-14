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
   |                            location, price
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
from that master's own listing.

**Prices still always come from the backend.** "The master sets it" does not mean
the app submits an amount — the master sets it in their profile, the server
stores it, and the server applies it at order creation. A client-side price is a
client-controlled price.

An order **freezes** its price when created, and its commission rate when
completed. A later change to either must never rewrite a finished order.

**OPEN:** the surcharge amount, what hours count as "urgent", and whether the
platform imposes minimum/maximum price guardrails.

## Business model

- **Commission** on each completed order — the confirmed mechanism
- **Master subscription** — a possible later addition

**Both cash and card are supported** ([ADR-0007](../decisions/ADR-0007-payments.md)).
This is the hardest combination: on a cash order the money never passes through
the platform, so commission cannot be deducted at source and becomes a **debt**.
That requires a master balance and a threshold above which a master cannot accept
new work.

Neither is implemented yet, and the supporting entities (wallets, payouts,
commission rules, subscription plans) do not exist until their Epic is scheduled.

## Out of scope for now

Explicitly **not** being built yet — listed so nobody builds them speculatively:

- Scheduled / future-dated bookings (the product is _urgent_ work)
- Multi-master jobs
- Parts and materials inventory
- In-app chat (**OPEN** — likely needed, not yet specified)
- Master-to-master subcontracting
- Web app for customers
- Any market outside Azerbaijan

## Product decisions — settled

Decided by the project owner on 2026-09-14:

| Decision           | Outcome                                                | ADR                                                         |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| Sign-in method     | **Phone + SMS OTP only** — no social sign-in           | [ADR-0008](../decisions/ADR-0008-otp-delivery.md)           |
| Dispatch model     | **Parallel broadcast, first accept wins** (Bolt-style) | [ADR-0009](../decisions/ADR-0009-dispatch-model.md)         |
| Who sets the price | **The master**; platform takes a commission            | [ADR-0010](../decisions/ADR-0010-pricing-and-commission.md) |
| Payment methods    | **Both cash and card**                                 | [ADR-0007](../decisions/ADR-0007-payments.md)               |
| Maps / geocoding   | **Google Maps Platform**                               | [ADR-0004](../decisions/ADR-0004-location-and-maps.md)      |

## Open product questions

These block specific Epics. They are business decisions, not engineering ones.

| #   | Question                                                                          | Blocks                   |
| --- | --------------------------------------------------------------------------------- | ------------------------ |
| 1   | **Which SMS provider**, and is a sender ID registered with Azerbaijani operators? | 🔴 **EPIC 2 — blocking** |
| 2   | **How is an account recovered when the phone number is lost?**                    | 🔴 Needed before launch  |
| 3   | How is a master verified — documents, interview, certification? Who approves?     | EPIC 5                   |
| 4   | Cancellation rules and penalties for each side                                    | EPIC 8                   |
| 5   | Commission rate; added on top of the master's price, or deducted from it?         | EPIC 14                  |
| 6   | Minimum / maximum price guardrails, to stop commission avoidance                  | EPIC 14                  |
| 7   | Does TezUsta hold customer funds, or only facilitate? (**needs legal advice**)    | EPIC 12                  |
| 8   | Is in-app chat required at launch?                                                | Unscheduled              |
| 9   | Languages at launch — Azerbaijani, Russian, English?                              | EPIC 1                   |

**Question 1 is now the highest priority.** With OTP as the only sign-in path, no
user can enter the app without an SMS provider.

**Question 2 is the principal weakness of phone-only sign-in.** If a user loses
their number — the operator reassigns it, the line is closed — their order
history, reviews, and master rating are attached to an account they can no longer
reach.

The visual design system is owned entirely by the project owner (CLAUDE.md §17)
and is not listed here as a question — it is a standing input.
