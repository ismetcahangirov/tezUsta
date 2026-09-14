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

**Prices always come from the backend.** The mobile app never computes or holds
a price list — a client-side price is a client-controlled price.

**OPEN:** the actual price points, the surcharge amount, what hours count as
"urgent", and who sets prices (platform, master, or negotiated).

## Business model

Two revenue mechanisms are specified for the long term:

- **Commission** on each completed order
- **Master subscription**

Neither is implemented, and the supporting entities (wallets, payouts,
commission rules, subscription plans) are deliberately absent until their Epic
is scheduled. See [`../decisions/ADR-0007-payments.md`](../decisions/ADR-0007-payments.md).

## Out of scope for now

Explicitly **not** being built yet — listed so nobody builds them speculatively:

- Scheduled / future-dated bookings (the product is _urgent_ work)
- Multi-master jobs
- Parts and materials inventory
- In-app chat (**OPEN** — likely needed, not yet specified)
- Master-to-master subcontracting
- Web app for customers
- Any market outside Azerbaijan

## Open product questions

These block specific Epics. They are business decisions, not engineering ones.

| #   | Question                                                                                      | Blocks      |
| --- | --------------------------------------------------------------------------------------------- | ----------- |
| 1   | Is phone-number sign-in the intended method?                                                  | EPIC 2      |
| 2   | How is a master verified — documents, interview, certification? Who approves?                 | EPIC 5      |
| 3   | Dispatch model: broadcast to all nearby masters (first to accept wins), or sequential offers? | EPIC 7      |
| 4   | Cancellation rules and penalties for each side                                                | EPIC 8      |
| 5   | Cash or card at launch?                                                                       | EPIC 12     |
| 6   | Who sets prices — platform, master, or negotiated?                                            | EPIC 3      |
| 7   | Is in-app chat required at launch?                                                            | Unscheduled |
| 8   | Languages at launch — Azerbaijani, Russian, English?                                          | EPIC 1      |

The visual design system is owned entirely by the project owner (CLAUDE.md §17)
and is not listed here as a question — it is a standing input.
