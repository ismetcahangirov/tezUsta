# Customer flow

> Behaviour only. **No visual design is specified here** — screens, layout, and
> component design are owned by the project owner (CLAUDE.md §17).

## Journey

```
Sign in
   ↓
Select a service category
   ↓
Describe the problem
   ↓
Attach photos                    (optional)
   ↓
Set location / address
   ↓
See price or "price after inspection"
   ↓
Create order
   ↓
SEARCHING — platform looks for a master
   ↓
Master accepted  ──────────────→ (or: no master found)
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
Review the master
```

## Stage detail

### Sign in

**Phone number + SMS OTP** ([ADR-0008](../decisions/ADR-0008-otp-delivery.md)).
One step: enter the number, enter the code, signed in. There is no other sign-in
path.

The SMS provider is still open, and it blocks this entirely — nothing can be
signed into without it.

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

- Fixed-price service → the price is shown before confirmation.
- Inspection-based service → the app states clearly that the price is determined
  after inspection, **before** the order is created.

Prices come from the backend, always.

### Create order

The order enters `SEARCHING`. This is the commitment point.

### Searching

The customer sees that a search is in progress.

The order is broadcast to all eligible nearby masters at once, and the first to
accept wins ([ADR-0009](../decisions/ADR-0009-dispatch-model.md)). If nobody
accepts, the search radius widens and the broadcast repeats.

**OPEN:** what the customer is offered when no master is found within the time
limit — schedule for later, notify when someone becomes available, or simply
stop. The outcome itself must be explicit; an indefinite spinner is a bug.

### Tracking

Once accepted, the customer sees the master's identity, rating, and live
position while travelling.

Master location is visible **only** for an active order, and **only** to that
order's customer (CLAUDE.md §11).

### Work and completion

Status advances as the master reports arrival, start, and completion. The
customer is notified at each transition.

**OPEN:** does the customer confirm completion, or is the master's word final?
This matters for disputes.

### Payment

**Both cash and card are supported** ([ADR-0007](../decisions/ADR-0007-payments.md)).

The customer picks the method. On a cash order the money goes directly to the
master and never passes through the platform, so the commission becomes a debt
the master owes — invisible to the customer, but it shapes the backend.

**OPEN:** the payment provider, and whether TezUsta may hold customer funds at
all (a legal question, not an engineering one).

### Review

Rating plus optional comment, only after a completed order between these two
parties.

**OPEN:** is reviewing mandatory, skippable, or promptable later?

## Cancellation — OPEN

Cancellation must be possible, and the rules are a product decision that blocks
EPIC 8:

- Until which status may a customer cancel freely?
- Is there a fee after a master has set off?
- What happens if a master cancels after accepting?
- Does a cancellation affect either side's standing?

Engineering constraint regardless of policy: cancellation is a **state
transition**, validated by the order state machine, never a status field that
anything may overwrite.

## Failure cases to design for

Not exceptional — these are normal and must be handled:

| Case                             | Requirement                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------ |
| Location permission denied       | Manual address entry remains available                                         |
| No network at order creation     | Clear failure; **no silent duplicate order on retry** — creation is idempotent |
| Master cancels after accepting   | Order returns to searching or is cancelled; the customer is told immediately   |
| App backgrounded during tracking | State recovers correctly on resume; no stale position shown as live            |
| Photo upload fails               | The order can still be created without it                                      |
| No master found                  | Explicit outcome, never an indefinite spinner                                  |
