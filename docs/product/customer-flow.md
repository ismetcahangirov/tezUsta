# Customer flow

> Behaviour only. **No visual design is specified here** — screens, layout, and
> component design are owned by the project owner (CLAUDE.md §17).

## Journey

```
Sign in
   ↓
Say what to call you               (first run only)
   ↓
Select a service category
   ↓
Describe the problem
   ↓
Attach photos                    (optional)
   ↓
Set location / address
   ↓
See an indicative price range, or "price after inspection"
   ↓
Create order
   ↓
SEARCHING — platform looks for a master
   ↓
Master accepted  ──────────────→ (or: NO_MASTER_FOUND)
   ↓
Price is fixed — the accepting master's price
   ↓
Track master travelling
   ↓
Master arrived
   ↓
Work in progress
   ↓
Work completed
   ↓
Pay
   ↓
Review the master  ←──────────→  the master reviews you
```

## Stage detail

### Sign in

**Phone number + SMS OTP** ([ADR-0008](../decisions/ADR-0008-otp-delivery.md)).
One step: enter the number, enter the code, signed in. For a customer there is
no other sign-in path — the admin panel has its own, on a different application
([ADR-0014](../decisions/ADR-0014-admin-authentication.md)).

The SMS provider is still open, and it blocks this entirely — nothing can be
signed into without it.

### Say what to call you — first run only

A code proves a phone number and nothing else, so a brand-new account has no
name and no customer profile. On first entering the customer area the app asks
one question — _what should we call you?_ — and that answer creates the profile
every customer surface is addressed against
([ADR-0028](../decisions/ADR-0028-customer-profile-at-first-run.md), issue #94).

**It is asked once.** A returning customer never sees it, on any device: the app
reads the profile from the server rather than remembering locally that it asked.
A failed check — no signal, a server error — says "try again" and does **not**
ask again, because "we could not reach the server" is not the same fact as "you
have no profile".

The name is not bureaucracy: it is what the master who accepts the job and
travels to the address is shown. That is also why the alternatives — an optional
name, or a placeholder the server invents — were rejected; ADR-0028 records why.

**The wider first run is still the owner's** — a welcome, artwork, a tour, a
role chooser. This is the single question the API cannot proceed without, and
nothing else has been decided.

### Select a service

The catalogue comes from the backend. The app renders whatever it returns and
**never hardcodes categories** — admins add and remove services without an app
release.

### Describe the problem

Free text. Must be length-limited and validated server-side; it is displayed to
masters, so it is untrusted user input (CLAUDE.md §11).

**OPEN:** whether guided questions per category ("is water still running?")
replace or supplement free text. That is a product decision.

### Attach photos

Optional, uploaded directly to object storage via a presigned URL — the API
never proxies image bytes ([ADR-0005](../decisions/ADR-0005-object-storage.md)).

The storage **provider** is still open and blocks this step, exactly as the SMS
provider blocks sign-in.

**OPEN:** maximum photo count.

### Set location

Three sources, in order of preference:

1. A saved address
2. Current GPS position, reverse-geocoded
3. Manual entry, forward-geocoded

Location permission must be requested **with an explanation of why**, at the
moment it is needed — not on first launch. A permission denial must leave the
flow usable via manual entry, not dead-ended.

The address needs an apartment/entrance/floor detail field. In Baku a building
coordinate alone is frequently not enough to find a door.

### Price

- Fixed-price service → the customer sees an **indicative range** before
  confirming: the lowest and highest price among the masters who are eligible to
  receive this order. It is labelled as an estimate, in those words.
- Inspection-based service → the app states clearly that the price is determined
  after inspection, **before** the order is created.

**No firm price is shown before the order is created**
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)). The order goes out to
every eligible master at once and their prices differ, so a single number shown
at this point would be a number the platform cannot honour. The range is
intended to be computed from the same eligibility predicate the broadcast uses,
so that it can never contain a master who would not have been offered the
order — **not yet true today.** `GET /services/:id/price-range` (issue #84)
approximates eligibility with a master's verification status and offer
activity, not yet geography or presence, so until EPIC 7 ties the two
predicates together the range can include a master who would not, in fact,
have been offered this particular order.

Prices come from the backend, always, and the client never submits an amount.

### Create order

The order enters `SEARCHING`, with no price and no master on it yet. This is the
commitment point.

Creation writes a `DRAFT` row with the client's idempotency key and moves it to
`SEARCHING` in the same transaction
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)). `DRAFT` is an
internal anchor that makes a retry return the existing order instead of creating
a second one; **the customer never sees it**.

### Searching

The customer sees that a search is in progress.

The order is broadcast to all eligible nearby masters at once, and the first to
accept wins ([ADR-0009](../decisions/ADR-0009-dispatch-model.md)). If nobody
accepts, the search radius widens and the broadcast repeats. A master who
**declined** the order is never offered it again; a master who simply let the
offer **expire** may see it again when the radius widens. A decline is an answer,
an expiry is a missed notification, and treating them alike would either spam the
master who said no or lose the master who was driving.

When the accept lands, the order moves to `ACCEPTED` and the accepting master's
price is written onto it. That is the first firm number the customer sees.

