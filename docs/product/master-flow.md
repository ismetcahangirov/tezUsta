# Master flow

> Behaviour only. **No visual design is specified here** (CLAUDE.md §17).

## Journey

```
Register
   ↓
Submit verification evidence
   ↓
Wait for approval          ← admin decision
   ↓
Set up services and pricing
   ↓
GO ONLINE
   ↓
Receive a nearby order offer
   ↓
Review: service, problem, photos, distance, price
   ↓
ACCEPT  (or decline / let it expire)
   ↓
Navigate to the customer
   ↓
Mark ARRIVED
   ↓
START WORK
   ↓
COMPLETE
   ↓
Receive payment
   ↓
Receive the customer's review
```

## Stage detail

### Registration and verification

A master cannot accept work before being verified. Verification requirements are
**OPEN** and block EPIC 5 — see [`user-roles.md`](user-roles.md).

The app must make the current state obvious: what was submitted, what is still
needed, and what is being waited on. An opaque "pending" state with no
explanation is the fastest way to lose supply.

### Services and pricing

A master selects which catalogue services they offer.

**OPEN:** may a master set their own price within a platform range, or is
pricing fixed by the platform? This determines whether `master_services` carries
a price at all.

### Going online

Being "online" means: available to receive offers, and reporting location.

This is an explicit, user-controlled toggle. It must be **unambiguous** — a
master who believes they are offline while the app still reports location will
lose trust in the product permanently.

Going online starts location reporting under the budget defined in
[`../architecture/realtime-architecture.md`](../architecture/realtime-architecture.md).
Going offline stops it. Presence is held in Redis and must expire on its own, so
a crashed app does not leave a phantom master online forever.

### Receiving an offer

The master sees service, problem description, photos, distance, and price (or
that price follows inspection).

**OPEN — blocks EPIC 7:** the dispatch model.

- _Broadcast:_ every nearby eligible master sees it; first to accept wins.
  Simple and fast, but generates losers on every order, which is demoralising at
  scale.
- _Sequential:_ offered to the best-matched master with a timeout, then the next.
  Fairer and quieter, but slower to fill and needs a timeout policy.

This decision shapes the matching engine, the realtime event set, and the master
experience. It should not be decided by engineering.

Regardless of model: **exactly one master may win.** The accept operation is
guarded so a concurrent double-accept is impossible — see
[`../architecture/backend-architecture.md`](../architecture/backend-architecture.md).

An offer that is not acted on must **expire**, not linger.

### Accepting

Accept is a state transition, validated server-side against current
verification, current availability, and current order status.

Losing masters must be told immediately that the order is gone — a stale offer
that fails on tap is a bad experience and a support ticket.

### Navigating

The app hands off to a maps application for turn-by-turn navigation. Building
in-app navigation is not justified.

Location reporting continues while travelling, which is what powers the
customer's tracking view.

### Arrived → start → complete

Three explicit transitions, each master-initiated.

**OPEN:** should `ARRIVED` be verified against the master's actual position
(geofence) rather than trusted? Trusting it is simpler; verifying it prevents a
class of fraud. This is a policy decision with a fraud/friction trade-off.

**OPEN:** for inspection-priced jobs, the master sets the price after inspecting.
Does the customer approve it before work starts? Without an approval step, the
customer has no protection against an inflated quote; with one, there is a stall
point mid-job. This needs a product answer.

### Payment and review

**OPEN** — see [ADR-0007](../decisions/ADR-0007-payments.md).

## What a master's standing depends on

Specified as inputs to matching (§40 of the project brief):

```
distance · availability · service category · rating
workload · response rate · completion rate · cancellation rate · possibly price
```

**Do not build this scoring model yet.** The first matching engine is
distance + availability + category + verification. Everything else is added once
there is real data to tune against — a weighted score invented before launch is
tuned against nothing.

**OPEN:** whether masters can see their own standing metrics. Visible metrics
change behaviour, sometimes badly.

## Failure cases to design for

| Case                                  | Requirement                                                                             |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| App killed while online               | Presence expires automatically; the master does not appear available forever            |
| Loses network mid-order               | Status transitions queue and reconcile on reconnect; no lost completion                 |
| Background location permission denied | Explain the consequence; tracking degrades but the order is not broken                  |
| Two masters accept simultaneously     | Exactly one wins; the other is told immediately and cleanly                             |
| Master accepts and never arrives      | Customer can cancel; escalation path required (**OPEN**)                                |
| Battery optimisation kills reporting  | Detect stale reporting and warn the master, rather than silently showing them as active |
