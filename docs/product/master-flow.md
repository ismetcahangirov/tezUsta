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
Review: service, problem, photos, distance band, price
   ↓
ACCEPT  (or decline / let it expire)
   ↓
The exact address is revealed; the price is now fixed at yours
   ↓
DEPART            → MASTER_ON_THE_WAY
   ↓
Mark ARRIVED      → MASTER_ARRIVED
   ↓
START WORK        → IN_PROGRESS
   ↓
COMPLETE          → COMPLETED
   ↓
Receive payment
   ↓
Review the customer, and receive the customer's review
```

## Stage detail

### Registration and verification

A master cannot accept work before being verified. Verification requirements are
**OPEN** and block EPIC 5 — see [`user-roles.md`](user-roles.md).

The app must make the current state obvious: what was submitted, what is still
needed, and what is being waited on. An opaque "pending" state with no
explanation is the fastest way to lose supply.

The verification screen renders the account state verbatim
([`user-roles.md`](user-roles.md)), and the four pre-active states need visibly
different screens:

| State                  | What the master is shown                                             |
| ---------------------- | -------------------------------------------------------------------- |
| `pending_verification` | Submitted, waiting on review. Nothing to do                          |
| `changes_requested`    | **What specifically is missing**, and a way to resubmit just that    |
| `rejected`             | The decision and its reason. Resubmission is not the path; appeal is |
| `active`               | Can set up services and go online                                    |

`changes_requested` and `rejected` are not the same screen with different copy.
One asks for an action the master can take; the other must not pretend there is
one.

The verification document upload depends on the object storage provider, which is
still open ([ADR-0005](../decisions/ADR-0005-object-storage.md)).

### Services and pricing

A master selects which catalogue services they offer.

**The master sets their own price** ([ADR-0010](../decisions/ADR-0010-pricing-and-commission.md)).
`master_services` therefore carries a price column. The catalogue price is a
reference; the master's figure is authoritative for an order.

The **emergency surcharge is the master's too** — it is a property of the
master's own service line, set within platform guardrails, not a figure the
platform or an admin applies on the master's behalf. An admin owns the catalogue
and the pricing _shape_ (fixed vs inspection); the amounts are the master's.

The price a master sets is **not** applied to an order at creation. It is copied
onto the order at the moment that master's accept wins, and a later edit never
moves a price already frozen on an order
([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)).

The platform takes a **commission** on each completed order, computed from the
frozen price.

**OPEN:** the commission rate, the surcharge cap and hours, and whether the
platform imposes minimum/maximum guardrails. Without a floor, a master can list
1 AZN and settle the rest in cash off-platform.

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

The offer card carries exactly five things: **service, problem description,
photos, distance band, and price** — the master's own price, or a statement that
the price follows inspection.

**Nor does it carry a customer id, an order id, or anything one master could
compare with another's card to work out that two jobs are the same customer.**
That includes the photo URLs: they are presigned reads of an opaque key
(`orders/photos/<uuid>`), not a path with a customer in it. A broadcast
reaches everyone in range, so an identifier that is stable across a customer's
orders would let a master recognise a repeat customer before deciding whether
to accept.

**It does not carry the customer's address.** A distance band ("2–3 km") is
enough to decide whether to take the job; the exact address is PII and is
revealed only to the master who accepts (CLAUDE.md §11). A broadcast goes to
every eligible master in range, so putting the address on the card would hand a
home address to everyone who never takes the job.

**The bands** (issue #101): under 1 km, 1–2, 2–3, 3–5, 5–10, and over 10 km.
One-kilometre steps up to 3 km — where ADR-0009 starts dispatching, and where a
kilometre still changes a master's answer — then coarser, because past 5 km the
question has stopped being "how far" and started being "at all". The top band
is open-ended rather than stopping at `DISPATCH_MAX_RADIUS_M`, so retuning that
ceiling cannot produce an offer no band can describe.

A band rather than a figure, because a figure is a trilateration primitive:
three masters who compare "1 847 m", "2 103 m" and "962 m" against their own
known positions locate a customer's front door to within a few metres, and none
of them ever took the job. The exact distance is recorded on `order_offers`
— the platform must know what it quoted — and never leaves the server.

**Dispatch is a parallel broadcast, and the first to accept wins**
([ADR-0009](../decisions/ADR-0009-dispatch-model.md)) — the Bolt model.

Every eligible master within the current radius sees the offer at the same time.
If nobody accepts, the radius widens and the offer goes out again; after a time
limit the order becomes `NO_MASTER_FOUND`, which is terminal and is not a
cancellation by anyone
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)).

**Declining and expiring are different answers.** A master who declines an offer
is never shown it again, in any later round. A master whose offer merely expired
may be offered it again when the radius widens — an expiry usually means a
notification was missed while driving, not a refusal.

**The accepted cost of this model is that every order produces losers.** A master
who reads an offer and loses the tap gets nothing. That makes two things
mandatory rather than optional:

- losing masters are told **immediately** over the realtime channel — a stale
  offer that fails on tap is a support ticket
- an unactioned offer **expires** rather than lingering in the list

This decision shapes the matching engine, the realtime event set, and the master
experience. It was the owner's to make and it is made — ADR-0009 is accepted, and
only its tuning parameters remain open.

Regardless of model: **exactly one master may win.** The accept operation is
guarded so a concurrent double-accept is impossible — see
[`../architecture/backend-architecture.md`](../architecture/backend-architecture.md).

An offer that is not acted on must **expire**, not linger.

### Accepting

Accept is a state transition, validated server-side against current state — not
against anything the client believes. Every one of these must hold at the instant
of the accept ([`user-roles.md`](user-roles.md)):

The eligibility predicate, re-evaluated at this instant:

1. The master is **verified**
2. The master is **online** — available in Postgres **and** a live heartbeat in
   Redis; a force-quit app is not online
3. The master **offers the service** the order is for
4. The master is **inside the current search radius**
5. The master's `commission_debt_minor` is at or below
   `MAX_COMMISSION_DEBT_MINOR`

And the concurrency guard, which is not an eligibility term but decides the
race:

6. The order is still `SEARCHING` and unassigned

The accept transaction writes `master_id` **and** `price_minor` together, from
this master's stored price ([ADR-0013](../decisions/ADR-0013-price-freeze-point.md)).
The customer's exact address is revealed at this point and not before.

**Condition 5 is the cash-order brake.** On a cash order the master collects the
**full amount** from the customer and the platform's commission is never deducted
at source — it becomes a **debt the master owes the platform**. Letting that debt
pass `MAX_COMMISSION_DEBT_MINOR` stops the master taking new work until it is
settled. Without it, the cheapest way to work for free is to take cash jobs and
never pay. The debt column reads zero until EPIC 12 populates it, so the
condition ships complete with dispatch in EPIC 7 rather than being retrofitted
into the accept guard later.

Losing masters must be told immediately that the order is gone — a stale offer
that fails on tap is a bad experience and a support ticket.

### Navigating

The app hands off to a maps application for turn-by-turn navigation. Building
in-app navigation is not justified.

Location reporting continues while travelling, which is what powers the
customer's tracking view.

### Depart → arrived → start → complete

**Four** explicit transitions, each master-initiated and each one an edge in the
order state machine
([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)):

| Action   | Transition                             |
| -------- | -------------------------------------- |
| Depart   | `ACCEPTED` → `MASTER_ON_THE_WAY`       |
| Arrive   | `MASTER_ON_THE_WAY` → `MASTER_ARRIVED` |
| Start    | `MASTER_ARRIVED` → `IN_PROGRESS`       |
| Complete | `IN_PROGRESS` → `COMPLETED`            |

Departure is a transition in its own right and not a side effect of accepting:
`MASTER_ON_THE_WAY` is what the customer's tracking screen shows, and nothing
else enters it.

**The master's completion is final** — the customer does not confirm it. The
customer's recourse is to open a dispute within the dispute window, which moves
the order to `DISPUTED`. A master is not left unpaid because a customer stopped
answering their phone.

If the master cancels after accepting, the order does **not** end — it returns to
`SEARCHING` and is offered to other masters, with this master excluded from the
next broadcast. Cancelling from `IN_PROGRESS` is different: work has started, no
one else can pick it up from an unknown state, and that cancellation is a quality
event and a likely dispute.

**OPEN:** should `MASTER_ARRIVED` be verified against the master's actual position
(geofence) rather than trusted? Trusting it is simpler; verifying it prevents a
class of fraud. This is a policy decision with a fraud/friction trade-off.

**OPEN:** for inspection-priced jobs, the master sets the price after inspecting.
Does the customer approve it before work starts? Without an approval step, the
customer has no protection against an inflated quote; with one, there is a stall
point mid-job. This needs a product answer.

### Payment

**Payment methods are settled: cash and card**
([ADR-0007](../decisions/ADR-0007-payments.md)). That is not open and is not to
be redesigned around.

On a **card** order the platform is in the money path and the commission is
deducted at source. On a **cash** order the master collects the full amount at
the door and owes the commission back to the platform as a debt, which is why
accepting work is gated on that debt (see **Accepting** above).

**OPEN:** the payment provider, and whether TezUsta may hold customer funds at
all — a legal question, not an engineering one. Both block EPIC 12.

### Review

Reviews run **both ways**: the master reviews the customer, and the customer
reviews the master, once the order has reached `COMPLETED` or `PAID`. Neither is
revealed until both have been submitted or the review window closes — a master
who could read the customer's review first would be rating the rating.

Reviewing has nothing to do with the payment questions above; a review is not
blocked by the payment provider.

Reviewing is optional and never gates the next job; the job screen asks, one
push reminds, and the window closes seven days after `COMPLETED`. The master
sees the customer's rating once they have accepted, never on the broadcast
offer card ([ADR-0042](../decisions/ADR-0042-review-policy.md)).

**Where the master is asked (issue #227).** The job read answers `null` the
instant a job completes, so the job screen cannot keep showing the order — and
"this order is no longer yours" would be the wrong thing to tell someone who
has just finished it. The app therefore remembers, in memory only, the last job
it saw this session (`src/master-jobs/last-job-slice.ts`, forgotten at
sign-out) and asks that order's reviews what happened:

- **On the job screen**, a job that reached `COMPLETED` (its reviews carry a
  window) shows a "job done" state with the review prompt and the way home. A
  job that was cancelled or handed back still says it is no longer theirs.
- **On home**, with no current job, the same prompt sits above the offer feed
  for as long as the server says that job may still be reviewed and has not
  been. Taking a new job replaces it; the one reminder push covers the rest.
- **After an app restart** nothing is remembered, and the reminder push — which
  carries its own order id and opens `(master)/review/[orderId]` — is the way
  back.

The review itself is one pushed screen, `(master)/review/[orderId]`, the same
component the customer sees at `(customer)/order/[id]/review`: five stars, an
optional comment counted to 500 characters, one button; editable while sealed,
read-only once revealed or removed, and showing the customer's review of the
master once it is revealed. Its copy is placeholder.

**Ratings on screen (issue #228).** The job screen shows the customer's rating
at the foot of the job card, in the same one-line form as the customer's view
of the master ("4,7 · 12 rəy", or "Hələ qiymət yoxdur" — never 0). The offer
card is unchanged and carries no rating. "Haqqımda rəylər" in settings lists
the revealed reviews customers wrote about the master, for the role on screen
only.

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

| Case                                  | Requirement                                                                                                                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App killed while online               | Presence expires automatically; the master does not appear available forever                                                                                                                                                                               |
| Loses network mid-order               | Status transitions queue and reconcile on reconnect; no lost completion                                                                                                                                                                                    |
| Background location permission denied | Explain the consequence; tracking degrades but the order is not broken                                                                                                                                                                                     |
| Two masters accept simultaneously     | Exactly one wins; the other is told immediately and cleanly                                                                                                                                                                                                |
| Master accepts and never arrives      | The customer can cancel; an admin can return the order to `SEARCHING` so it is offered again, with actor and reason recorded ([ADR-0015](../decisions/ADR-0015-order-lifecycle-states.md)). What this costs the master is the **OPEN** cancellation policy |
| Battery optimisation kills reporting  | Detect stale reporting and warn the master, rather than silently showing them as active                                                                                                                                                                    |