When the time limit passes with nobody accepting, the order becomes
`NO_MASTER_FOUND` — **a terminal status of its own, not a cancellation**
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)). The outcome must
be explicit; an indefinite spinner is a bug. The customer is then offered either
to be notified when a master becomes available, or to stop. **Not** to schedule
the job for later: scheduled bookings are out of scope
([`product-overview.md`](product-overview.md)) and a "no master found" screen is
not the place to introduce them.

### Tracking

Once accepted, the customer sees the master's identity, rating, and live
position while travelling.

Master location is visible **only** for an active order, and **only** to that
order's customer (CLAUDE.md §11).

### Work and completion

Status advances as the master reports departure, arrival, start, and completion —
`ACCEPTED` → `MASTER_ON_THE_WAY` → `MASTER_ARRIVED` → `IN_PROGRESS` →
`COMPLETED`. The customer is notified at each transition.

**The master marks the work complete; the customer does not confirm it**
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)). The customer's
recourse is to **open a dispute within the dispute window**, which moves the
order to `DISPUTED` and puts an admin on it. Requiring a confirmation tap would
leave a master unpaid for finished work because a customer put their phone down,
and would hand the customer a lever over payment that the dispute process already
provides more fairly.

If the assigned master cancels instead of finishing, the order returns to
`SEARCHING` and is offered again — see the failure table below.

### Payment

**Both cash and card are supported** ([ADR-0007](../decisions/ADR-0007-payments.md)).

The customer picks the method. On a cash order the money goes directly to the
master and never passes through the platform, so the commission becomes a debt
the master owes — invisible to the customer, but it shapes the backend.

**OPEN:** the payment provider, and whether TezUsta may hold customer funds at
all (a legal question, not an engineering one).

### Review

Rating plus optional comment, only after a completed order between these two
parties — the order must have reached `COMPLETED` or `PAID`.

**Reviews go both ways.** The customer reviews the master and the master reviews
the customer ([`user-roles.md`](user-roles.md)). Neither review is shown to
anyone until both have been submitted or the review window closes, so neither
side can write in reply to the other. A review that can answer a review is a
negotiation, not a rating.

Reviewing is **skippable and promptable later**, never mandatory: a card on
the order screen asks, one push reminds 24 hours after completion, and the
window closes seven days after `COMPLETED`. A review is counted into the
master's rating only when it is revealed
([ADR-0042](../decisions/ADR-0042-review-policy.md)).

**On screen (issue #227).** The prompt is a card directly under the status
card, shown while `GET /orders/:id/reviews` says `canReview` and the customer
has not written one; the order's reviews are not even requested before it
reaches `COMPLETED`. It opens `(customer)/order/[id]/review`, pushed over the
order like the conversation: five star buttons, an optional multi-line comment
with a live count to 500, one button. While sealed, the same screen edits the
review; once revealed or removed it is read-only and says why, and the
master's review of the customer appears there once it is revealed. Each of the
four refusals the API can give (`ORDER_NOT_REVIEWABLE`, `REVIEW_WINDOW_CLOSED`,
`REVIEW_ALREADY_SUBMITTED`, `REVIEW_ALREADY_REVEALED`) has its own sentence,
and the screen re-reads the reviews after any refusal. Copy is placeholder.

## Cancellation — the transition exists, the policy is OPEN

A customer can cancel their own order from every status the transition table
permits, and the cancellation is recorded with who did it and why. **What it
costs is still open**, and that is the part below: the endpoint charges nobody
anything and computes no fee.

The rules are a product decision:

- Until which status may a customer cancel freely?
- Is there a fee after a master has set off?
- Does a cancellation affect either side's standing?

What happens when a **master** cancels after accepting is no longer open: the
order returns to `SEARCHING` and is re-dispatched
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)). Only the cost of
that — to whom, and how much — is still a policy question.

Engineering constraint regardless of policy: cancellation is a **state
transition**, validated by the order state machine, never a status field that
anything may overwrite. `NO_MASTER_FOUND` is not one of these transitions and is
never counted in a cancellation rate. Cancelling also closes the order's live
offers in the same transaction, so a cancelled order never keeps showing as a
live job on a master's feed.

## Failure cases to design for

Not exceptional — these are normal and must be handled:

| Case                             | Requirement                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location permission denied       | Manual address entry remains available                                                                                                                                                                                                                                                                                 |
| No network at order creation     | Clear failure; **no silent duplicate order on retry** — creation is idempotent                                                                                                                                                                                                                                         |
| Master cancels after accepting   | Order returns to `SEARCHING` and is re-dispatched; the customer is told immediately, **including that the price may change** — the next master's price is frozen instead ([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)). Capped by `MAX_ORDER_REDISPATCHES`; at the cap the order becomes `NO_MASTER_FOUND` |
| App backgrounded during tracking | State recovers correctly on resume; no stale position shown as live                                                                                                                                                                                                                                                    |
| Photo upload fails               | The order can still be created without it                                                                                                                                                                                                                                                                              |
| No master found                  | Terminal `NO_MASTER_FOUND`, never a cancellation and never counted as one; an explicit outcome, never an indefinite spinner                                                                                                                                                                                            |
